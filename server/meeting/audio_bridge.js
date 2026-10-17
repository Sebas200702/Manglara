/* Manglara meeting audio bridge — injected via Playwright addInitScript
 * BEFORE the meeting page loads.
 *
 * Expects `window.__MANGLARA_CFG = { wsUrl, sessionId, avatarUrl,
 * avatarOrigin }` set by a tiny pre-script (browser.py). Re-runs safely on
 * every navigation (guard below).
 *
 * What it does:
 *  1. Overrides getUserMedia/enumerateDevices -> synthetic MediaStream:
 *       audio track = MediaStreamAudioDestinationNode (fake mic, starts MUTED)
 *       video track = canvas.captureStream(30): the avatar page (hidden
 *       iframe, `avatarUrl`) streams ImageBitmap frames that are painted on
 *       the canvas; an animated logo is the fallback until frames arrive.
 *  2. Tees remote participant audio: patches RTCPeerConnection 'track' events
 *     -> MediaStreamSource -> AudioWorklet downsample 16 kHz mono Int16
 *     -> {type:"remote_pcm"} over the control WebSocket.
 *  3. Plays bot audio: {type:"bot_pcm"} (24 kHz PCM16 from Gemini) ->
 *     AudioBufferSourceNode -> fake mic, gated by set_mic. The same PCM and
 *     her transcript (lip_text) go to the avatar iframe for lip-sync.
 *  4. Reports lifecycle: ready / gum_called / meeting_state / left / log.
 */
