/* webOS native-screensaver veto
 *
 * Independent of vinyl-screensaver.js. Only does anything when running
 * inside a packaged webOS app (checks for WebOSServiceBridge) - a no-op
 * everywhere else, including a plain desktop/mobile browser.
 *
 * Technique: subscribe to com.webos.service.tvpower's
 * registerScreenSaverRequest. webOS announces every time it's about to show
 * its own screensaver; we reply on responseScreenSaverRequest with
 * ack:false to veto it. This is UNDOCUMENTED LG platform API (no official
 * reference - sourced from community reverse-engineering: the mynextscreen
 * and Kodi-on-webOS projects use the same call). It can stop working on a
 * future webOS firmware update without notice.
 *
 * ---- DIAGNOSTIC LOGGING (temporary) ----
 * Every subscription event, visibility change, screensaver announcement and
 * ack decision gets pushed to a buffer and periodically uploaded to the
 * Jellyfin server's own /ClientLog/Document endpoint, which writes straight
 * into the server's normal log directory as upload_*.log - readable
 * directly on the server, no ares-inspect or TV-side access needed.
 * Remove the DiagLog block (and its call sites) once the issue is found.
 */
(function () {
  'use strict';

  // ---- Diagnostic log buffer, flushed to the Jellyfin server ----------
  var DiagLog = (function () {
    var buffer = [];
    var flushTimer = null;
    var FLUSH_DELAY_MS = 3000;
    var MAX_WAIT_MS = 15000;
    var firstUnflushedAt = null;

    function timestamp() {
      return new Date().toISOString();
    }

    function scheduleFlush() {
      if (firstUnflushedAt === null) firstUnflushedAt = Date.now();
      var waited = Date.now() - firstUnflushedAt;
      if (flushTimer) window.clearTimeout(flushTimer);
      var delay = waited >= MAX_WAIT_MS ? 0 : FLUSH_DELAY_MS;
      flushTimer = window.setTimeout(flush, delay);
    }

    function flush() {
      flushTimer = null;
      firstUnflushedAt = null;
      if (!buffer.length) return;
      var apiClient = window.ApiClient;
      if (!apiClient) return; // try again next time something gets logged
      var body = buffer.join('\n');

      apiClient.ajax({
        type: 'POST',
        url: apiClient.getUrl('ClientLog/Document'),
        data: body,
        contentType: 'text/plain'
      }).catch(function (err) {
        // can't log the failure to log usefully; drop it
        console.warn('[vinyl-screensaver-webos] failed to upload diagnostic log', err);
      });
    }

    function log(msg) {
      var line = '[vinyl-screensaver-webos] ' + timestamp() + ' ' + msg;
      console.debug(line);
      buffer.push(line);
      scheduleFlush();
    }

    return { log: log };
  })();

  if (typeof WebOSServiceBridge === 'undefined') {
    DiagLog.log('WebOSServiceBridge not present - not running inside a webOS app, nothing to do');
    return;
  }

  var CLIENT_NAME = 'org.jellyfin.webos.vinylscreensaver';
  var bridge;
  var activeCount = 0;
  var ackFalseCount = 0;
  var ackTrueCount = 0;

  DiagLog.log('startup: WebOSServiceBridge present, visibilityState=' + document.visibilityState + ', hasFocus=' + document.hasFocus());

  document.addEventListener('visibilitychange', function () {
    DiagLog.log('visibilitychange -> visibilityState=' + document.visibilityState + ', hasFocus=' + document.hasFocus());
  });

  // Heartbeat so we have a timeline even if nothing "interesting" happens
  window.setInterval(function () {
    DiagLog.log('heartbeat: visibilityState=' + document.visibilityState + ', hasFocus=' + document.hasFocus() +
      ', activeAnnouncementsSeen=' + activeCount + ', acksFalse=' + ackFalseCount + ', acksTrue=' + ackTrueCount);
  }, 60000);

  function respond(timestampVal) {
    var visible = document.visibilityState === 'visible';
    var focused = document.hasFocus();
    // Veto (ack:false) unless the page is BOTH reported hidden AND unfocused -
    // i.e. default to vetoing; only allow the screensaver through if every
    // signal we have agrees the app really is backgrounded.
    var ack = !(visible || focused) ? true : false;

    if (ack) ackTrueCount++; else ackFalseCount++;
    DiagLog.log('responding to Active announcement ts=' + timestampVal + ': visible=' + visible + ' focused=' + focused + ' -> ack=' + ack);

    var replyBridge = new WebOSServiceBridge();
    replyBridge.onservicecallback = function (msgStr) {
      DiagLog.log('response ack callback: ' + msgStr);
      replyBridge.cancel();
    };
    replyBridge.call(
      'luna://com.webos.service.tvpower/power/responseScreenSaverRequest',
      JSON.stringify({
        clientName: CLIENT_NAME,
        ack: ack,
        timestamp: timestampVal
      })
    );
  }

  function start() {
    bridge = new WebOSServiceBridge();
    bridge.onservicecallback = function (msgStr) {
      var msg;
      try {
        msg = JSON.parse(msgStr);
      } catch (e) {
        DiagLog.log('bad message from tvpower service: ' + msgStr);
        return;
      }

      if (msg.returnValue === false) {
        DiagLog.log('registerScreenSaverRequest REFUSED - app likely lacks com.webos.service.tvpower permission: ' + msgStr);
        return;
      }

      if (msg.state === 'Active' && msg.timestamp) {
        activeCount++;
        DiagLog.log('received Active announcement #' + activeCount + ': ' + msgStr);
        respond(msg.timestamp);
      } else {
        DiagLog.log('subscription message (not an Active announcement): ' + msgStr);
      }
    };

    bridge.call(
      'luna://com.webos.service.tvpower/power/registerScreenSaverRequest',
      JSON.stringify({ subscribe: true, clientName: CLIENT_NAME })
    );

    DiagLog.log('registerScreenSaverRequest call sent, awaiting first callback');
  }

  try {
    start();
  } catch (e) {
    DiagLog.log('failed to start: ' + (e && e.message ? e.message : String(e)));
  }
})();
