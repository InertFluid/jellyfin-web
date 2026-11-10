/* Vinyl Now-Playing Screensaver for Jellyfin Web
 *
 * Self-contained, injected independently of Jellyfin's built-in screensaver
 * plugin system (that system lives inside the minified app bundle and isn't
 * safe to hand-patch — it gets overwritten on every server update). This
 * script runs alongside the app: its own idle timer, its own polling of the
 * Sessions API via the page's existing `ApiClient` global, its own overlay.
 *
 * SETUP: in Jellyfin -> Dashboard -> Users -> (your user) -> Display, set
 * "Screen Saver" to "None" so Jellyfin's own screensaver doesn't also try
 * to activate and fight with this one.
 */
(function () {
  'use strict';

  // ---- Tweakables -----------------------------------------------------
  var IDLE_MS = 1 * 60 * 1000;      // show screensaver after this much inactivity
  var POLL_MS = 5000;               // how often to refresh now-playing while shown
  var ACTIVE_WITHIN_SECONDS = 960;  // Sessions API "still alive" window

  // ---- Overlay DOM ------------------------------------------------------
  var overlay = document.createElement('div');
  overlay.id = 'vinylScreensaverOverlay';
  overlay.innerHTML =
    '<div class="vs-art"><img alt=""></div>' +
    '<div class="vs-turntable">' +
      '<div class="vs-reflection"></div>' +
      '<div class="vs-tilt">' +
        '<div class="vs-plinth"></div>' +
        '<div class="vs-disc">' +
          '<div class="vs-sheen"></div>' +
          '<div class="vs-label"><div class="vs-spindle"></div></div>' +
        '</div>' +
        '<div class="vs-tonearm"><div class="vs-headshell"></div></div>' +
        '<div class="vs-hinge"></div>' +
      '</div>' +
    '</div>' +
    '<div class="vs-meta">' +
      '<div class="vs-title"></div>' +
      '<div class="vs-artist"></div>' +
      '<div class="vs-album"></div>' +
    '</div>';

  var elArtImg = overlay.querySelector('.vs-art img');
  var elTitle = overlay.querySelector('.vs-title');
  var elArtist = overlay.querySelector('.vs-artist');
  var elAlbum = overlay.querySelector('.vs-album');
  var lastImgUrl = null;

  function mount() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
      return;
    }
    document.body.appendChild(overlay);
  }
  mount();

  // ---- State --------------------------------------------------------
  var idleTimer = null;
  var pollTimer = null;
  var visible = false;

  function isVideoPlaying() {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      if (!videos[i].paused && !videos[i].ended) return true;
    }
    return false;
  }

  function updateNowPlaying(title, artist, album, imgUrl) {
    elTitle.textContent = title || 'Nothing playing';
    elArtist.textContent = artist || '';
    elAlbum.textContent = album || '';

    if (imgUrl !== lastImgUrl) {
      lastImgUrl = imgUrl;
      if (imgUrl) {
        elArtImg.src = imgUrl;
      } else {
        elArtImg.removeAttribute('src');
      }
    }
  }

  function fetchNowPlaying() {
    var apiClient = window.ApiClient;
    if (!apiClient) return;

    apiClient.getSessions({ ActiveWithinSeconds: ACTIVE_WITHIN_SECONDS })
      .then(function (sessions) {
        var userId = apiClient.getCurrentUserId();
        var deviceId = apiClient.deviceId();
        var mine = null;
        for (var i = 0; i < sessions.length; i++) {
          var s = sessions[i];
          // Match THIS device's own session specifically - not just any
          // session for this user. Otherwise, if the same account is also
          // playing something elsewhere (phone, another browser tab), the
          // title flickers between whichever session happens to sort first
          // in the Sessions response from one poll to the next.
          if (s.UserId === userId && s.DeviceId === deviceId && s.NowPlayingItem && s.NowPlayingItem.MediaType === 'Audio') {
            mine = s;
            break;
          }
        }

        if (!mine) {
          updateNowPlaying('', '', '', null);
          return;
        }

        var item = mine.NowPlayingItem;
        var artist = (item.Artists && item.Artists.length) ? item.Artists.join(', ') : (item.AlbumArtist || '');
        var imgItemId = item.AlbumId || item.Id;
        var imgUrl = apiClient.getImageUrl(imgItemId, {
          type: 'Primary',
          maxWidth: 320,
          tag: item.AlbumPrimaryImageTag || undefined
        });

        updateNowPlaying(item.Name, artist, item.Album, imgUrl);
      })
      .catch(function (err) {
        console.warn('[vinyl-screensaver] failed to fetch now playing', err);
      });
  }

  // ---- Show / hide ----------------------------------------------------
  function show() {
    if (visible) return;
    if (isVideoPlaying()) return; // don't interrupt a movie/show
    visible = true;
    overlay.classList.add('vs-visible');
    fetchNowPlaying();
    pollTimer = window.setInterval(fetchNowPlaying, POLL_MS);
  }

  function hide() {
    if (!visible) return;
    visible = false;
    overlay.classList.remove('vs-visible');
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function resetIdleTimer() {
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(show, IDLE_MS);
  }

  function onActivity() {
    if (visible) hide();
    resetIdleTimer();
  }

  // Capture phase so this still sees input Jellyfin's own handlers stop
  // propagation on.
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'].forEach(function (evt) {
    document.addEventListener(evt, onActivity, { capture: true, passive: true });
  });

  resetIdleTimer();
})();