(function () {
  "use strict";
  // add_init_script runs in EVERY frame, including the provider's own iframes
  // and our avatar iframe. Only the top document is the meeting: a second
  // bridge in a subframe would steal the control WebSocket.
  try {
    if (window.top !== window) return;
  } catch (_) {
    return; // cross-origin top: we are a subframe
  }
  if (window.__manglaraBridgeInstalled) {
    // New navigation in the same context: just re-announce.
    try {
      window.__manglaraBridgeReport &&
        window.__manglaraBridgeReport({ type: "ready", renav: true });
    } catch (_) {}
    return;
  }
  window.__manglaraBridgeInstalled = true;

  var CFG = window.__MANGLARA_CFG || {};
  var WS_URL = CFG.wsUrl || "";
  // Sent as a WebSocket subprotocol, not in the URL: URLs end up in access logs.
  var WS_TOKEN = CFG.wsToken || "";
  var SESSION_ID = CFG.sessionId || "";
  var BRIDGE_PROTOCOL = "manglara.bridge";
  var SAMPLE_RATE = 16000; // PCM we send to the backend
  var BOT_RATE = 24000; // PCM we receive from Gemini

  function log(text) {
    report({ type: "log", text: String(text).slice(0, 300) });
  }

  /* ---------- control WebSocket ---------- */
  var ws = null;
  var wsDead = false;
  var queue = [];

  function report(msg) {
    msg.session = SESSION_ID;
    var s = null;
    try {
      s = JSON.stringify(msg);
    } catch (_) {
      return;
    }
    if (ws && ws.readyState === 1) {
      try {
        ws.send(s);
        return;
      } catch (_) {}
    }
    if (queue.length < 200) queue.push(s);
  }
  window.__manglaraBridgeReport = report;

  function connectWs() {
    if (wsDead || !WS_URL) return;
    var sock;
    try {
      sock = WS_TOKEN
        ? new WebSocket(WS_URL, [BRIDGE_PROTOCOL, "t." + WS_TOKEN])
        : new WebSocket(WS_URL);
    } catch (_) {
      setTimeout(connectWs, 3000);
      return;
    }
    sock.onopen = function () {
      ws = sock;
      while (queue.length) {
        try {
          ws.send(queue.shift());
        } catch (_) {
          break;
        }
      }
      report({ type: "ready" });
    };
    sock.onmessage = function (ev) {
      var msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      onControl(msg);
    };
    sock.onclose = function () {
      if (ws === sock) ws = null;
      if (!wsDead) setTimeout(connectWs, 3000);
    };
    sock.onerror = function () {
      try {
        sock.close();
      } catch (_) {}
    };
  }
  connectWs();

  window.addEventListener("beforeunload", function () {
    try {
      report({ type: "left" });
    } catch (_) {}
  });

  /* ---------- shared AudioContext ---------- */
  var actx = null;
  function audioCtx() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      actx = new AC({ latencyHint: "interactive" });
      if (actx.state === "suspended") actx.resume().catch(function () {});
    }
    return actx;
  }

  /* ---------- fake camera: avatar frames, logo fallback ---------- */
  var CAM_W = 640;
  var CAM_H = 480;
  var camCanvas = document.createElement("canvas");
  camCanvas.width = CAM_W;
  camCanvas.height = CAM_H;
  var camStream = null;
  var camTrack = null;
  var camOn = true;
  var frame = 0;
  // Avatar frames older than this mean the iframe stalled: show the logo.
  var AVATAR_STALE_MS = 1500;
  // No frame at all this long after mounting: log the fallback once.
  var AVATAR_TIMEOUT_MS = 5000;
  var lastAvatarFrameAt = 0;

  function paintBackground(ctx) {
    var g = ctx.createLinearGradient(0, 0, CAM_W, CAM_H);
    g.addColorStop(0, "#0c2b26");
    g.addColorStop(1, "#1d5c4d");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CAM_W, CAM_H);
  }

  function drawAvatarFrame(bitmap) {
    lastAvatarFrameAt = Date.now();
    try {
      if (camOn) {
        var ctx = camCanvas.getContext("2d");
        paintBackground(ctx);
        // Contain-fit (the avatar page renders 4:3 too, so usually 1:1).
        var s = Math.min(CAM_W / bitmap.width, CAM_H / bitmap.height);
        var w = bitmap.width * s;
        var h = bitmap.height * s;
        ctx.drawImage(bitmap, (CAM_W - w) / 2, (CAM_H - h) / 2, w, h);
      }
    } catch (_) {}
    try {
      bitmap.close();
    } catch (_) {}
  }

  function drawPlaceholder() {
    if (!camOn) return;
    if (Date.now() - lastAvatarFrameAt < AVATAR_STALE_MS) return;
    frame++;
    var ctx = camCanvas.getContext("2d");
    var t = frame / 2;
    paintBackground(ctx);
    var r = 90 + 8 * Math.sin(t * 1.4);
    ctx.beginPath();
    ctx.arc(320, 200, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(204,214,60,0.9)";
    ctx.fill();
    ctx.fillStyle = "#0c2b26";
    ctx.font = "bold 44px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("M", 320, 216);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 34px sans-serif";
    ctx.fillText("Manglara", 320, 350);
    ctx.font = "20px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillText("asistente virtual", 320, 382);
  }
  setInterval(drawPlaceholder, 500);
  drawPlaceholder();

  function videoTrack() {
    if (!camStream) {
      camStream = camCanvas.captureStream(30);
      camTrack = camStream.getVideoTracks()[0];
    }
    return camTrack;
  }

  /* ---------- avatar iframe (renders Manglara, sends frames) ---------- */
  var AVATAR_URL = CFG.avatarUrl || "";
  var AVATAR_ORIGIN = CFG.avatarOrigin || "";
  var avatarFrame = null;
  var avatarReady = false;
  var avatarMountedAt = 0;
  var avatarTimeoutLogged = false;

  function mountAvatar() {
    if (!AVATAR_URL) return;
    var root = document.documentElement;
    if (!root) return;
    if (avatarFrame && avatarFrame.isConnected) return;
    var f = document.createElement("iframe");
    f.src = AVATAR_URL;
    f.setAttribute("allow", "autoplay");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    // Inside the viewport (Chrome throttles offscreen cross-origin iframes)
    // but invisible and click-through.
    f.style.cssText =
      "position:fixed;left:0;bottom:0;width:" + CAM_W + "px;height:" + CAM_H +
      "px;border:0;opacity:0.01;pointer-events:none;z-index:-2147483647;";
    // Outside <body>: provider SPAs re-render body and would drop it.
    root.appendChild(f);
    avatarFrame = f;
    avatarReady = false;
    avatarMountedAt = Date.now();
    log("avatar iframe mounted");
  }

  function postToAvatar(msg, transfer) {
    if (!avatarFrame || !avatarReady || !AVATAR_ORIGIN) return;
    try {
      msg.__manglara = "bridge";
      avatarFrame.contentWindow.postMessage(msg, AVATAR_ORIGIN, transfer || []);
    } catch (_) {}
  }

  window.addEventListener("message", function (ev) {
    if (!AVATAR_ORIGIN || ev.origin !== AVATAR_ORIGIN) return;
    if (!avatarFrame || ev.source !== avatarFrame.contentWindow) return;
    var d = ev.data;
    if (!d || d.__manglara !== "avatar") return;
    if (d.type === "frame" && d.bitmap) {
      drawAvatarFrame(d.bitmap);
    } else if (d.type === "ready") {
      avatarReady = true;
      postToAvatar({ type: "state", state: avatarState });
      report({ type: "avatar_ready" });
    }
  });

  var avatarState = "idle";
  function setAvatarState(state) {
    avatarState = state;
    postToAvatar({ type: "state", state: state });
  }

  if (AVATAR_URL) {
    setInterval(function () {
      mountAvatar();
      if (
        !avatarTimeoutLogged &&
        avatarMountedAt &&
        !lastAvatarFrameAt &&
        Date.now() - avatarMountedAt > AVATAR_TIMEOUT_MS
      ) {
        avatarTimeoutLogged = true;
        report({ type: "avatar_timeout" });
      }
    }, 1000);
    mountAvatar();
  }

  /* ---------- fake mic: bot audio in, gated ---------- */
  var micDest = null;
  var micGate = null; // GainNode: 0 = muted toward the meeting
  var micTrack = null;
  var micOn = false;

  function ensureMic() {
    if (micDest) return;
    var ctx = audioCtx();
    micDest = ctx.createMediaStreamDestination();
    micGate = ctx.createGain();
    micGate.gain.value = 0;
    micGate.connect(micDest);
    micTrack = micDest.stream.getAudioTracks()[0];
  }

  // Chained playback cursor so bot_pcm chunks play gaplessly. Gemini streams
  // far ahead of real time, so many sources can be scheduled at once; they are
  // tracked so a barge-in / brain stop can drop the stale tail ("flush").
  var playCursor = 0;
  var pendingSources = [];
  function playBotPcm(b64) {
    try {
      ensureMic();
      var ctx = audioCtx();
      var bin = atob(b64);
      var n = Math.floor(bin.length / 2);
      if (n <= 0) return;
      var buf = ctx.createBuffer(1, n, BOT_RATE);
      var ch = buf.getChannelData(0);
      // Raw copy for the avatar (its playback clock drives the lip-sync);
      // only while her voice is open, so a muted Manglara stays idle.
      var raw = micOn && avatarReady ? new Uint8Array(n * 2) : null;
      for (var i = 0; i < n; i++) {
        var lo = bin.charCodeAt(i * 2);
        var hi = bin.charCodeAt(i * 2 + 1);
        if (raw) {
          raw[i * 2] = lo;
          raw[i * 2 + 1] = hi;
        }
        var v = (hi << 8) | lo;
        if (v >= 32768) v -= 65536;
        ch[i] = v / 32768;
      }
      if (raw) postToAvatar({ type: "pcm", data: raw.buffer }, [raw.buffer]);
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(micGate);
      var now = ctx.currentTime;
      if (playCursor < now) playCursor = now;
      src.start(playCursor);
      playCursor += buf.duration;
      pendingSources.push(src);
      src.onended = function () {
        var k = pendingSources.indexOf(src);
        if (k >= 0) pendingSources.splice(k, 1);
      };
    } catch (err) {
      log("playBotPcm error: " + err);
    }
  }

  function flushBotAudio() {
    var list = pendingSources;
    pendingSources = [];
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].onended = null;
        list[i].stop();
      } catch (_) {}
    }
    playCursor = 0;
  }

  function setMic(on) {
    micOn = !!on;
    try {
      ensureMic();
      var ctx = audioCtx();
      micGate.gain.setTargetAtTime(micOn ? 1 : 0, ctx.currentTime, 0.05);
    } catch (_) {}
    // Muted: the mouth must not keep moving to audio nobody hears.
    if (!micOn) postToAvatar({ type: "flush" });
  }

  function setCam(on) {
    camOn = !!on;
    try {
      var t = videoTrack();
      if (t) t.enabled = camOn;
    } catch (_) {}
  }

  /* ---------- getUserMedia / enumerateDevices overrides ---------- */
  var FAKE_MIC = {
    deviceId: "manglara-mic",
    groupId: "manglara",
    kind: "audioinput",
    label: "Manglara Microphone",
  };
  var FAKE_CAM = {
    deviceId: "manglara-cam",
    groupId: "manglara",
    kind: "videoinput",
    label: "Manglara Camera",
  };

  function syntheticStream(needAudio, needVideo) {
    var tracks = [];
    if (needAudio) {
      ensureMic();
      tracks.push(micTrack);
    }
    if (needVideo) tracks.push(videoTrack());
    return new MediaStream(tracks);
  }

  try {
    var proto = MediaDevices.prototype;
    var origEnum = proto.enumerateDevices;
    proto.enumerateDevices = function () {
      var self = this;
      var base = origEnum ? origEnum.call(self) : Promise.resolve([]);
      return base.then(function (devices) {
        var rest = (devices || []).filter(function (d) {
          return (
            d.deviceId !== FAKE_MIC.deviceId && d.deviceId !== FAKE_CAM.deviceId
          );
        });
        return [FAKE_MIC, FAKE_CAM].concat(rest);
      });
    };
    proto.getUserMedia = function (constraints) {
      constraints = constraints || {};
      var needAudio = !!constraints.audio;
      var needVideo = !!constraints.video;
      report({ type: "gum_called", audio: needAudio, video: needVideo });
      if (!needAudio && !needVideo) return Promise.reject(new Error("no tracks"));
      return Promise.resolve(syntheticStream(needAudio, needVideo));
    };
  } catch (err) {
    log("gum override failed: " + err);
  }

  /* ---------- remote audio tee ---------- */
  var workletReady = null;
  function ensureWorklet(ctx) {
    if (workletReady) return workletReady;
    var code =
      "const R=16000;class Tee extends AudioWorkletProcessor{" +
      "buf=[];acc=0;" +
      "process(i){const ch=i[0];if(!ch||!ch.length)return true;" +
      "const r=R/sampleRate;let m=ch[0];" +
      "if(ch.length>1){m=new Float32Array(ch[0].length);" +
      "for(let s=0;s<ch[0].length;s++){let a=0;" +
      "for(let c=0;c<ch.length;c++)a+=ch[c][s];m[s]=a/ch.length;}}" +
      "for(let s=0;s<m.length;s++){this.acc+=r;" +
      "if(this.acc>=1){this.acc-=1;" +
      "const v=Math.max(-1,Math.min(1,m[s]));" +
      "this.buf.push(v<0?Math.round(32768*v):Math.round(32767*v));}}" +
      "while(this.buf.length>=480){" +
      "const o=this.buf.splice(0,480);" +
      "const b=new Int16Array(o);" +
      "this.port.postMessage(b.buffer,[b.buffer]);}" +
      "return true;}}" +
      "registerProcessor('manglara-tee',Tee);";
    var url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    workletReady = ctx.audioWorklet.addModule(url);
    return workletReady;
  }

  function b64encode(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    var K = 0x8000;
    for (var i = 0; i < bytes.length; i += K) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + K));
    }
    return btoa(s);
  }

  var teedTracks = {};
  function teeTrack(track) {
    if (!track || track.kind !== "audio") return;
    if (teedTracks[track.id]) return;
    teedTracks[track.id] = true;
    try {
      var ctx = audioCtx();
      ensureWorklet(ctx).then(
        function () {
          var src = ctx.createMediaStreamSource(new MediaStream([track]));
          var node = new AudioWorkletNode(ctx, "manglara-tee");
          node.port.onmessage = function (ev) {
            report({ type: "remote_pcm", data: b64encode(ev.data) });
          };
          src.connect(node);
        },
        function (err) {
          log("tee worklet failed: " + err);
        }
      );
    } catch (err) {
      log("tee failed: " + err);
    }
  }

  function handleTrackEvent(ev, listener, self) {
    try {
      var streams = (ev && ev.streams) || [];
      for (var i = 0; i < streams.length; i++) {
        var ats = streams[i].getAudioTracks();
        for (var j = 0; j < ats.length; j++) teeTrack(ats[j]);
      }
      if (ev && ev.track) teeTrack(ev.track);
    } catch (_) {}
    if (typeof listener === "function") return listener.call(self, ev);
  }

  try {
    var OrigPC = window.RTCPeerConnection;
    if (OrigPC) {
      var origAdd = OrigPC.prototype.addEventListener;
      OrigPC.prototype.addEventListener = function (type, listener, opts) {
        if (type === "track") {
          var self = this;
          var wrapped = function (ev) {
            return handleTrackEvent(ev, listener, self);
          };
          return origAdd.call(this, type, wrapped, opts);
        }
        return origAdd.call(this, type, listener, opts);
      };
      Object.defineProperty(OrigPC.prototype, "ontrack", {
        configurable: true,
        enumerable: true,
        get: function () {
          return this.__manglaraOnTrack || null;
        },
        set: function (fn) {
          this.__manglaraOnTrack = fn;
          var self = this;
          origAdd.call(self, "track", function (ev) {
            return handleTrackEvent(ev, fn, self);
          });
        },
      });
    }
  } catch (err) {
    log("RTCPeerConnection patch failed: " + err);
  }

  /* ---------- meeting state polling (selectors from recipe) ---------- */
  function anyMatch(list) {
    list = list || [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      try {
        if (m.selector && document.querySelector(m.selector)) return true;
        if (
          m.text &&
          document.body &&
          document.body.innerText &&
          document.body.innerText.indexOf(m.text) >= 0
        )
          return true;
      } catch (_) {}
    }
    return false;
  }

  function pollState() {
    var sel = window.__MEETING_SELECTORS__ || {};
    var state = "unknown";
    if (anyMatch(sel.left)) state = "left";
    else if (anyMatch(sel.inMeeting)) state = "in_meeting";
    else if (anyMatch(sel.lobby)) state = "lobby";
    else if (anyMatch(sel.joining)) state = "joining";
    if (state !== pollState.last) {
      pollState.last = state;
      report({ type: "meeting_state", state: state });
    }
  }
  pollState.last = "unknown";
  setInterval(pollState, 2000);

  /* ---------- control messages from backend ---------- */
  function onControl(msg) {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "bot_pcm":
        if (msg.data) playBotPcm(msg.data);
        break;
      case "set_mic":
        setMic(msg.enabled);
        break;
      case "set_cam":
        setCam(msg.enabled);
        break;
      case "flush":
        flushBotAudio();
        postToAvatar({ type: "flush" });
        break;
      case "lip_text":
        if (micOn && typeof msg.text === "string") {
          postToAvatar({ type: "lip_text", text: msg.text });
        }
        break;
      case "turn_end":
        postToAvatar({ type: "turn_end" });
        break;
      case "avatar_state":
        if (typeof msg.state === "string") setAvatarState(msg.state);
        break;
      case "bye":
        wsDead = true;
        try {
          ws && ws.close();
        } catch (_) {}
        break;
      default:
        break;
    }
  }

  // Debug surface (devtools with MEETING_HEADLESS=false): `control` takes the
  // same messages the backend sends over the control WebSocket.
  window.__manglaraBridge = {
    setMic: setMic,
    setCam: setCam,
    playBotPcm: playBotPcm,
    control: onControl,
  };
})();
