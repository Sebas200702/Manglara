/**
 * Looping mangrove video backdrop.
 *
 * Autoplay requires the video to be muted; ambient sound is handled by the
 * separate looping <audio> track, started on a user gesture (call start) and
 * ducked during the call so it never competes with Manglara's voice.
 */
import { useEffect, useRef, useState } from "react";

const VIDEO_SRC = "/mangrove-loop.mp4";
const AMBIENT_SRC = "/mangrove-ambient.mp3";

export function MangroveVideo({
  ambient = false,
  ducked = false,
}: {
  /** start the ambient audio loop (pass a user-gesture-driven flag) */
  ambient?: boolean;
  /** lower the ambient volume while Manglara is talking */
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
      {videoOk && (
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
