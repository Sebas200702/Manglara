/**
 * Standalone avatar renderer for meetings (`/meeting/avatar`).
 *
 * The meeting bot's injected script mounts this page in a hidden iframe and
 * uses its frames as Manglara's camera inside Teams/Zoom/Meet. It reuses the
 * 1:1 call's AvatarController as-is: idle animation (breathing, blinking, soft
 * smile) while asleep, and the same text-driven lip-sync while she speaks -
 * the parent forwards her PCM (for the playback clock; audio output is muted
 * in the bot browser) and her transcript.
 *
 * Opened directly in a browser it renders the avatar with an FPS counter, to
 * check the render loop on its own.
 *
 * Cost control: this runs in the bot's browser next to the meeting app itself,
 * so the frame rate follows what is on screen - full rate only while she
 * speaks (lip-sync), a calm rate while idle/listening, a trickle with the
 * camera off - and each rendered frame is copied once, straight from the
 * render loop.
 */
import type { AvatarState } from "@manglara/shared";
import { useEffect, useRef, useState } from "react";
import { AvatarController } from "../../components/avatar/avatar-controller";
import {
  announceReady,
  createFramePump,
  isEmbedded,
  parseBridgeMessage,
} from "./avatar-frame-bridge";

export const AVATAR_FRAME_WIDTH = 640;
export const AVATAR_FRAME_HEIGHT = 480;
/**
 * While speaking: readable lip-sync. TalkingHead only renders on a rAF tick at
 * least 1000/fps ms after the last one, so at 60 Hz this delivers ~23 fps.
 */
const FPS_SPEAKING = 30;
/**
 * Idle / listening / thinking: breathing, blinks and glances only (~10 fps).
 * Most of a meeting is spent here, so this rate sets most of the cost.
 */
const FPS_IDLE = 10;
/** Camera off in the meeting: nobody sees the frames, keep the scene ticking. */
const FPS_CAM_OFF = 2;
/** Same mangrove loop as the 1:1 call's backdrop. */
const BACKGROUND_SRC = "/mangrove-loop.mp4";

export function MeetingAvatarPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [fps, setFps] = useState(0);
  const [status, setStatus] = useState("Cargando avatar…");
  const embedded = isEmbedded();

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    let disposed = false;
    let stopFrames: (() => void) | null = null;
    let streamReady: Promise<void> | null = null;
    // Brain state from the parent; "speaking" comes from real playback instead.
    let baseState: AvatarState = "idle";
    let speaking = false;
    let camEnabled = true;
    let frames = 0;
    let lastFpsAt = performance.now();
    let fpsRaf = 0;

    const background = document.createElement("video");
    background.src = BACKGROUND_SRC;
    background.muted = true;
    background.loop = true;
    background.playsInline = true;
    background.preload = "auto";
    void background.play().catch(() => {});

    const pump = createFramePump({
      background,
      size: { width: AVATAR_FRAME_WIDTH, height: AVATAR_FRAME_HEIGHT },
      onFrame: () => {
        frames += 1;
      },
    });

    const applyFrameRate = () => {
      controller.setFrameRate(!camEnabled ? FPS_CAM_OFF : speaking ? FPS_SPEAKING : FPS_IDLE);
    };

    const controller = new AvatarController(
      node,
      {
        onReady: () => {
          if (disposed) return;
          setStatus("");
          if (embedded) {
            // Nobody looks at the iframe: frames leave through the pump. A
            // hidden canvas still renders but is not composited into the
            // meeting page on every frame (measured: -5-10 % CPU).
            const canvas = node.querySelector("canvas");
            if (canvas) canvas.style.visibility = "hidden";
          }
          stopFrames = controller.onFrameRendered((canvas) => {
            if (camEnabled) pump.push(canvas);
          });
          applyFrameRate();
          announceReady();
        },
        onSpeakingChange: (isSpeaking) => {
          speaking = isSpeaking;
          applyFrameRate();
          controller.setState(isSpeaking ? "speaking" : baseState);
        },
        onError: (err) => {
          console.error("[meeting-avatar]", err);
          setStatus("No se pudo cargar el avatar");
        },
      },
      // Same size whatever the screen scaling.
      { fps: FPS_IDLE, ignoreDevicePixelRatio: true }
    );
    void controller.init().catch(() => {});

    // Streaming needs an AudioContext; the bot browser allows autoplay, a
    // regular browser only after a gesture, so start it lazily on first audio.
    const ensureStream = (): Promise<void> => {
      if (!streamReady) {
        streamReady = controller.startStream().catch((err) => {
          streamReady = null;
          throw err;
        });
      }
      return streamReady;
    };

    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window.parent) return;
      const msg = parseBridgeMessage(ev.data);
      if (!msg || !controller.isReady) return;
      switch (msg.type) {
        case "ack":
          pump.ack();
          break;
        case "cam":
          camEnabled = msg.enabled;
          applyFrameRate();
          break;
        case "pcm":
          void ensureStream()
            .then(() => controller.feedAudio(msg.data))
            .catch(() => {});
          break;
        case "lip_text":
          void ensureStream()
            .then(() => controller.feedTranscript(msg.text))
            .catch(() => {});
          break;
        case "turn_end":
          controller.notifyEnd();
          break;
        case "flush":
          controller.interrupt();
          break;
        case "state":
          baseState = msg.state;
          controller.setState(msg.state);
          break;
      }
    };
    window.addEventListener("message", onMessage);

    if (!embedded) {
      const loop = () => {
        const now = performance.now();
        if (now - lastFpsAt >= 1000) {
          setFps(Math.round((frames * 1000) / (now - lastFpsAt)));
          frames = 0;
          lastFpsAt = now;
        }
        fpsRaf = requestAnimationFrame(loop);
      };
      fpsRaf = requestAnimationFrame(loop);
    }

    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
      cancelAnimationFrame(fpsRaf);
      stopFrames?.();
      pump.stop();
      background.pause();
      background.removeAttribute("src");
      controller.dispose();
    };
  }, [embedded]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-transparent">
      <div
        className="relative overflow-hidden"
        style={{
          width: AVATAR_FRAME_WIDTH,
          height: AVATAR_FRAME_HEIGHT,
          // Transparent when embedded: the parent paints the brand background
          // behind each frame. Standalone, show it here for a faithful preview.
          background: embedded
            ? "transparent"
            : "linear-gradient(135deg, #0c2b26 0%, #1d5c4d 100%)",
        }}
      >
        <div ref={containerRef} className="absolute inset-0 [&>canvas]:!h-full [&>canvas]:!w-full" />
        {status && (
          <p className="absolute inset-x-0 bottom-4 text-center text-xs font-bold text-white/80">
            {status}
          </p>
        )}
        {!embedded && (
          <span className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 font-mono text-[11px] text-white">
            {fps} fps (captura)
          </span>
        )}
      </div>
    </div>
  );
}
