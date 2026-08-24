/**
 * Mangrove environment backdrop: a muted looping video plus ambient sound.
 *
 * The video is shown only during the call (behind the avatar); in the lobby it
 * is replaced by an explanatory panel (see call-screen.tsx). The ambient audio
 * track is started on a user gesture (call start) and ducked while Manglaria
 * is talking so it never competes with her voice.
 */
import { useEffect, useRef, useState } from "react";

const VIDEO_SRC = "/mangrove-loop.mp4";
const AMBIENT_SRC = "/mangrove-ambient.mp3";

export function MangroveVideo({
  showVideo = false,
  ambient = false,
  ducked = false,
}: {
  /** render the looping video backdrop (pass true while in a call) */
  showVideo?: boolean;
  /** start the ambient audio loop (pass a user-gesture-driven flag) */
  ambient?: boolean;
  /** lower the ambient volume while Manglaria is talking */
  ducked?: boolean;
}) {
  const [videoOk, setVideoOk] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);

  // keep ambient playback + volume in sync with the call state
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = ducked ? 0.08 : 0.28;
    if (ambient) {
      void audio.play().catch(() => {}); // ignore autoplay rejection
    } else {
      audio.pause();
    }
  }, [ambient, ducked]);

  return (
    <div className="absolute inset-0 z-0 overflow-hidden">
      {showVideo && videoOk && (
        <video
          className="size-full object-cover"
          src={VIDEO_SRC}
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          onError={() => setVideoOk(false)}
        />
      )}

      <audio ref={audioRef} src={AMBIENT_SRC} loop preload="none" />
    </div>
  );
}
