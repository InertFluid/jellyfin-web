import { AppFeature } from 'constants/appFeature';
import { MediaError } from 'types/mediaError';

import browser from '../../scripts/browser';
import { appHost } from '../../components/apphost';
import * as htmlMediaHelper from '../../components/htmlMediaHelper';
import profileBuilder from '../../scripts/browserDeviceProfile';
import { getIncludeCorsCredentials } from '../../scripts/settings/webSettings';
import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import { currentSettings as appUserSettings } from '../../scripts/settings/userSettings';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import GaplessEngine from './gaplessEngine';

/** Whether the experimental gapless engine is enabled and usable here. */
function gaplessEnabled() {
    return GaplessEngine.isSupported() && appUserSettings.enableGaplessAudio();
}

/**
 * Audio formats the engine failed on this session (e.g. "flac/192000/24").
 * They play through the normal player (with its usual gap) instead of
 * failing again at the start of every track.
 */
const failedGaplessFormats = new Set();

function gaplessFormatKey(mediaSource) {
    const stream = (mediaSource?.MediaStreams || []).find((s) => s?.Type === 'Audio');
    if (!stream) {
        return 'flac/unknown';
    }
    return `${String(stream.Codec || 'flac').toLowerCase()}/${stream.SampleRate || '?'}/${stream.BitDepth || '?'}`;
}

/** Size and duration hints for the engine, from the server's media info. */
function gaplessHints(mediaSource, item) {
    const ticks = mediaSource?.RunTimeTicks || item?.RunTimeTicks;
    return {
        size: mediaSource?.Size || null,
        duration: ticks ? ticks / 10000000 : null
    };
}

/**
 * Whether an engine error says something about the format on this device,
 * as opposed to a passing network problem.
 */
function isFormatFailure(error) {
    const stage = error?.gaplessStage;
    return !(stage === 'fetch' || (stage === 'header' && error instanceof TypeError));
}

/**
 * Send gapless engine events to the server log (as an upload_*.log file in
 * the server's log folder), so failures on TVs can be read without a
 * remote debugger. Never includes stream URLs: they carry credentials.
 */
