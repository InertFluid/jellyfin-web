/**
 * Gapless FLAC playback engine.
 *
 * Owns a MediaSource attached to the plugin's <audio> element with a single
 * SourceBuffer ('audio/mp4; codecs="flac"'). Each direct-play FLAC stream is
 * fetched, remuxed to fragmented MP4 with mediabunny (packet copy, no
 * re-encode) and appended onto a continuous timeline, so consecutive tracks
 * play back sample-accurately with no seam.
 *
 * Self-contained: imports only from 'mediabunny' so it stays unit-testable
 * outside the player plugin.
 */

import {
    ALL_FORMATS,
    BufferSource,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    Input,
    Mp4OutputFormat,
    Output
} from 'mediabunny';

const MIME_TYPE = 'audio/mp4; codecs="flac"';

/** Seconds of already-played audio kept behind the playhead before trimming. */
const TRIM_BEHIND_SECONDS = 30;

/** Muxed timescales round (~1µs short); never compare times exactly. */
const TIME_EPSILON = 0.001;

/**
 * Error used internally to mark async continuations that were superseded by
 * a newer reset()/start()/invalidateNext() generation. Always swallowed.
 */
class SupersededError extends Error {
    constructor() {
        super('gapless engine operation superseded');
        this.name = 'GaplessSupersededError';
    }
}

/**
 * Remux raw FLAC bytes into a complete self-initializing fragmented MP4
 * buffer (ftyp+moov init segment followed by moof/mdat fragments) via
 * packet copy. No re-encode.
 *
 * @param {ArrayBuffer} arrayBuffer - Raw FLAC file bytes.
 * @returns {Promise<{buffer: ArrayBuffer, duration: number, codec: string, sampleRate: number, numberOfChannels: number, patchedSampleSize: (number|null)}>}
 */
async function remuxFlacToFmp4(arrayBuffer) {
    const input = new Input({
        source: new BufferSource(arrayBuffer),
        formats: ALL_FORMATS
    });
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
        throw new Error('no audio track found');
    }
    const decoderConfig = await track.getDecoderConfig(); // carries FLAC STREAMINFO in `description`
    const duration = await track.computeDuration(); // precise: total samples / sample rate

    const output = new Output({
        format: new Mp4OutputFormat({
            fastStart: 'fragmented', // fMP4: ftyp+moov init, then moof+mdat fragments
            minimumFragmentDuration: 1 // seconds per fragment
        }),
        target: new BufferTarget()
    });
    const source = new EncodedAudioPacketSource(track.codec); // 'flac'
    output.addAudioTrack(source);
    await output.start();

    const sink = new EncodedPacketSink(track);
    let first = true;
    for await (const packet of sink.packets()) {
        await source.add(packet, first ? { decoderConfig } : undefined);
        first = false;
    }
    await output.finalize();

    const buffer = output.target.buffer;
    // WORKAROUND (mediabunny 1.55.5): the fLaC AudioSampleEntry always writes
    // samplesize=16, but Chromium rejects the init segment when STREAMINFO
    // bits-per-sample differs (e.g. 24-bit):
    // "FLAC AudioSampleEntry sample size mismatches FLACSpecificBox STREAMINFO sample size".
    // Patch the samplesize field in the sample entry to match STREAMINFO.
    let patchedSampleSize = null;
    if (decoderConfig && decoderConfig.description) {
        const desc = new Uint8Array(decoderConfig.description.buffer ?
            decoderConfig.description.buffer.slice(decoderConfig.description.byteOffset, decoderConfig.description.byteOffset + decoderConfig.description.byteLength) :
            decoderConfig.description);
        // desc = 'fLaC' + 4-byte metadata block header + 34-byte STREAMINFO
        const si = 8; // start of STREAMINFO within desc
        const bps = (((desc[si + 12] & 0x01) << 4) | (desc[si + 13] >> 4)) + 1;
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);
        // find 'fLaC' box fourcc in the init segment (moov comes first in a fragmented file)
        for (let i = 0; i < Math.min(bytes.length, 4096) - 4; i++) {
            if (bytes[i] === 0x66 && bytes[i + 1] === 0x4c && bytes[i + 2] === 0x61 && bytes[i + 3] === 0x43) {
                // AudioSampleEntry body starts at i+4: reserved(6) dri(2) version(2) revision(2)
                // vendor(4) channelcount(2) samplesize(2) -> samplesize at i+4+18
                const off = i + 4 + 18;
                if (view.getUint16(off) === 16 && bps !== 16) {
                    view.setUint16(off, bps);
                    patchedSampleSize = bps;
                }
                break;
            }
        }
    }

    return {
        buffer, // ArrayBuffer of the complete fMP4 (init segment + all fragments)
        patchedSampleSize,
        duration,
        codec: track.codec,
        sampleRate: track.sampleRate,
        numberOfChannels: track.numberOfChannels
    };
}

