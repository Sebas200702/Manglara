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
  /** Latest startCall, for the dev-only no-mic entry point below. */
  const startCallRef = useRef<((o?: { useMic?: boolean }) => Promise<void>) | null>(null);
  const [avatarReady, setAvatarReady] = useState(false);

  const connection = useCallScreenStore((s) => s.connection);
  const speaking = useCallScreenStore((s) => s.speaking);
  const thinking = useCallScreenStore((s) => s.thinking);
  const inCall = useCallScreenStore((s) => s.inCall);
  const error = useCallScreenStore((s) => s.error);
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
  const setLoading = useCallScreenStore((s) => s.setLoading);
  const setChatOpen = useCallScreenStore((s) => s.setChatOpen);
  const setMicEnabled = useCallScreenStore((s) => s.setMicEnabled);
  const setCameraEnabled = useCallScreenStore((s) => s.setCameraEnabled);
  const appendTranscript = useCallScreenStore((s) => s.appendTranscript);
  const clearTranscripts = useCallScreenStore((s) => s.clearTranscripts);
  const resetCallState = useCallScreenStore((s) => s.resetCallState);

  const avatarState = deriveAvatarState(connection, speaking, thinking);

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

  // Pointer-following gaze is only for the idle lobby. During a call the
  // camera-driven gaze from TalkingHead must remain authoritative.
  useEffect(() => {
    const node = avatarContainerRef.current;
    if (!node || inCall) return;
    const onPointerMove = (e: PointerEvent) => {
      controllerRef.current?.trackPointer(e.clientX, e.clientY);
    };
    node.addEventListener("pointermove", onPointerMove);
    return () => node.removeEventListener("pointermove", onPointerMove);
  }, [inCall]);

  // Lip-sync diagnostics: `window.__callNoMic()` starts a real call with her
  // voice and transcript but no microphone, so turns can be driven by
  // `window.__ask("...")` and the mouth-vs-audio timing measured repeatably.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__callNoMic = () =>
      startCallRef.current?.({ useMic: false });
  }, []);

  // Half-duplex: while Manglara is speaking, suppress the mic so her voice over
  // an external speaker isn't captured and echoed back into a self-reply loop.
  // `speaking` reflects real playback end in both the avatar and fallback paths.
  useEffect(() => {
    clientRef.current?.setInputSuppressed(speaking);
  }, [speaking]);

  /**
   * `useMic: false` connects and streams her voice WITHOUT opening the
   * microphone, for driving real spoken turns from `window.__ask("...")`. That is
   * how lip-sync timing gets measured reproducibly (see VoiceClient.sendText);
   * the normal button path is unchanged and always uses the mic.
   */
  const startCall = async ({ useMic = true }: { useMic?: boolean } = {}) => {
    setError(null);
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
        // Do NOT call setSpeaking(false) here: Gemini has finished generating chunks,
        // but the client has buffered audio still actively playing out of the speakers.
        // onSpeakingChange(false) fires when playback actually finishes, keeping
        // the microphone suppressed to prevent self-interruption (barge-in echo).
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
      onVideoStream: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      },
    });

    clientRef.current = client;

    try {
      await client.connect();
      if (useMic) await client.startMic();

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

      // Lip-sync diagnostics: drive real spoken turns from the console.
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__ask = (text: string) => {
          const ok = client.sendText(text);
          console.log(ok ? `[ask] ${text}` : "[ask] socket no está abierto");
          return ok;
        };
      }

      setInCall(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error al iniciar";
      setError(message);
      client.disconnect();
      clientRef.current = null;
    } finally {
      setLoading(false);
    }
  };

  startCallRef.current = startCall;

  const endCall = () => {
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