function reportGaplessEvent(event, details) {
    const lines = [
        `[gapless] ${new Date().toISOString()} ${event}`,
        `userAgent: ${navigator.userAgent}`,
        `mse flac-in-mp4 supported: ${GaplessEngine.isSupported()}`
    ];
    for (const [key, value] of Object.entries(details || {})) {
        lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    console.debug(lines.join('\n'));
    try {
        const apiClient = ServerConnections.currentApiClient();
        if (!apiClient) {
            return;
        }
        apiClient.ajax({
            type: 'POST',
            url: apiClient.getUrl('ClientLog/Document'),
            data: lines.join('\n'),
            contentType: 'text/plain'
        }).catch((err) => console.debug('[gapless] could not upload diagnostic log', err));
    } catch (err) {
        console.debug('[gapless] could not upload diagnostic log', err);
    }
}

function describeError(error) {
    if (!error) {
        return 'unknown';
    }
    return `${error.gaplessStage || 'unknown stage'} / ${error.name || 'Error'}: ${error.message || error}`;
}

function getDefaultProfile() {
    return profileBuilder({});
}

let fadeTimeout;
function fade(instance, elem, startingVolume) {
    instance._isFadingOut = true;

    // Need to record the starting volume on each pass rather than querying elem.volume
    // This is due to iOS safari not allowing volume changes and always returning the system volume value
    const newVolume = Math.max(0, startingVolume - 0.15);
    console.debug('fading volume to ' + newVolume);
    elem.volume = newVolume;

    if (newVolume <= 0) {
        instance._isFadingOut = false;
        return Promise.resolve();
    }

    return new Promise(function (resolve, reject) {
        cancelFadeTimeout();
        fadeTimeout = setTimeout(function () {
            fade(instance, elem, newVolume).then(resolve, reject);
        }, 100);
    });
}

function cancelFadeTimeout() {
    const timeout = fadeTimeout;
    if (timeout) {
        clearTimeout(timeout);
        fadeTimeout = null;
    }
}

function supportsFade() {
    // Not working on tizen.
    // We could possibly enable on other tv's, but all smart tv browsers tend to be pretty primitive
    return !browser.tv;
}

function requireHlsPlayer(callback) {
    import('hls.js/dist/hls.js').then(({ default: hls }) => {
        hls.DefaultConfig.lowLatencyMode = false;
        hls.DefaultConfig.backBufferLength = Infinity;
        hls.DefaultConfig.liveBackBufferLength = 90;
        window.Hls = hls;
        callback();
    });
}

function enableHlsPlayer(url, item, mediaSource, mediaType) {
    if (!htmlMediaHelper.enableHlsJsPlayer(mediaSource.RunTimeTicks, mediaType)) {
        return Promise.reject();
    }

    if (url.indexOf('.m3u8') !== -1) {
        return Promise.resolve();
    }

    // issue head request to get content type
    return new Promise(function (resolve, reject) {
        import('../../utils/fetch').then((fetchHelper) => {
            fetchHelper.ajax({
                url: url,
                type: 'HEAD'
            }).then(function (response) {
                const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
                if (contentType === 'application/vnd.apple.mpegurl' || contentType === 'application/x-mpegurl') {
                    resolve();
                } else {
                    reject();
                }
            }, reject);
        });
    });
}

class HtmlAudioPlayer {
    constructor() {
        const self = this;

        self.name = 'Html Audio Player';
        self.type = PluginType.MediaPlayer;
        self.id = 'htmlaudioplayer';

        // Let any players created by plugins take priority
        self.priority = 1;

        self._gaplessEngine = null;
        self._gaplessActive = false;

        // When gapless is enabled, use the full server PlaybackInfo for audio
        // instead of the universal fast-path. The universal endpoint fabricates
        // a MediaSource with empty MediaStreams and defers the direct-play vs
        // transcode decision to the server, so the client never learns the real
        // codec or gets a direct file URL — leaving the gapless engine unable to
        // detect eligible FLAC. Real PlaybackInfo yields a proper MediaSource
        // (codec, SupportsDirectPlay) and a static stream.<container> URL the
        // engine can remux. Dynamic getter so toggling the setting takes effect
        // without reload and audio reverts to the stock fast-path when disabled.
        Object.defineProperty(self, 'useServerPlaybackInfoForAudio', {
            configurable: true,
            get: () => gaplessEnabled()
        });

        self.play = function (options) {
            self._started = false;
            self._timeUpdated = false;
            self._currentTime = null;

            const elem = createMediaElement();

            if (isGaplessEligible(options)) {
                return playWithGaplessEngine(elem, options);
            }

            if (self._gaplessActive) {
                resetGaplessEngine();
            }

            return setCurrentSrc(elem, options);
        };

        function isGaplessEligible(options) {
            return gaplessEnabled()
                && options.item?.MediaType === 'Audio'
                && isEngineStream(options);
        }

        /** Direct FLAC in a format that hasn't already failed this session. */
        function isEngineStream(streamInfo) {
            return (streamInfo.playMethod === 'DirectPlay' || streamInfo.playMethod === 'DirectStream')
                && GaplessEngine.isEligibleUrl(streamInfo.url, streamInfo.mediaSource)
                && !failedGaplessFormats.has(gaplessFormatKey(streamInfo.mediaSource));
        }

        /** Remember a format the engine can't handle here, and log why. */
        function noteGaplessFailure(event, error, mediaSource) {
            const format = gaplessFormatKey(mediaSource);
            const remembered = isFormatFailure(error);
            if (remembered) {
                failedGaplessFormats.add(format);
            }
            reportGaplessEvent(event, {
                format,
                error: describeError(error),
                formatDisabledForSession: remembered,
                engine: self._gaplessEngine ? self._gaplessEngine.describe() : null
            });
        }

        function getGaplessEngine(elem) {
            let engine = self._gaplessEngine;
            if (!engine) {
                engine = new GaplessEngine(elem);
                engine.onTrackBoundary = onGaplessTrackBoundary;
                engine.onEngineError = onGaplessEngineError;
                self._gaplessEngine = engine;
            }
            return engine;
        }

        function resetGaplessEngine() {
            self._gaplessActive = false;
            if (self._gaplessEngine) {
                self._gaplessEngine.reset();
            }
        }

        function playWithGaplessEngine(elem, options) {
            unBindEvents(elem);
            bindEvents(elem);

            htmlMediaHelper.destroyHlsPlayer(self);

            self._currentPlayOptions = options;

            // Web audio normalization (addGainElement) is intentionally skipped
            // in engine mode.
            const engine = getGaplessEngine(elem);
            self._gaplessActive = true;

            const itemInfo = {
                playlistItemId: options.item?.PlaylistItemId ?? options.playlistItemId,
                item: options.item,
                streamInfo: null
            };

            const startedAt = Date.now();
            const session = {};
            self._gaplessSession = session;
            elem.addEventListener('playing', function () {
                if (self._gaplessActive && self._gaplessSession === session) {
                    reportGaplessEvent('engine playing', {
                        format: gaplessFormatKey(options.mediaSource),
                        startupMs: Date.now() - startedAt
                    });
                }
            }, { once: true });

            return engine.start(options.url, itemInfo, gaplessHints(options.mediaSource, options.item)).then(function (started) {
                if (started === false) {
                    // Superseded by a newer play(); that call owns the element
                    console.debug('gapless engine start superseded');
                    return;
                }

                self._currentSrc = options.url;

                // Element errors surface through the engine's own 'error'
                // listener (onEngineError), so unlike playWithPromise this
                // does not also bind onError to the element.
                return elem.play().catch(function (e) {
                    const errorName = (e?.name || '').toLowerCase();
                    // safari uses aborterror
                    if (errorName === 'notallowederror' || errorName === 'aborterror') {
                        // swallow, matching htmlMediaHelper.playWithPromise
                        return;
                    }
                    return Promise.reject(e);
                }).then(function () {
                    // No 'gaplessqueuenext' here: play() resolves before the
                    // playback manager moves its queue position to this track,
                    // so asking now would get this same track back as "next".
                    // The manager resolves the next track itself once its
                    // playback-started bookkeeping has run.
                    console.debug('gapless engine activated');
                });
            }).catch(function (err) {
                console.debug('gapless engine start failed, falling back to stock playback');
                noteGaplessFailure('engine start failed; playing without gapless', err, options.mediaSource);
                resetGaplessEngine();
                return setCurrentSrc(elem, options);
            });
        }

        function onGaplessTrackBoundary(newIndex, itemInfo, prevItemInfo) {
            const streamInfo = itemInfo.streamInfo;

            self._currentPlayOptions = Object.assign({}, self._currentPlayOptions, streamInfo || {}, {
                item: itemInfo.item,
                playerStartPositionTicks: 0
            });
            if (streamInfo?.url) {
                self._currentSrc = streamInfo.url;
            }

            Events.trigger(self, 'gaplesstrackboundary', [{ itemInfo, prevItemInfo }]);
            Events.trigger(self, 'gaplessqueuenext');
        }

        function onGaplessEngineError(err) {
            // Never log stream urls here (they carry credentials)
            console.debug('gapless engine error, falling back to direct playback');

            const elem = self._mediaElement;
            const engine = self._gaplessEngine;
            const current = engine ? engine.current() : null;
            const options = self._currentPlayOptions;
            const errorCode = err && typeof err.code === 'number' ? err.code : 0;

            if (errorCode === 1) {
                // MEDIA_ERR_ABORTED, e.g. src changed while something was playing
                resetGaplessEngine();
                return;
            }

            noteGaplessFailure('engine error; continuing without gapless', err, options?.mediaSource);
            const wasPaused = elem ? elem.paused : false;
            resetGaplessEngine();

            if (!elem || !options?.url) {
                htmlMediaHelper.onErrorInternal(self, MediaError.MEDIA_DECODE_ERROR);
                return;
            }

            // The file itself is fine to direct play (the engine only failed
            // to feed it through Media Source Extensions), so continue it in
            // the normal player at the same position. The generic error path
            // would make the playback manager retry with a server transcode.
            const position = current ? current.position : 0;
            setCurrentSrc(elem, Object.assign({}, options, {
                playerStartPositionTicks: Math.round(position * 10000000)
            })).then(function () {
                if (wasPaused) {
                    elem.pause();
                }
            }).catch(function () {
                htmlMediaHelper.onErrorInternal(self, MediaError.MEDIA_DECODE_ERROR);
            });
        }

        self.setNextGaplessTrack = function (streamInfo, item, playlistItemId) {
            const engine = self._gaplessEngine;
            if (!engine || !self._gaplessActive) {
                return;
            }

            // No next track (queue end), or a next track the engine cannot
            // play (mixed queue): complete the timeline so 'ended' fires at
            // the boundary and stock playback takes over.
            if (!streamInfo || !isEngineStream(streamInfo)) {
                engine.markQueueEnd();
                return;
            }

            const hints = gaplessHints(streamInfo.mediaSource, item);
            engine.appendNext(streamInfo.url, { playlistItemId, item, streamInfo }, hints).catch(function (err) {
                noteGaplessFailure('next track could not be prepared; it will play without gapless', err, streamInfo.mediaSource);
                // Could not append the next track; end the timeline so the
                // current track still finishes with a normal 'ended'.
                engine.markQueueEnd();
            });
        };

        self.invalidateGaplessNext = function () {
            if (self._gaplessEngine && self._gaplessActive) {
                self._gaplessEngine.invalidateNext();
            }
        };

        function setCurrentSrc(elem, options) {
            unBindEvents(elem);
            bindEvents(elem);

            let val = options.url;
            console.debug('playing url: ' + val);
            import('../../scripts/settings/userSettings').then((userSettings) => {
                let normalizationGain;
                if (userSettings.selectAudioNormalization() == 'TrackGain') {
                    normalizationGain = options.item.NormalizationGain
                        ?? options.mediaSource.albumNormalizationGain;
                } else if (userSettings.selectAudioNormalization() == 'AlbumGain') {
                    normalizationGain =
                        options.mediaSource.albumNormalizationGain
                        ?? options.item.NormalizationGain;
                } else {
                    console.debug('normalization disabled');
                    return;
                }

                if (!self.gainNode) {
                    addGainElement(elem);
                    if (!self.gainNode) return;
                }

                if (normalizationGain) {
                    self.normalizationGain = Math.pow(10, normalizationGain / 20);
                    self.gainNode.gain.value = self.normalizationGain;
                } else {
                    self.gainNode.gain.value = 1;
                    self.normalizationGain = 1;
                }
                if (browser.safari) {
                    // Gain value is absolute in Safari. Add volume from the slider
                    self.gainNode.gain.value *= elem.volume;
                }
                console.debug('gain: ' + self.normalizationGain);
            }).catch((err) => {
                console.error('Failed to add/change gainNode', err);
            });

            // Convert to seconds
            const seconds = (options.playerStartPositionTicks || 0) / 10000000;
            if (seconds) {
                val += '#t=' + seconds;
            }

            htmlMediaHelper.destroyHlsPlayer(self);

            self._currentPlayOptions = options;

            const crossOrigin = htmlMediaHelper.getCrossOriginValue(options.mediaSource);
            if (crossOrigin) {
                elem.crossOrigin = crossOrigin;
            }

            return enableHlsPlayer(val, options.item, options.mediaSource, 'Audio').then(function () {
                return new Promise(function (resolve, reject) {
                    requireHlsPlayer(async () => {
                        const includeCorsCredentials = await getIncludeCorsCredentials();

                        const hls = new Hls({
                            manifestLoadingTimeOut: 20000,
                            xhrSetup: function (xhr) {
                                xhr.withCredentials = includeCorsCredentials;
                            }
                        });
                        hls.loadSource(val);
                        hls.attachMedia(elem);

                        htmlMediaHelper.bindEventsToHlsPlayer(self, hls, elem, onError, resolve, reject);

                        self._hlsPlayer = hls;

                        self._currentSrc = val;
                    });
                });
            }, async () => {
                elem.autoplay = true;

                const includeCorsCredentials = await getIncludeCorsCredentials();
                if (includeCorsCredentials) {
                    // Safari will not send cookies without this
                    elem.crossOrigin = 'use-credentials';
                }

                return htmlMediaHelper.applySrc(elem, val, options).then(function () {
                    self._currentSrc = val;

                    return htmlMediaHelper.playWithPromise(elem, onError);
                });
            });
        }

        function bindEvents(elem) {
            elem.addEventListener('timeupdate', onTimeUpdate);
            elem.addEventListener('ended', onEnded);
            elem.addEventListener('volumechange', onVolumeChange);
            elem.addEventListener('pause', onPause);
            elem.addEventListener('playing', onPlaying);
            elem.addEventListener('play', onPlay);
            elem.addEventListener('waiting', onWaiting);
        }

        function unBindEvents(elem) {
            elem.removeEventListener('timeupdate', onTimeUpdate);
            elem.removeEventListener('ended', onEnded);
            elem.removeEventListener('volumechange', onVolumeChange);
            elem.removeEventListener('pause', onPause);
            elem.removeEventListener('playing', onPlaying);
            elem.removeEventListener('play', onPlay);
            elem.removeEventListener('waiting', onWaiting);
            elem.removeEventListener('error', onError); // bound in htmlMediaHelper
        }

        self.stop = function (destroyPlayer) {
            cancelFadeTimeout();

            const elem = self._mediaElement;
            const src = self._currentSrc;

            if (elem && src) {
                if (!destroyPlayer || !supportsFade()) {
                    elem.pause();

                    resetGaplessEngine();
                    htmlMediaHelper.onEndedInternal(self, elem, onError);

                    if (destroyPlayer) {
                        self.destroy();
                    }
                    return Promise.resolve();
                }

                const originalVolume = elem.volume;

                return fade(self, elem, elem.volume).then(function () {
                    elem.pause();
                    elem.volume = originalVolume;

                    resetGaplessEngine();
                    htmlMediaHelper.onEndedInternal(self, elem, onError);

                    if (destroyPlayer) {
                        self.destroy();
                    }
                });
            }
            return Promise.resolve();
        };

        self.destroy = function () {
            resetGaplessEngine();
            unBindEvents(self._mediaElement);
            htmlMediaHelper.resetSrc(self._mediaElement);
        };

        function createMediaElement() {
            let elem = self._mediaElement;

            if (elem) {
                return elem;
            }

            elem = document.querySelector('.mediaPlayerAudio');

            if (!elem) {
                elem = document.createElement('audio');
                elem.classList.add('mediaPlayerAudio');
                elem.classList.add('hide');

                document.body.appendChild(elem);
            }

            // TODO: Move volume control to PlaybackManager. Player should just be a wrapper that translates commands into API calls.
            if (!appHost.supports(AppFeature.PhysicalVolumeControl)) {
                elem.volume = htmlMediaHelper.getSavedVolume();
            }

            self._mediaElement = elem;

            return elem;
        }

        function addGainElement(elem) {
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext; /* eslint-disable-line compat/compat */

                const audioCtx = new AudioContext();
                const source = audioCtx.createMediaElementSource(elem);

                const gainNode = audioCtx.createGain();

                source.connect(gainNode);
                gainNode.connect(audioCtx.destination);

                self.gainNode = gainNode;
            } catch (e) {
                console.error('Web Audio API is not supported in this browser', e);
            }
        }

        function onEnded() {
            // In engine mode 'ended' only fires at the true end of the queue
            // (after endOfStream()), so the stock flow reports the final stop.
            resetGaplessEngine();
            htmlMediaHelper.onEndedInternal(self, this, onError);
        }

        function onTimeUpdate() {
            // Get the player position + the transcoding offset
            let time = this.currentTime;

            if (self._gaplessActive && self._gaplessEngine) {
                // Translate to the logical in-track position
                const current = self._gaplessEngine.current();
                if (current) {
                    time = current.position;
                }
            }

            // Don't trigger events after user stop
            if (!self._isFadingOut) {
                self._currentTime = time;
                Events.trigger(self, 'timeupdate');
            }
        }

        function onVolumeChange() {
            if (!self._isFadingOut) {
                htmlMediaHelper.saveVolume(this.volume);
                if (browser.safari && self.gainNode) {
                    self.gainNode.gain.value = this.volume * self.normalizationGain;
                }
                Events.trigger(self, 'volumechange');
            }
        }

        function onPlaying(e) {
            if (!self._started) {
                self._started = true;
                this.removeAttribute('controls');

                if (self._gaplessActive && self._gaplessEngine) {
                    // The stock path sets element.currentTime directly, which
                    // bypasses the engine's buffered/forward/backward-rebuild
                    // seek logic entirely: a resume position past the initial
                    // look-ahead window would land in unbuffered territory the
                    // engine was never told to fill. Route it through the
                    // engine instead so it fills toward the resume point.
                    const seconds = (self._currentPlayOptions.playerStartPositionTicks || 0) / 10000000;
                    if (seconds) {
                        self._gaplessEngine.seek(seconds).catch((err) => self._gaplessEngine?.onEngineError?.(err));
                    }
                } else {
                    htmlMediaHelper.seekOnPlaybackStart(self, e.target, self._currentPlayOptions.playerStartPositionTicks);
                }
            }
            Events.trigger(self, 'playing');
        }

        function onPlay() {
            Events.trigger(self, 'unpause');
        }

        function onPause() {
            Events.trigger(self, 'pause');
        }

        function onWaiting() {
            Events.trigger(self, 'waiting');
        }

        function onError() {
            const errorCode = this.error ? (this.error.code || 0) : 0;
            const errorMessage = this.error ? (this.error.message || '') : '';
            console.error('media element error: ' + errorCode.toString() + ' ' + errorMessage);

            let type;

            switch (errorCode) {
                case 1:
                    // MEDIA_ERR_ABORTED
                    // This will trigger when changing media while something is playing
                    return;
                case 2:
                    // MEDIA_ERR_NETWORK
                    type = MediaError.NETWORK_ERROR;
                    break;
                case 3:
                    // MEDIA_ERR_DECODE
                    if (self._hlsPlayer) {
                        htmlMediaHelper.handleHlsJsMediaError(self);
                        return;
                    } else {
                        type = MediaError.MEDIA_DECODE_ERROR;
                    }
                    break;
                case 4:
                    // MEDIA_ERR_SRC_NOT_SUPPORTED
                    type = MediaError.MEDIA_NOT_SUPPORTED;
                    break;
                default:
                    // seeing cases where Edge is firing error events with no error code
                    // example is start playing something, then immediately change src to something else
                    return;
            }

            htmlMediaHelper.onErrorInternal(self, type);
        }
    }

    currentSrc() {
        return this._currentSrc;
    }

    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'audio';
    }

    getDeviceProfile(item) {
        if (appHost.getDeviceProfile) {
            return appHost.getDeviceProfile(item);
        }

        return getDefaultProfile();
    }

    toggleAirPlay() {
        return this.setAirPlayEnabled(!this.isAirPlayEnabled());
    }

    // Save this for when playback stops, because querying the time at that point might return 0
    currentTime(val) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            if (val != null) {
                if (this._gaplessActive && this._gaplessEngine) {
                    this._gaplessEngine.seek(val / 1000)
                        .catch((e) => this._gaplessEngine?.onEngineError?.(e));
                    return;
                }
                mediaElement.currentTime = val / 1000;
                return;
            }

            if (this._gaplessActive && this._gaplessEngine) {
                const current = this._gaplessEngine.current();
                if (current) {
                    return current.position * 1000;
                }
            }

            const currentTime = this._currentTime;
            if (currentTime) {
                return currentTime * 1000;
            }

            return (mediaElement.currentTime || 0) * 1000;
        }
    }

    duration() {
        if (this._gaplessActive && this._gaplessEngine) {
            const current = this._gaplessEngine.current();
            if (current && htmlMediaHelper.isValidDuration(current.duration)) {
                return current.duration * 1000;
            }

            return null;
        }

        const mediaElement = this._mediaElement;
        if (mediaElement) {
            const duration = mediaElement.duration;
            if (htmlMediaHelper.isValidDuration(duration)) {
                return duration * 1000;
            }
        }

        return null;
    }

    seekable() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            const seekable = mediaElement.seekable;
            if (seekable?.length) {
                let start = seekable.start(0);
                let end = seekable.end(0);

                if (!htmlMediaHelper.isValidDuration(start)) {
                    start = 0;
                }
                if (!htmlMediaHelper.isValidDuration(end)) {
                    end = 0;
                }

                return (end - start) > 0;
            }

            return false;
        }
    }

    getBufferedRanges() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return htmlMediaHelper.getBufferedRanges(this, mediaElement);
        }

        return [];
    }

    pause() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.pause();
        }
    }

    // This is a retry after error
    resume() {
        this.unpause();
    }

    unpause() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.play();
        }
    }

    paused() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return mediaElement.paused;
        }

        return false;
    }

    setPlaybackRate(value) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.playbackRate = value;
        }
    }

    getPlaybackRate() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return mediaElement.playbackRate;
        }
        return null;
    }

    setVolume(val) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.volume = Math.pow(val / 100, 3);
        }
    }

    getVolume() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return Math.min(Math.round(Math.pow(mediaElement.volume, 1 / 3) * 100), 100);
        }
    }

    volumeUp() {
        this.setVolume(Math.min(this.getVolume() + 2, 100));
    }

    volumeDown() {
        this.setVolume(Math.max(this.getVolume() - 2, 0));
    }

    setMute(mute) {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            mediaElement.muted = mute;
        }
    }

    isMuted() {
        const mediaElement = this._mediaElement;
        if (mediaElement) {
            return mediaElement.muted;
        }
        return false;
    }

    isAirPlayEnabled() {
        if (document.AirPlayEnabled) {
            return !!document.AirplayElement;
        }
        return false;
    }

    setAirPlayEnabled(isEnabled) {
        const mediaElement = this._mediaElement;

        if (mediaElement) {
            if (document.AirPlayEnabled) {
                if (isEnabled) {
                    mediaElement.requestAirPlay().catch(function(err) {
                        console.error('Error requesting AirPlay', err);
                    });
                } else {
                    document.exitAirPLay().catch(function(err) {
                        console.error('Error exiting AirPlay', err);
                    });
                }
            } else {
                mediaElement.webkitShowPlaybackTargetPicker();
            }
        }
    }

    supports(feature) {
        if (!supportedFeatures) {
            supportedFeatures = getSupportedFeatures();
        }

        return supportedFeatures.indexOf(feature) !== -1;
    }
}

let supportedFeatures;

function getSupportedFeatures() {
    const list = [];
    const audio = document.createElement('audio');

    if (typeof audio.playbackRate === 'number') {
        list.push('PlaybackRate');
    }

    if (browser.safari) {
        list.push('AirPlay');
    }

    return list;
}

export default HtmlAudioPlayer;