/**
 * Gapless playback engine bound to a single media element.
 */
class GaplessEngine {
    /**
     * @param {HTMLMediaElement} mediaElement - The plugin's existing element.
     */
    constructor(mediaElement) {
        this._element = mediaElement;
        this._mediaSource = null;
        this._sourceBuffer = null;
        this._objectUrl = null;

        /** Timeline entries: { index, url, itemInfo, startTime, duration }. */
        this._entries = [];
        this._currentIndex = -1;

        // Generation guards every async continuation against reset()/start()
        // races; epoch additionally guards appendNext against invalidateNext().
        this._generation = 0;
        this._nextEpoch = 0;

        this._pendingAppends = 0;
        this._queueEnded = false;
        this._endOfStreamCalled = false;

        // SourceBuffer operations (append/remove/endOfStream) are serialized
        // through this promise chain: exactly one in flight at a time.
        this._operationChain = Promise.resolve();
        this._operationRunning = false;

        this._fetchControllers = new Set();
        this._nextFetchControllers = new Set();
        this._boundListeners = null;
        this._nextAppendInFlight = false;

        // Rejects a pending _openMediaSource() wait; a MediaSource detached
        // before it ever attaches fires neither sourceopen nor sourceclose,
        // so reset() must settle the wait itself.
        this._openReject = null;

        /**
         * Fired from the internal timeupdate listener when the playhead
         * crosses a timeline entry boundary (once per forward crossing).
         * @type {?function(number, Object, ?Object)}
         */
        this.onTrackBoundary = null;

        /** Fired after endOfStream() when the element ends. @type {?function()} */
        this.onEnginePlaybackEnd = null;

        /** Fired on any fatal engine error; the plugin decides fallback. @type {?function(*)} */
        this.onEngineError = null;
    }

    /**
     * @returns {boolean} True when MSE FLAC-in-MP4 playback is available.
     */
    static isSupported() {
        /* eslint-disable compat/compat -- feature-detected right here */
        return !!(window.MediaSource
            && typeof MediaSource.isTypeSupported === 'function'
            && MediaSource.isTypeSupported(MIME_TYPE));
        /* eslint-enable compat/compat */
    }

    /**
     * Whether a stream is engine-eligible: direct-play/direct-stream FLAC.
     * The mediaSource object (container/codec) is authoritative; the url is
     * only used as a fallback extension check.
     *
     * @param {string} url - Pre-authenticated stream URL.
     * @param {Object} [mediaSource] - Server MediaSourceInfo for the stream.
     * @returns {boolean}
     */
    static isEligibleUrl(url, mediaSource) {
        if (mediaSource && typeof mediaSource === 'object') {
            const streams = mediaSource.MediaStreams || [];
            const audioStream = streams.find((s) => s && s.Type === 'Audio');
            const codec = audioStream && audioStream.Codec ? String(audioStream.Codec).toLowerCase() : '';
            if (codec) {
                return codec === 'flac';
            }
            const container = String(mediaSource.Container || '').toLowerCase();
            if (container) {
                return container.split(',').includes('flac');
            }
        }
        if (typeof url === 'string') {
            return url.split('?')[0].toLowerCase().endsWith('.flac');
        }
        return false;
    }

