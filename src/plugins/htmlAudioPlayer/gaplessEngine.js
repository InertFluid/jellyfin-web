/**
 * Gapless FLAC playback engine.
 *
 * Owns a MediaSource attached to the plugin's <audio> element with a single
 * SourceBuffer ('audio/mp4; codecs="flac"'). Each direct-play FLAC stream is
 * read in HTTP byte ranges, remuxed on the fly to fragmented MP4 (packet
 * copy, no re-encode) and appended onto one continuous timeline, so
 * consecutive tracks play back sample-accurately with no seam.
 *
 * Only a few seconds of each track are held in memory at any time, playback
 * starts after the first range arrives, and a seek anywhere in a track
 * fetches from the matching byte offset instead of reading up to it.
 *
 * Self-contained: imports only the remux helpers, so it stays unit-testable
 * outside the player plugin.
 */

import { FlacFrameSplitter, buildFragment, buildInitSegment, continueFlacHeader, parseFlacHeader } from './flacFmp4';

const MIME_TYPE = 'audio/mp4; codecs="flac"';

/** Seconds of already-played audio kept behind the playhead before trimming. */
const TRIM_BEHIND_SECONDS = 8;

/** Seconds of audio kept appended ahead of the playhead. */
const AHEAD_SECONDS = 15;

/**
 * Bytes of FLAC the SourceBuffer is allowed to hold. Chromium caps audio
 * SourceBuffers at 12 MB, and 15 s of 24-bit/192 kHz FLAC alone is ~9 MB,
 * so hi-res tracks get a shorter window than TRIM_BEHIND + AHEAD.
 */
const BUFFER_BUDGET_BYTES = 8 * 1024 * 1024;

/** Never keep less than this appended ahead of the playhead. */
const MIN_AHEAD_SECONDS = 4;

/** Remuxed-but-not-yet-appended seconds below which the next range is fetched. */
const FILL_AHEAD_SECONDS = 6;

/** Size of the first request for a file; covers the metadata of nearly all files. */
const HEADER_PROBE_BYTES = 65536;

/** Range sizes: small first so playback starts quickly, then larger. */
const FIRST_CHUNK_SECONDS = 1.5;
const CHUNK_SECONDS = 6;
const MIN_CHUNK_BYTES = 128 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const UNKNOWN_RATE_CHUNK_BYTES = 1024 * 1024;

/** How far before a seek target to start reading, so the target is covered. */
const SEEK_BACKOFF_SECONDS = 2;
const MAX_SEEK_ATTEMPTS = 5;

/** Network retries per range request before the engine gives up. */
const FETCH_RETRIES = 2;
const FETCH_RETRY_DELAY_MS = 500;

/** MediaSource duration until the real end is known (see _openMediaSource). */
const PLACEHOLDER_DURATION_SECONDS = 1e6;

/** Muxed timescales round (~1µs short); never compare times exactly. */
const TIME_EPSILON = 0.001;

/** Delay before retrying an append after a QuotaExceededError. */
const QUOTA_RETRY_DELAY_MS = 250;

/** Consecutive quota failures on the same append before giving up. */
const MAX_QUOTA_RETRIES = 20;

/**
 * Longest a SourceBuffer append/remove may go without firing 'updateend'
 * before it is treated as stuck. Embedded/TV MSE implementations have been
 * observed to occasionally drop the event under memory pressure; without a
 * watchdog that wedges the single-slot operation chain permanently.
 */
const SOURCE_BUFFER_UPDATE_TIMEOUT_MS = 10000;

/**
 * Error used internally to mark async continuations that were superseded by
 * a newer reset()/start()/seek()/invalidateNext(). Always swallowed.
 */
class SupersededError extends Error {
    constructor() {
        super('gapless engine operation superseded');
        this.name = 'GaplessSupersededError';
    }
}

/**
 * Tag an error with the engine stage it came from, for diagnostics.
 * @param {*} error
 * @param {string} stage
 * @returns {Error}
 */
