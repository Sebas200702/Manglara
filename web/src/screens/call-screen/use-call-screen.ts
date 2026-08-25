import type { AvatarState } from "@manglara/shared";
import { useEffect, useRef, useState } from "react";
import { AvatarController } from "../../components/avatar/avatar-controller";
import { VoiceClient, type ConnectionState } from "../../lib/voice-client";
import { useCallScreenStore } from "./call-screen-store";

function deriveAvatarState(
  connection: ConnectionState,
  speaking: boolean,
  thinking: boolean
): AvatarState {
  if (connection !== "connected") return "idle";
  if (speaking) return "speaking";
  if (thinking) return "thinking";
  return "listening";
}

export function useCallScreen() {
  const clientRef = useRef<VoiceClient | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const avatarContainerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<AvatarController | null>(null);
  const [avatarReady, setAvatarReady] = useState(false);

  const connection = useCallScreenStore((s) => s.connection);
  const speaking = useCallScreenStore((s) => s.speaking);
  const thinking = useCallScreenStore((s) => s.thinking);
  const inCall = useCallScreenStore((s) => s.inCall);
  const error = useCallScreenStore((s) => s.error);
  const notice = useCallScreenStore((s) => s.notice);
  const transcripts = useCallScreenStore((s) => s.transcripts);
  const loading = useCallScreenStore((s) => s.loading);
  const chatOpen = useCallScreenStore((s) => s.chatOpen);
  const micEnabled = useCallScreenStore((s) => s.micEnabled);
  const cameraEnabled = useCallScreenStore((s) => s.cameraEnabled);

  const setConnection = useCallScreenStore((s) => s.setConnection);
  const setSpeaking = useCallScreenStore((s) => s.setSpeaking);
  const setThinking = useCallScreenStore((s) => s.setThinking);
  const setInCall = useCallScreenStore((s) => s.setInCall);
  const setError = useCallScreenStore((s) => s.setError);
  const setNotice = useCallScreenStore((s) => s.setNotice);
  const setLoading = useCallScreenStore((s) => s.setLoading);
  const setChatOpen = useCallScreenStore((s) => s.setChatOpen);
  const setMicEnabled = useCallScreenStore((s) => s.setMicEnabled);
  const setCameraEnabled = useCallScreenStore((s) => s.setCameraEnabled);
  const appendTranscript = useCallScreenStore((s) => s.appendTranscript);
  const clearTranscripts = useCallScreenStore((s) => s.clearTranscripts);
  const resetCallState = useCallScreenStore((s) => s.resetCallState);

  const avatarState = deriveAvatarState(connection, speaking, thinking);
  /** Clears the "Reconectado" notice after a moment; see `onReconnected`. */
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    []
  );

  // Create and load the 3D avatar once, independent of the call lifecycle, so
  // it renders (idle) before and after calls.
  useEffect(() => {
    const node = avatarContainerRef.current;
    if (!node) return;

    const controller = new AvatarController(node, {
      onReady: () => setAvatarReady(true),
      onSpeakingChange: (isSpeaking) => {
        setSpeaking(isSpeaking);
        if (isSpeaking) setThinking(false);
      },
      onError: (err) => console.error("[avatar]", err),
    });
    controllerRef.current = controller;
    void controller.init().catch(() => {});

    return () => {
      controller.dispose();
      controllerRef.current = null;
      setAvatarReady(false);
    };
  }, [setSpeaking, setThinking]);

  // Drive gaze/mood from the call state machine.
  useEffect(() => {
    controllerRef.current?.setState(avatarState);
  }, [avatarState]);

  // Half-duplex: while Manglara is speaking, suppress the mic so her voice over
  // an external speaker isn't captured and echoed back into a self-reply loop.
  // `speaking` reflects real playback end in both the avatar and fallback paths.
  useEffect(() => {
    clientRef.current?.setInputSuppressed(speaking);
  }, [speaking]);

  const showNotice = (text: string, tone: "warn" | "ok", clearAfterMs?: number) => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setNotice({ text, tone });
    if (clearAfterMs) {
      noticeTimerRef.current = setTimeout(() => {
        setNotice(null);
        noticeTimerRef.current = null;
      }, clearAfterMs);
    }
  };

  const startCall = async () => {
    setError(null);
    setNotice(null);
    setLoading(true);
    clearTranscripts();

    const client = new VoiceClient({
      onConnectionChange: setConnection,
      onTranscript: (role, text) => {
        if (role === "user") setThinking(true);
        // The assistant's own transcript drives the mouth shapes: Gemini gives
        // no phoneme timings, but Spanish text maps to visemes reliably.
        else controllerRef.current?.feedTranscript(text);
        appendTranscript(role, text);
      },
      onTurnComplete: () => {
        setThinking(false);
        setSpeaking(false);
        controllerRef.current?.notifyEnd();
      },
      onInterrupted: () => {
        // Barge-in: drop the stale audio and mouth shapes for the abandoned turn.
        controllerRef.current?.interrupt();
        setSpeaking(false);
        setThinking(false);
      },
      onSpeakingChange: (isSpeaking) => {
        setSpeaking(isSpeaking);
        if (isSpeaking) setThinking(false);
      },
      onSessionReady: () => {
        setThinking(false);
      },
      onError: (message) => setError(message),
      onReconnecting: (attempt) => {
        // Not an error: the call is still up and the client keeps retrying, so
        // this is a status line the user can wait out, not a failure banner.
        showNotice(
          attempt === 1
            ? "Reconectando…"
            : `Reconectando… (intento ${attempt})`,
          "warn"
        );
        // The old session's audio died with the socket. Clear the mouth and
        // the speaking flag so the avatar doesn't freeze mid-word.
        controllerRef.current?.interrupt();
        setSpeaking(false);
        setThinking(false);
      },
      onReconnected: () => {
        setError(null);
        showNotice("Reconectado", "ok", 2500);
      },
      onVideoStream: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      },
    });

    clientRef.current = client;

    try {
      await client.connect();
      await client.startMic();

      // If the avatar loaded, let TalkingHead own playback + lip-sync.
      // Otherwise fall back to VoiceClient's built-in audio playback.
      const controller = controllerRef.current;
      console.log(
        "[avatar] startCall: controller?",
        !!controller,
        "isReady?",
        controller?.isReady
      );
      if (controller?.isReady) {
        await controller.startStream();
        client.setAudioChunkSink((pcm) => controller.feedAudio(pcm));
        console.log("[avatar] audio sink wired to TalkingHead");
      } else {
        console.warn(
          "[avatar] controller not ready → audio falls back to AudioPlaybackQueue (no lip-sync)"
        );
      }

      setInCall(true);
      // Arms auto-reconnect. Until this is set, an unexpected close is read as
      // a failed *initial* connect and surfaces as an error instead of healing.
      client.markActive();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error al iniciar";
      setError(message);
      client.disconnect();
      clientRef.current = null;
    } finally {
      setLoading(false);
    }
  };

  const endCall = () => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    clientRef.current?.disconnect();
    clientRef.current = null;
    controllerRef.current?.stopStream();
    resetCallState();
  };

  const toggleMic = () => {
    const next = !micEnabled;
    clientRef.current?.setMicEnabled(next);
    setMicEnabled(next);
  };

  const toggleCamera = () => {
    const next = !cameraEnabled;
    clientRef.current?.setCameraEnabled(next);
    setCameraEnabled(next);
  };

  return {
    videoRef,
    avatarContainerRef,
    avatarReady,
    avatarState,
    connection,
    inCall,
    error,
    notice,
    transcripts,
    loading,
    chatOpen,
    micEnabled,
    cameraEnabled,
    setChatOpen,
    toggleMic,
    toggleCamera,
    startCall,
    endCall,
  };
}