    /**
     * Reset the engine and begin a new timeline with this track at time 0.
     *
     * @param {string} url - Pre-authenticated direct-play stream URL.
     * @param {Object} itemInfo - { playlistItemId, item, streamInfo } (opaque).
     * @returns {Promise<boolean>} True when the timeline started; false when
     *     superseded by a newer start()/reset() (the caller must then leave
     *     the element alone — the newer session owns it).
     */
    async start(url, itemInfo) {
        this.reset();
        const generation = this._generation;
        try {
            await this._openMediaSource(generation);
            const remuxed = await this._fetchAndRemux(url, generation, false);
            await this._enqueueOperation(generation, async () => {
                this._sourceBuffer.timestampOffset = 0;
                await this._appendToSourceBuffer(remuxed.buffer);
                this._entries.push({
                    index: 0,
                    url,
                    itemInfo,
                    startTime: 0,
                    duration: remuxed.duration
                });
                this._currentIndex = 0;
            });
            console.debug(`[gaplessEngine] timeline started: codec=${remuxed.codec} rate=${remuxed.sampleRate} channels=${remuxed.numberOfChannels} duration=${remuxed.duration.toFixed(3)}s`);
            return true;
        } catch (e) {
            if (e instanceof SupersededError) {
                return false;
            }
            console.debug('[gaplessEngine] start failed:', e && e.message ? e.message : e);
            throw e;
        }
    }

    /**
     * Fetch + remux + append a track as the next timeline entry. Resolves as
     * a silent no-op if superseded by reset()/start()/invalidateNext().
     *
     * @param {string} url - Pre-authenticated direct-play stream URL.
     * @param {Object} itemInfo - { playlistItemId, item, streamInfo } (opaque).
     * @returns {Promise<void>}
     */
    async appendNext(url, itemInfo) {
        if (!this._mediaSource || this._queueEnded) {
            return;
        }
        // Single-future-slot invariant: at most one timeline entry beyond the
        // current track, and at most one append in flight. Deduplicates
        // double-resolution races (two 'gaplessqueuenext' answers for the
        // same boundary) and keeps the buffered window modest for TV memory.
        // RepeatOne still works: the boundary crossing advances _currentIndex
        // before the next append request arrives, freeing the slot.
        const effectiveIndex = Math.max(this._currentIndex, 0);
        if (this._nextAppendInFlight || this._entries.length > effectiveIndex + 1) {
            return;
        }
        this._nextAppendInFlight = true;
        const generation = this._generation;
        const epoch = this._nextEpoch;
        this._pendingAppends++;
        try {
            const remuxed = await this._fetchAndRemux(url, generation, true);
            this._checkEpoch(generation, epoch);
            await this._enqueueOperation(generation, async () => {
                this._checkEpoch(generation, epoch);
                if (!this._sourceBuffer) {
                    throw new Error('gapless engine has no source buffer');
                }
                // The authoritative offset for track N+1 is the buffered end
                // after track N has fully appended (muxed timescale rounds).
                const buffered = this._sourceBuffer.buffered;
                const offset = buffered.length ? buffered.end(buffered.length - 1) : 0;
                this._sourceBuffer.timestampOffset = offset;
                await this._appendToSourceBuffer(remuxed.buffer);
                this._entries.push({
                    index: this._entries.length,
                    url,
                    itemInfo,
                    startTime: offset,
                    duration: remuxed.duration
                });
            });
        } catch (e) {
            if (e instanceof SupersededError) {
                return;
            }
            console.debug('[gaplessEngine] appendNext failed:', e && e.message ? e.message : e);
            throw e;
        } finally {
            // Only clear the slot when this call still owns it; a superseding
            // reset()/invalidateNext() already cleared it for the next caller.
            if (generation === this._generation && epoch === this._nextEpoch) {
                this._nextAppendInFlight = false;
            }
            if (generation === this._generation) {
                this._pendingAppends--;
                this._maybeEndOfStream();
            }
        }
    }

    /**
     * Drop any not-yet-reached future timeline entries and remove their
     * buffered range. In-flight appendNext() calls are superseded. Safe to
     * call at any time.
     */
    invalidateNext() {
        this._nextEpoch++;
        for (const controller of this._nextFetchControllers) {
            controller.abort();
        }
        this._nextFetchControllers.clear();
        this._nextAppendInFlight = false;
        this._queueEnded = false;
        this._endOfStreamCalled = false;

        if (this._currentIndex < 0 || this._entries.length <= this._currentIndex + 1) {
            return;
        }
        const firstFuture = this._entries[this._currentIndex + 1];
        this._entries.length = this._currentIndex + 1;
        const generation = this._generation;
        this._enqueueOperation(generation, async () => {
            const sourceBuffer = this._sourceBuffer;
            if (!sourceBuffer || !this._mediaSource || this._mediaSource.readyState !== 'open') {
                return;
            }
            const buffered = sourceBuffer.buffered;
            if (buffered.length && buffered.end(buffered.length - 1) > firstFuture.startTime + TIME_EPSILON) {
                await this._removeFromSourceBuffer(firstFuture.startTime, Number.POSITIVE_INFINITY);
            }
        }).catch(() => { /* superseded or nothing to remove */ });
    }