function withStage(error, stage) {
    const e = error instanceof Error ? error : new Error(String(error));
    if (!e.gaplessStage) {
        e.gaplessStage = stage;
    }
    return e;
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

        /** Timeline entries, see _createEntry(). */
        this._entries = [];
        this._currentIndex = -1;

        // Generation guards every async continuation against reset()/start()
        // races; epoch additionally guards appendNext against invalidateNext().
        this._generation = 0;
        this._nextEpoch = 0;

        this._pendingAppends = 0;
        this._queueEnded = false;
        this._endOfStreamQueued = false;

        // SourceBuffer operations (append/remove/endOfStream) are serialized
        // through this promise chain: exactly one in flight at a time.
        this._operationChain = Promise.resolve();
        this._operationRunning = false;

        this._boundListeners = null;
        this._nextAppendInFlight = false;

        // Only one pump append is scheduled at a time.
        this._pumping = false;
        this._quotaRetryCount = 0;

        // The entry whose init segment (and timestampOffset) the SourceBuffer
        // currently has; a different entry's data needs its init first.
        this._lastInitEntry = null;
        this._sequence = 0;
        this._failed = false;

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
     * @param {string} url - Pre-authenticated direct-play stream URL. Must
     *     honour HTTP Range requests.
     * @param {Object} itemInfo - { playlistItemId, item, streamInfo } (opaque).
     * @param {{size: ?number, duration: ?number}} [hints] - File size in
     *     bytes and duration in seconds, used when the response lacks them.
     * @returns {Promise<boolean>} True when the timeline started; false when
     *     superseded by a newer start()/reset() (the caller must then leave
     *     the element alone — the newer session owns it).
     */
    async start(url, itemInfo, hints) {
        this.reset();
        const generation = this._generation;
        try {
            await this._openMediaSource(generation);
            const entry = this._createEntry(0, url, itemInfo, hints);
            await this._loadHeader(entry, generation);
            this._checkGeneration(generation);
            entry.startTime = null; // placed at 0 by the first init append
            this._entries.push(entry);
            this._currentIndex = 0;
            // Start reading audio while the init segment is being appended.
            this._fill(entry);
            const info = entry.info;
            console.debug(`[gaplessEngine] timeline started: rate=${info.sampleRate} bits=${info.bitsPerSample} channels=${info.channels} duration=${entry.duration.toFixed(3)}s`);
            this._pump();
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
     * Read the next track's header and add it to the timeline. Its audio is
     * fetched and appended by the pump once the current track has been
     * appended up to its end. Silent no-op if superseded.
     *
     * @param {string} url - Pre-authenticated direct-play stream URL.
     * @param {Object} itemInfo - { playlistItemId, item, streamInfo } (opaque).
     * @param {{size: ?number, duration: ?number}} [hints]
     * @returns {Promise<void>}
     */
    async appendNext(url, itemInfo, hints) {
        if (!this._mediaSource || this._queueEnded) {
            return;
        }
        // Single-future-slot invariant: at most one timeline entry beyond the
        // current track, and at most one prepare in flight. Deduplicates
        // double-resolution races (two 'gaplessqueuenext' answers for the
        // same boundary). RepeatOne still works: the boundary crossing advances
        // _currentIndex before the next request arrives, freeing the slot.
        const effectiveIndex = Math.max(this._currentIndex, 0);
        if (this._nextAppendInFlight || this._entries.length > effectiveIndex + 1) {
            return;
        }
        this._nextAppendInFlight = true;
        const generation = this._generation;
        const epoch = this._nextEpoch;
        this._pendingAppends++;
        try {
            const entry = this._createEntry(this._entries.length, url, itemInfo, hints);
            entry.isNext = true;
            await this._loadHeader(entry, generation);
            this._checkEpoch(generation, epoch);
            entry.index = this._entries.length;
            this._entries.push(entry);
            this._pump();
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
        this._nextAppendInFlight = false;
        this._queueEnded = false;
        this._endOfStreamQueued = false;

        if (this._currentIndex < 0 || this._entries.length <= this._currentIndex + 1) {
            return;
        }
        const future = this._entries.splice(this._currentIndex + 1);
        for (const entry of future) {
            this._stopReading(entry);
        }
        const firstFuture = future[0];
        if (this._lastInitEntry && future.includes(this._lastInitEntry)) {
            this._lastInitEntry = null;
        }

        // A future entry that was never placed has no buffered data.
        if (firstFuture.startTime == null) {
            return;
        }

        const removeFrom = firstFuture.startTime;
        const generation = this._generation;
        this._enqueueOperation(generation, async () => {
            if (!this._sourceBufferUsable()) {
                return;
            }
            if (this._bufferedEnd() > removeFrom + TIME_EPSILON) {
                await this._removeFromSourceBuffer(removeFrom, Number.POSITIVE_INFINITY);
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
        this._pump();
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
            position: Math.max(0, this._element.currentTime - (entry.startTime || 0)),
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
     * Seek within the current logical track. A buffered target is a plain
     * currentTime jump; anything else clears the buffer and starts reading
     * the file at the byte offset matching the target.
     *
     * @param {number} seconds - In-track position.
     * @returns {Promise<void>}
     */
    async seek(seconds) {
        const index = this._currentIndex >= 0 ? this._currentIndex : 0;
        const entry = this._entries[index];
        if (!entry || entry.startTime == null || !this._mediaSource) {
            console.debug('[gaplessEngine] seek ignored: no timeline');
            return;
        }
        // The very end has no frame to land on; stop just short of it.
        const limit = entry.duration > 0 ? Math.max(0, entry.duration - 0.05) : Number.POSITIVE_INFINITY;
        const position = Math.min(Math.max(seconds, 0), limit);
        const target = entry.startTime + position;
        if (this._isBuffered(target)) {
            this._element.currentTime = target;
            this._pump();
            return;
        }

        // Everything from this track on is re-read; later tracks are placed
        // again once this one has been appended to its end.
        const later = this._entries.slice(index + 1);
        for (const other of later) {
            this._restartReading(other, other.info.audioStart, true, null);
            other.startTime = null;
        }
        this._restartReading(entry, ...this._seekOffset(entry, position));

        this._lastInitEntry = null;
        this._endOfStreamQueued = false;
        const generation = this._generation;
        this._enqueueOperation(generation, async () => {
            if (!this._sourceBufferUsable()) {
                return;
            }
            const buffered = this._sourceBuffer.buffered;
            if (buffered.length) {
                await this._removeFromSourceBuffer(0, Number.POSITIVE_INFINITY);
            }
        }).catch((e) => {
            if (!(e instanceof SupersededError)) {
                this._fail(withStage(e, 'seek'));
            }
        });
        this._element.currentTime = target;
        this._pump();
    }

    /**
     * Snapshot of engine state for diagnostics. Contains no URLs (they
     * carry credentials).
     * @returns {Object}
     */
    describe() {
        const element = this._element;
        let buffered = [];
        try {
            const ranges = this._sourceBuffer ? this._sourceBuffer.buffered : null;
            if (ranges) {
                for (let i = 0; i < ranges.length; i++) {
                    buffered.push(`${ranges.start(i).toFixed(2)}-${ranges.end(i).toFixed(2)}`);
                }
            }
        } catch {
            buffered = ['unavailable'];
        }
        return {
            mediaSource: this._mediaSource ? this._mediaSource.readyState : 'none',
            buffered: buffered.join(','),
            currentTime: element ? +element.currentTime.toFixed(2) : null,
            readyState: element ? element.readyState : null,
            networkState: element ? element.networkState : null,
            paused: element ? element.paused : null,
            elementError: element && element.error ? `${element.error.code} ${element.error.message || ''}`.trim() : null,
            currentIndex: this._currentIndex,
            queueEnded: this._queueEnded,
            entries: this._entries.map((e) => ({
                index: e.index,
                rate: e.info ? e.info.sampleRate : null,
                bits: e.info ? e.info.bitsPerSample : null,
                channels: e.info ? e.info.channels : null,
                size: e.size,
                duration: +e.duration.toFixed(2),
                start: e.startTime == null ? null : +e.startTime.toFixed(3),
                readPos: e.readPos,
                eof: e.eof,
                queued: e.fragments.length
            }))
        };
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

        for (const entry of this._entries) {
            this._stopReading(entry);
        }

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
        this._pumping = false;
        this._quotaRetryCount = 0;
        this._queueEnded = false;
        this._endOfStreamQueued = false;
        this._lastInitEntry = null;
        this._failed = false;
        this._operationChain = Promise.resolve();
        this._operationRunning = false;
    }

    // ---- Entries and reading -------------------------------------------

    /** @private */
    _createEntry(index, url, itemInfo, hints) {
        return {
            index,
            url,
            itemInfo,
            hints: hints || {},
            info: null,
            initSegment: null,
            size: null,
            duration: 0,
            bytesPerSecond: 0,
            startTime: null,
            // Reading state; readEpoch invalidates in-flight reads on seek.
            readEpoch: 0,
            controller: null,
            readPos: 0,
            splitter: null,
            seekState: null,
            fetching: false,
            eof: false,
            firstChunk: true,
            fragments: [],
            queuedSeconds: 0
        };
    }

    /**
     * Fetch and parse the FLAC metadata, build the init segment and set up
     * reading from the first frame.
     * @private
     */
    async _loadHeader(entry, generation) {
        const controller = new AbortController(); /* eslint-disable-line compat/compat -- gated by isSupported() */
        entry.controller = controller;
        try {
            let range = await this._fetchRange(entry, 0, HEADER_PROBE_BYTES, controller.signal);
            this._checkGeneration(generation);
            let result = parseFlacHeader(range.bytes);
            let lastOffset = -1;
            while (!result.done) {
                if (result.needOffset <= lastOffset) {
                    throw new Error('FLAC metadata could not be parsed');
                }
                lastOffset = result.needOffset;
                range = await this._fetchRange(entry, result.needOffset, HEADER_PROBE_BYTES, controller.signal);
                this._checkGeneration(generation);
                if (!range.bytes.length) {
                    throw new Error('FLAC metadata runs past the end of the file');
                }
                result = continueFlacHeader(range.bytes, result.needOffset, result.state);
            }
            const info = result.info;
            entry.info = info;
            entry.initSegment = buildInitSegment(info);
            entry.duration = info.duration || entry.hints.duration || 0;
            if (!entry.size && entry.hints.size) {
                entry.size = entry.hints.size;
            }
            if (entry.size && entry.duration) {
                entry.bytesPerSecond = (entry.size - info.audioStart) / entry.duration;
            }
            entry.readPos = info.audioStart;
            entry.splitter = new FlacFrameSplitter(info, true);
        } catch (e) {
            if (controller.signal.aborted || e instanceof SupersededError) {
                throw new SupersededError();
            }
            throw withStage(e, 'header');
        } finally {
            if (entry.controller === controller) {
                entry.controller = null;
            }
        }
    }

    /**
     * GET one byte range. Requires a 206 answer: a server that ignores Range
     * would send the whole file, which is exactly what this engine avoids.
     *
     * @returns {Promise<{bytes: Uint8Array, eof: boolean}>}
     * @private
     */
    async _fetchRange(entry, start, length, signal) {
        let end = start + length - 1;
        if (entry.size) {
            if (start >= entry.size) {
                return { bytes: new Uint8Array(0), eof: true };
            }
            end = Math.min(end, entry.size - 1);
        }
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await fetch(entry.url, {
                    signal,
                    headers: { Range: `bytes=${start}-${end}` }
                });
                if (response.status === 416) {
                    return { bytes: new Uint8Array(0), eof: true };
                }
                if (response.status !== 206) {
                    // Don't read the body: for a 200 it is the whole file.
                    try {
                        response.body?.cancel();
                    } catch {
                        // ignore
                    }
                    const error = new Error(response.ok ?
                        'server ignored the byte range request' :
                        `stream fetch failed (${response.status})`);
                    error.permanent = true;
                    throw error;
                }
                const total = /\/(\d+)\s*$/.exec(response.headers.get('Content-Range') || '');
                if (total) {
                    entry.size = parseInt(total[1], 10);
                }
                const bytes = new Uint8Array(await response.arrayBuffer());
                const eof = bytes.length < end - start + 1
                    || (entry.size != null && start + bytes.length >= entry.size);
                return { bytes, eof };
            } catch (e) {
                if (signal.aborted || e.permanent || attempt >= FETCH_RETRIES) {
                    throw e;
                }
                await wait(FETCH_RETRY_DELAY_MS * (attempt + 1));
                if (signal.aborted) {
                    throw e;
                }
            }
        }
    }

    /**
     * Abort reading and drop remuxed data, without changing the position.
     * @private
     */
    _stopReading(entry) {
        entry.readEpoch++;
        if (entry.controller) {
            entry.controller.abort();
            entry.controller = null;
        }
        entry.fetching = false;
        entry.fragments = [];
        entry.queuedSeconds = 0;
    }

    /**
     * Restart reading an entry at a byte offset.
     * @param {Object} entry
     * @param {number} offset - File offset to read from.
     * @param {boolean} aligned - Whether offset is the first frame.
     * @param {?Object} seekState - Target tracking for a seek, else null.
     * @private
     */
    _restartReading(entry, offset, aligned, seekState) {
        this._stopReading(entry);
        entry.readPos = offset;
        entry.splitter = new FlacFrameSplitter(entry.info, aligned);
        entry.seekState = seekState;
        entry.eof = false;
        entry.firstChunk = true;
    }

    /**
     * Byte offset to read from for an in-track position.
     * @returns {[number, boolean, ?Object]} Arguments for _restartReading.
     * @private
     */
    _seekOffset(entry, position, attempt = 0) {
        const audioStart = entry.info.audioStart;
        if (!entry.bytesPerSecond || position <= SEEK_BACKOFF_SECONDS) {
            // Without a size there is no way to map time to bytes; reading
            // from the start is slow but correct.
            return [audioStart, true, null];
        }
        const backoff = SEEK_BACKOFF_SECONDS * Math.pow(3, attempt);
        const offset = Math.floor(audioStart + (Math.max(0, position - backoff) * entry.bytesPerSecond));
        if (offset <= audioStart) {
            return [audioStart, true, null];
        }
        return [offset, false, { position, attempt, targetSample: position * entry.info.sampleRate }];
    }

    /**
     * Fetch, split and remux the next byte range of an entry when its queue
     * of not-yet-appended audio is running low.
     * @private
     */
    _fill(entry) {
        if (entry.fetching || entry.eof || entry.queuedSeconds >= FILL_AHEAD_SECONDS || this._failed) {
            return;
        }
        entry.fetching = true;
        const generation = this._generation;
        const epoch = entry.readEpoch;
        const controller = new AbortController(); /* eslint-disable-line compat/compat -- gated by isSupported() */
        entry.controller = controller;
        const seconds = entry.firstChunk ? FIRST_CHUNK_SECONDS : CHUNK_SECONDS;
        const length = entry.bytesPerSecond ?
            Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.ceil(entry.bytesPerSecond * seconds))) :
            UNKNOWN_RATE_CHUNK_BYTES;
        const start = entry.readPos;

        this._fetchRange(entry, start, length, controller.signal).then((range) => {
            if (generation !== this._generation || epoch !== entry.readEpoch) {
                return;
            }
            entry.readPos = start + range.bytes.length;
            entry.firstChunk = false;
            let frames;
            try {
                frames = entry.splitter.push(range.bytes, range.eof);
            } catch (e) {
                throw withStage(e, 'parse');
            }

            const seek = entry.seekState;
            const overshot = frames.length ? frames[0].sample > seek?.targetSample : range.eof;
            if (seek && overshot && seek.attempt + 1 < MAX_SEEK_ATTEMPTS) {
                // Landed after the target (bitrate varies across the file)
                // or inside the last frame: start further back.
                this._restartReading(entry, ...this._seekOffset(entry, seek.position, seek.attempt + 1));
                this._fill(entry);
                return;
            }
            if (frames.length) {
                entry.seekState = null;
                const rate = entry.info.sampleRate;
                const last = frames[frames.length - 1];
                const fragment = {
                    data: buildFragment(frames, ++this._sequence),
                    start: frames[0].sample / rate,
                    end: (last.sample + last.blockSize) / rate,
                    epoch
                };
                entry.fragments.push(fragment);
                entry.queuedSeconds += fragment.end - fragment.start;
            }
            if (range.eof) {
                entry.eof = true;
                if (!entry.duration && frames.length) {
                    const last = frames[frames.length - 1];
                    entry.duration = (last.sample + last.blockSize) / entry.info.sampleRate;
                }
            }
            entry.fetching = false;
            entry.controller = null;
            this._pump();
        }).catch((e) => {
            if (generation !== this._generation || epoch !== entry.readEpoch || controller.signal.aborted) {
                return;
            }
            entry.fetching = false;
            entry.controller = null;
            this._fail(withStage(e, e && e.gaplessStage ? e.gaplessStage : 'fetch'));
        });
    }

    // ---- MediaSource -----------------------------------------------------

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
        try {
            this._sourceBuffer = mediaSource.addSourceBuffer(MIME_TYPE);
            // The init segments carry no duration, so the browser would treat
            // the buffered end as the end of the media and clamp forward
            // seeks to it. Infinity doesn't help: that makes the stream
            // "live", seekable only within what is buffered. A large finite
            // placeholder keeps the whole timeline seekable; endOfStream()
            // sets the real duration at the end of the queue.
            mediaSource.duration = PLACEHOLDER_DURATION_SECONDS;
        } catch (e) {
            throw withStage(e, 'addSourceBuffer');
        }
    }

    /** @private */
    _sourceBufferUsable() {
        return !!(this._sourceBuffer && this._mediaSource && this._mediaSource.readyState !== 'closed');
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

    /** @private */
    _appendToSourceBuffer(buffer) {
        return this._awaitSourceBufferUpdate((sourceBuffer) => sourceBuffer.appendBuffer(buffer), 'append');
    }

    /** @private */
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
                clearTimeout(watchdog);
            };
            const onEnd = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(withStage(new Error(`SourceBuffer ${label} error`), label));
            };
            const watchdog = setTimeout(() => {
                cleanup();
                reject(withStage(new Error(`SourceBuffer ${label} timed out waiting for updateend`), label));
            }, SOURCE_BUFFER_UPDATE_TIMEOUT_MS);
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
     * @returns {number} Media-time end of the last buffered range, or 0.
     * @private
     */
    _bufferedEnd() {
        const sourceBuffer = this._sourceBuffer;
        if (!sourceBuffer) {
            return 0;
        }
        let buffered;
        try {
            buffered = sourceBuffer.buffered;
        } catch {
            return 0;
        }
        return buffered.length ? buffered.end(buffered.length - 1) : 0;
    }

    /**
     * Seconds kept appended ahead of and behind the playhead, sized so the
     * current track's bitrate stays within BUFFER_BUDGET_BYTES.
     * @returns {{ahead: number, behind: number}}
     * @private
     */
    _window() {
        const entry = this._entries[Math.max(this._currentIndex, 0)];
        const rate = entry ? entry.bytesPerSecond : 0;
        if (!rate) {
            return { ahead: AHEAD_SECONDS, behind: TRIM_BEHIND_SECONDS };
        }
        const total = BUFFER_BUDGET_BYTES / rate;
        const behind = Math.min(TRIM_BEHIND_SECONDS, total * 0.3);
        return { ahead: Math.max(MIN_AHEAD_SECONDS, Math.min(AHEAD_SECONDS, total - behind)), behind };
    }

    /**
     * The next unit to append, walking the timeline from the current track:
     * an entry's init segment (placing it on the timeline the first time),
     * then its queued fragments. Starts reading where the queue is empty.
     * @returns {?{type: string, entry: Object}|string} 'done' when every
     *     entry has been appended to its end.
     * @private
     */
    _nextAppendUnit() {
        for (let i = Math.max(this._currentIndex, 0); i < this._entries.length; i++) {
            const entry = this._entries[i];
            if (entry.startTime == null || this._lastInitEntry !== entry) {
                if (entry.startTime != null && !entry.fragments.length) {
                    // Nothing to append for it yet; skip the re-init until there is.
                    if (entry.eof) {
                        continue;
                    }
                    this._fill(entry);
                    return null;
                }
                return { type: 'init', entry, epoch: entry.readEpoch };
            }
            this._fill(entry);
            if (entry.fragments.length) {
                return { type: 'frag', entry, epoch: entry.readEpoch };
            }
            if (!entry.eof) {
                return null;
            }
            // All of this track has been read: start on the next one early
            // so its first range is ready well before the seam.
            if (i + 1 < this._entries.length && this._entries[i + 1].startTime == null) {
                this._fill(this._entries[i + 1]);
            }
        }
        return 'done';
    }

    /**
     * Append scheduler. Re-invokes itself after each append and is also
     * driven by 'timeupdate' and by arriving data. Exactly one append is
     * scheduled at a time.
     * @private
     */
    _pump() {
        if (this._pumping || this._failed || !this._sourceBufferUsable()) {
            return;
        }

        const unit = this._nextAppendUnit();
        if (unit === 'done') {
            this._maybeEndOfStream();
            return;
        }
        if (!unit) {
            return;
        }

        // Fragments are gated by the look-ahead window; init segments are tiny
        // and always allowed (they don't add playable time on their own).
        if (unit.type === 'frag' && (this._bufferedEnd() - this._element.currentTime) >= this._window().ahead) {
            return;
        }

        this._pumping = true;
        const generation = this._generation;
        const entry = unit.entry;
        this._enqueueOperation(generation, async () => {
            // Skip work made stale by a seek or invalidateNext() since it was
            // scheduled.
            if (!this._sourceBufferUsable() || this._entries[entry.index] !== entry || unit.epoch !== entry.readEpoch) {
                return;
            }
            const sourceBuffer = this._sourceBuffer;
            if (unit.type === 'init') {
                // A new track butt-joins at the buffered end, which is
                // exactly where the previous track's last frame ends.
                let offset = entry.startTime;
                if (offset == null) {
                    offset = entry.index === 0 ? 0 : this._bufferedEnd();
                }
                sourceBuffer.timestampOffset = offset;
                await this._appendToSourceBuffer(entry.initSegment);
                // Published only once the append lands, so a failed append
                // leaves the entry unplaced rather than reachable-but-empty.
                entry.startTime = offset;
                this._lastInitEntry = entry;
                return;
            }
            const fragment = entry.fragments[0];
            if (!fragment || fragment.epoch !== entry.readEpoch) {
                return;
            }
            await this._appendToSourceBuffer(fragment.data);
            if (entry.fragments[0] === fragment) {
                entry.fragments.shift();
                entry.queuedSeconds = Math.max(0, entry.queuedSeconds - (fragment.end - fragment.start));
            }
        }).then(() => {
            this._pumping = false;
            this._quotaRetryCount = 0;
            this._pump();
        }).catch((e) => {
            this._pumping = false;
            if (e instanceof SupersededError) {
                return;
            }
            if (e && e.name === 'QuotaExceededError') {
                // Buffer momentarily full: trim and retry. Retried directly
                // (not just via 'timeupdate') since timeupdate may not fire
                // while playback is stalled waiting for this very append.
                this._quotaRetryCount++;
                if (this._quotaRetryCount > MAX_QUOTA_RETRIES) {
                    console.debug('[gaplessEngine] append quota exceeded repeatedly; giving up');
                    this._fail(withStage(e, 'quota'));
                    return;
                }
                console.debug('[gaplessEngine] append quota hit; trimming and backing off');
                this._trimBehindPlayhead(this._element.currentTime, true);
                setTimeout(() => {
                    if (generation === this._generation) {
                        this._pump();
                    }
                }, QUOTA_RETRY_DELAY_MS);
                return;
            }
            console.debug('[gaplessEngine] pump append failed:', e && e.message ? e.message : e);
            this._fail(withStage(e, 'append'));
        });
    }

    /**
     * Call endOfStream() once the queue is marked ended and every entry's data
     * has landed. Re-armed whenever the MediaSource reopens (a later append or
     * remove, e.g. a seek), so 'ended' still fires afterwards.
     * @private
     */
    _maybeEndOfStream() {
        if (!this._queueEnded || this._pendingAppends > 0 || this._endOfStreamQueued || this._pumping) {
            return;
        }
        if (!this._mediaSource || this._mediaSource.readyState !== 'open') {
            return;
        }
        if (this._nextAppendUnit() !== 'done') {
            return;
        }
        this._endOfStreamQueued = true;
        const generation = this._generation;
        this._enqueueOperation(generation, () => {
            this._endOfStreamQueued = false;
            if (!this._queueEnded || this._pendingAppends > 0 || this._nextAppendUnit() !== 'done') {
                return;
            }
            if (this._mediaSource && this._mediaSource.readyState === 'open' && !this._sourceBuffer.updating) {
                this._mediaSource.endOfStream();
            }
        }).catch(() => {
            this._endOfStreamQueued = false;
        });
    }

    /**
     * Binary search the timeline for the entry containing a media time.
     * @param {number} time
     * @returns {number} Entry index, or -1 when before the first entry.
     * @private
     */
    _indexForTime(time) {
        // Only placed entries have a startTime; they form a prefix of the
        // timeline (placed strictly in order).
        let placed = this._entries.length;
        while (placed > 0 && this._entries[placed - 1].startTime == null) {
            placed--;
        }
        let low = 0;
        let high = placed - 1;
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
            // Played tracks hold no audio data any more.
            for (let i = 0; i < index; i++) {
                this._stopReading(this._entries[i]);
            }
            // Fire once per forward crossing only; backwards moves (seeks)
            // update the index silently so they never double-fire.
            if (crossedForward && typeof this.onTrackBoundary === 'function') {
                const entry = this._entries[index];
                this.onTrackBoundary(index, entry.itemInfo, previousEntry ? previousEntry.itemInfo : null);
            }
        }
        this._pump();
        this._trimBehindPlayhead(time);
    }

    /**
     * Opportunistically remove played data more than TRIM_BEHIND_SECONDS
     * behind the playhead, keeping the buffered window modest (TV memory,
     * SourceBuffer quota). Skipped whenever an operation is already running,
     * unless force is set (quota-backoff retry), and once the stream has
     * ended: remove() would reopen the MediaSource and 'ended' would never
     * fire.
     * @param {number} time
     * @param {boolean} [force] - Enqueue the trim even if an op is running.
     * @private
     */
    _trimBehindPlayhead(time, force) {
        const sourceBuffer = this._sourceBuffer;
        const trimEnd = time - this._window().behind;
        if (!sourceBuffer || trimEnd <= 0) {
            return;
        }
        if (!force && (sourceBuffer.updating || this._operationRunning)) {
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
        const e = withStage(new Error(error && error.message ? error.message : 'media element error'), 'element');
        e.code = error ? error.code : 0;
        this._fail(e);
    }

    /**
     * Report a fatal error once per session.
     * @private
     */
    _fail(error) {
        if (this._failed) {
            return;
        }
        this._failed = true;
        if (typeof this.onEngineError === 'function') {
            this.onEngineError(error);
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
