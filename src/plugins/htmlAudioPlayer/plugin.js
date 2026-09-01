import { AppFeature } from 'constants/appFeature';
import { MediaError } from 'types/mediaError';

import browser from '../../scripts/browser';
import { appHost } from '../../components/apphost';
import * as htmlMediaHelper from '../../components/htmlMediaHelper';
import profileBuilder from '../../scripts/browserDeviceProfile';
import { getIncludeCorsCredentials } from '../../scripts/settings/webSettings';
import { PluginType } from '../../types/plugin.ts';
import Events from '../../utils/events.ts';
import GaplessEngine from './gaplessEngine';

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
            return GaplessEngine.isSupported()
                && options.item?.MediaType === 'Audio'
                && (options.playMethod === 'DirectPlay' || options.playMethod === 'DirectStream')
                && GaplessEngine.isEligibleUrl(options.url, options.mediaSource);
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

            return engine.start(options.url, itemInfo).then(function (started) {
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
                    console.debug('gapless engine activated');
                    Events.trigger(self, 'gaplessqueuenext');
                });
            }).catch(function () {
                console.debug('gapless engine start failed, falling back to stock playback');
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
            console.debug('gapless engine error, falling back to stock error handling');

            const errorCode = err && typeof err.code === 'number' ? err.code : 0;

            resetGaplessEngine();

            if (errorCode === 1) {
                // MEDIA_ERR_ABORTED, e.g. src changed while something was playing
                return;
            }

            let type;
            switch (errorCode) {
                case 2:
                    type = MediaError.NETWORK_ERROR;
                    break;
                case 4:
                    type = MediaError.MEDIA_NOT_SUPPORTED;
                    break;
                default:
                    type = MediaError.MEDIA_DECODE_ERROR;
                    break;
            }

            htmlMediaHelper.onErrorInternal(self, type);
        }

        self.setNextGaplessTrack = function (streamInfo, item, playlistItemId) {
            const engine = self._gaplessEngine;
            if (!engine || !self._gaplessActive) {
                return;
            }

            // No next track (queue end), or a next track the engine cannot
            // play (mixed queue): complete the timeline so 'ended' fires at
            // the boundary and stock playback takes over.
            if (!streamInfo || !GaplessEngine.isEligibleUrl(streamInfo.url, streamInfo.mediaSource)) {
                engine.markQueueEnd();
                return;
            }

            engine.appendNext(streamInfo.url, { playlistItemId, item, streamInfo }).catch(function () {
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

                htmlMediaHelper.seekOnPlaybackStart(self, e.target, self._currentPlayOptions.playerStartPositionTicks);
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