    /**
     * Declare the timeline complete: nothing will be appended after the
     * entries already appended or in flight. Once the final entry's data is
     * fully appended, endOfStream() is called so 'ended' fires naturally at
     * the true end of the queue.
     */
    markQueueEnd() {
        this._queueEnded = true;
        this._maybeEndOfStream();
    }

    /**
     * @returns {?{index: number, itemInfo: Object, position: number, duration: number}}
     *     The current logical track, translated from element.currentTime.
     */
    current() {
        if (!this._entries.length) {
            return null;
        }
        let index = this._indexForTime(this._element.currentTime);
        if (index < 0) {
            index = this._currentIndex >= 0 ? this._currentIndex : 0;
        }
        const entry = this._entries[index];
        return {
            index: entry.index,
            itemInfo: entry.itemInfo,
            position: Math.max(0, this._element.currentTime - entry.startTime),
            duration: entry.duration
        };
    }

    /**
     * @returns {Array<Object>} Readonly copy of the timeline entries.
     */
    entries() {
        return this._entries.slice();
    }

    /**
     * Seek within the current logical track. Positions outside the buffered
     * range (e.g. trimmed behind the playhead) trigger an internal rebuild.
     *
     * @param {number} seconds - In-track position.
     * @returns {Promise<void>}
     */
    async seek(seconds) {
        const index = this._currentIndex >= 0 ? this._currentIndex : 0;
        const entry = this._entries[index];
        if (!entry) {
            console.debug('[gaplessEngine] seek ignored: no timeline');
            return;
        }
        const position = Math.min(Math.max(seconds, 0), entry.duration);
        const target = entry.startTime + position;
        if (this._isBuffered(target)) {
            this._element.currentTime = target;
            return;
        }
        // Outside the buffered window (trimmed): rebuild from this track.
        const wasPaused = this._element.paused;
        const started = await this.start(entry.url, entry.itemInfo);
        if (!started) {
            // Superseded by a newer session; it owns the element now.
            return;
        }
        this._element.currentTime = position;
        if (!wasPaused) {
            try {
                await this._element.play();
            } catch (e) {
                console.debug('[gaplessEngine] play after seek rebuild failed:', e && e.message ? e.message : e);
            }
        }
    }

    /**
     * Full teardown: abort in-flight fetches, detach the MediaSource, revoke
     * object URLs and remove listeners. The element is left clean for stock
     * (non-engine) use.
     */
    reset() {
        this._generation++;
        this._nextEpoch++;

        if (this._openReject) {
            this._openReject(new SupersededError());
            this._openReject = null;
        }

        for (const controller of this._fetchControllers) {
            controller.abort();
        }
        this._fetchControllers.clear();
        this._nextFetchControllers.clear();

        this._detachElementListeners();

        this._mediaSource = null;
        this._sourceBuffer = null;
        if (this._objectUrl) {
            if (this._element.src === this._objectUrl) {
                this._element.removeAttribute('src');
                this._element.load();
            }
            URL.revokeObjectURL(this._objectUrl);
            this._objectUrl = null;
        }

        this._entries = [];
        this._currentIndex = -1;
        this._pendingAppends = 0;
        this._nextAppendInFlight = false;
        this._queueEnded = false;
        this._endOfStreamCalled = false;
        this._operationChain = Promise.resolve();
        this._operationRunning = false;
    }

    /**
     * Create a MediaSource, attach it to the element and open a SourceBuffer.
     * @param {number} generation
     * @private
     */
    async _openMediaSource(generation) {
        const mediaSource = new MediaSource(); /* eslint-disable-line compat/compat -- gated by isSupported() */
        this._mediaSource = mediaSource;
        this._objectUrl = URL.createObjectURL(mediaSource); /* eslint-disable-line compat/compat -- gated by isSupported() */
        this._attachElementListeners();
        this._element.src = this._objectUrl;
        let rejectRef = null;
        await new Promise((resolve, reject) => {
            rejectRef = reject;
            this._openReject = reject;
            mediaSource.addEventListener('sourceopen', resolve, { once: true });
            mediaSource.addEventListener('sourceclose', () => reject(new SupersededError()), { once: true });
        }).finally(() => {
            if (this._openReject === rejectRef) {
                this._openReject = null;
            }
        });
        this._checkGeneration(generation);
        this._sourceBuffer = mediaSource.addSourceBuffer(MIME_TYPE);
    }

    /**
     * Fetch a stream URL (pre-authenticated; plain fetch suffices) and remux
     * it to fMP4. Abortable via reset() (and invalidateNext() when isNext).
     *
     * @param {string} url
     * @param {number} generation
     * @param {boolean} isNext
     * @returns {Promise<Object>} Remux result.
     * @private
     */
    async _fetchAndRemux(url, generation, isNext) {
        const controller = new AbortController(); /* eslint-disable-line compat/compat -- gated by isSupported() */
        this._fetchControllers.add(controller);
        if (isNext) {
            this._nextFetchControllers.add(controller);
        }
        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) {
                throw new Error(`stream fetch failed (${response.status})`);
            }
            const arrayBuffer = await response.arrayBuffer();
            this._checkGeneration(generation);
            const remuxed = await remuxFlacToFmp4(arrayBuffer);
            this._checkGeneration(generation);
            return remuxed;
        } catch (e) {
            if (controller.signal.aborted) {
                throw new SupersededError();
            }
            throw e;
        } finally {
            this._fetchControllers.delete(controller);
            this._nextFetchControllers.delete(controller);
        }
    }

    /**
     * Serialize a SourceBuffer operation: exactly one append/remove in
     * flight, each awaited to 'updateend' before the next runs.
     *
     * @param {number} generation
     * @param {function(): Promise<*>} operation
     * @returns {Promise<*>}
     * @private
     */
    _enqueueOperation(generation, operation) {
        const task = this._operationChain.then(async () => {
            this._checkGeneration(generation);
            this._operationRunning = true;
            try {
                return await operation();
            } finally {
                this._operationRunning = false;
            }
        });
        this._operationChain = task.then(() => undefined, () => undefined);
        return task;
    }

    /**
     * @param {ArrayBuffer} buffer
     * @returns {Promise<void>}
     * @private
     */
    _appendToSourceBuffer(buffer) {
        return this._awaitSourceBufferUpdate((sourceBuffer) => sourceBuffer.appendBuffer(buffer), 'append');
    }

    /**
     * @param {number} start
     * @param {number} end
     * @returns {Promise<void>}
     * @private
     */
    _removeFromSourceBuffer(start, end) {
        return this._awaitSourceBufferUpdate((sourceBuffer) => sourceBuffer.remove(start, end), 'remove');
    }

    /**
     * Run one SourceBuffer mutation and resolve on its 'updateend'.
     * @param {function(SourceBuffer)} mutate
     * @param {string} label
     * @returns {Promise<void>}
     * @private
     */
    _awaitSourceBufferUpdate(mutate, label) {
        const sourceBuffer = this._sourceBuffer;
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                sourceBuffer.removeEventListener('updateend', onEnd);
                sourceBuffer.removeEventListener('error', onError);
            };
            const onEnd = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error(`SourceBuffer ${label} error`));
            };
            sourceBuffer.addEventListener('updateend', onEnd);
            sourceBuffer.addEventListener('error', onError);
            try {
                mutate(sourceBuffer);
            } catch (e) {
                cleanup();
                reject(e);
            }
        });
    }

    /**
     * Call endOfStream() once the queue is marked ended and every pending
     * append has fully landed in the SourceBuffer.
     * @private
     */
    _maybeEndOfStream() {
        if (!this._queueEnded || this._pendingAppends > 0 || this._endOfStreamCalled) {
            return;
        }
        const generation = this._generation;
        this._enqueueOperation(generation, () => {
            if (!this._queueEnded || this._pendingAppends > 0 || this._endOfStreamCalled) {
                return;
            }
            if (this._mediaSource && this._mediaSource.readyState === 'open') {
                this._mediaSource.endOfStream();
                this._endOfStreamCalled = true;
            }
        }).catch(() => { /* superseded */ });
    }

    /**
     * Binary search the timeline for the entry containing a media time.
     * @param {number} time
     * @returns {number} Entry index, or -1 when before the first entry.
     * @private
     */
    _indexForTime(time) {
        let low = 0;
        let high = this._entries.length - 1;
        let result = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (this._entries[mid].startTime <= time + TIME_EPSILON) {
                result = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return result;
    }

    /**
     * @param {number} time
     * @returns {boolean} Whether the element timeline position is buffered.
     * @private
     */
    _isBuffered(time) {
        const sourceBuffer = this._sourceBuffer;
        if (!sourceBuffer) {
            return false;
        }
        let buffered;
        try {
            buffered = sourceBuffer.buffered;
        } catch {
            return false;
        }
        for (let i = 0; i < buffered.length; i++) {
            if (time >= buffered.start(i) - TIME_EPSILON && time <= buffered.end(i) - TIME_EPSILON) {
                return true;
            }
        }
        return false;
    }

    /** @private */
    _attachElementListeners() {
        if (this._boundListeners) {
            return;
        }
        this._boundListeners = {
            timeupdate: () => this._onTimeUpdate(),
            ended: () => this._onEnded(),
            error: () => this._onElementError()
        };
        for (const [type, listener] of Object.entries(this._boundListeners)) {
            this._element.addEventListener(type, listener);
        }
    }

    /** @private */
    _detachElementListeners() {
        if (!this._boundListeners) {
            return;
        }
        for (const [type, listener] of Object.entries(this._boundListeners)) {
            this._element.removeEventListener(type, listener);
        }
        this._boundListeners = null;
    }

    /**
     * Track boundary detection + opportunistic buffer trimming.
     * @private
     */
    _onTimeUpdate() {
        const time = this._element.currentTime;
        const index = this._indexForTime(time);
        if (index >= 0 && index !== this._currentIndex) {
            const previousEntry = this._currentIndex >= 0 ? this._entries[this._currentIndex] : null;
            const crossedForward = index > this._currentIndex;
            this._currentIndex = index;
            // Fire once per forward crossing only; backwards moves (seeks)
            // update the index silently so they never double-fire.
            if (crossedForward && typeof this.onTrackBoundary === 'function') {
                const entry = this._entries[index];
                this.onTrackBoundary(index, entry.itemInfo, previousEntry ? previousEntry.itemInfo : null);
            }
        }
        this._trimBehindPlayhead(time);
    }

    /**
     * Opportunistically remove played data more than TRIM_BEHIND_SECONDS
     * behind the playhead, keeping the buffered window modest (TV memory).
     * Skipped whenever an operation is already running or queued work exists.
     * @param {number} time
     * @private
     */
    _trimBehindPlayhead(time) {
        const sourceBuffer = this._sourceBuffer;
        const trimEnd = time - TRIM_BEHIND_SECONDS;
        if (!sourceBuffer || sourceBuffer.updating || this._operationRunning || trimEnd <= 0) {
            return;
        }
        if (!this._mediaSource || this._mediaSource.readyState !== 'open') {
            return;
        }
        let buffered;
        try {
            buffered = sourceBuffer.buffered;
        } catch {
            return;
        }
        // Only bother when at least a second of trimmable data has built up.
        if (!buffered.length || buffered.start(0) >= trimEnd - 1) {
            return;
        }
        const generation = this._generation;
        this._enqueueOperation(generation, async () => {
            if (!this._sourceBuffer || this._sourceBuffer.updating
                || !this._mediaSource || this._mediaSource.readyState !== 'open') {
                return;
            }
            await this._removeFromSourceBuffer(0, trimEnd);
        }).catch(() => { /* superseded or busy; retried on a later timeupdate */ });
    }

    /** @private */
    _onEnded() {
        if (typeof this.onEnginePlaybackEnd === 'function') {
            this.onEnginePlaybackEnd();
        }
    }

    /** @private */
    _onElementError() {
        const error = this._element.error;
        console.debug('[gaplessEngine] media element error, code:', error ? error.code : 'unknown');
        if (typeof this.onEngineError === 'function') {
            this.onEngineError(error || new Error('media element error'));
        }
    }

    /**
     * @param {number} generation
     * @throws {SupersededError} When a newer reset()/start() superseded this work.
     * @private
     */
    _checkGeneration(generation) {
        if (generation !== this._generation) {
            throw new SupersededError();
        }
    }

    /**
     * @param {number} generation
     * @param {number} epoch
     * @throws {SupersededError} When superseded by reset() or invalidateNext().
     * @private
     */
    _checkEpoch(generation, epoch) {
        this._checkGeneration(generation);
        if (epoch !== this._nextEpoch) {
            throw new SupersededError();
        }
    }
}

export default GaplessEngine;
