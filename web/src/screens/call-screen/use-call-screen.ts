import type { AvatarState } from "@manglara/shared";
import { useEffect, useRef, useState } from "react";
import type { AvatarStatus } from "../../components/avatar";
import { AvatarController } from "../../components/avatar/avatar-controller";
import { CALL_ERROR_MESSAGES, toUserMessage } from "../../lib/call-errors";
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
  const [avatarStatus, setAvatarStatus] = useState<AvatarStatus>("loading");
  /** False when the call fell back to audio-only (no camera, or camera refused). */
  const [cameraAvailable, setCameraAvailable] = useState(true);
  const [ending, setEnding] = useState(false);

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

    setAvatarStatus("loading");
    const controller = new AvatarController(node, {
      onReady: () => setAvatarStatus("ready"),
      onSpeakingChange: (isSpeaking) => {
        setSpeaking(isSpeaking);
        if (isSpeaking) setThinking(false);
      },
    });
    controllerRef.current = controller;
    // Without the avatar the call still works, only without lip-sync.
    controller.init().catch((err: unknown) => {
      console.error("[avatar] failed to load", err);
      setAvatarStatus("failed");
    });

    return () => {
      controller.dispose();
      controllerRef.current = null;
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

  /** Tears the call down. Leaves the error banner alone. */
  const teardown = () => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    controllerRef.current?.stopStream();
    resetCallState();
    setCameraAvailable(true);
  };

  const startCall = async () => {
    if (loading) return;
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
      onSessionEnded: (message) => {
        endCall();
        setError(message);
      },
      onError: (message) => setError(message),
      onReconnecting: () => {
        // Whatever Manglara was saying went down with the socket.
        controllerRef.current?.interrupt();
        setSpeaking(false);
        setThinking(false);
      },
      onReconnected: () => setError(null),
      onReconnectFailed: () => {
        if (clientRef.current !== client) return;
        teardown();
        setError(CALL_ERROR_MESSAGES.reconnectFailed);
      },
      onVideoStream: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      },
    });

    clientRef.current = client;

    try {
      // Resolves only once the server's AI session is ready: a refusal (busy,
      // origin, upstream failure) rejects here, before the mic is ever opened.
      await client.connect();
      await client.startMic();

      if (!client.hasCamera) {
        setCameraAvailable(false);
        setCameraEnabled(false);
      }

      // If the avatar loaded, let TalkingHead own playback + lip-sync.
      // Otherwise fall back to VoiceClient's built-in audio playback.
      const controller = controllerRef.current;
      if (controller?.isReady) {
        await controller.startStream();
        client.setAudioChunkSink((pcm) => controller.feedAudio(pcm));
      }

      // From here on an unexpected drop auto-reconnects instead of failing.
      client.markActive();
      setInCall(true);
    } catch (err) {
      // Release mic/cam and the socket so nothing is left half-open.
      client.disconnect();
      if (clientRef.current === client) clientRef.current = null;
      setCameraAvailable(true);
      setCameraEnabled(true);
      setError(toUserMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const endCall = () => {
    if (ending) return;
    setEnding(true);
    setError(null);
    // Let "Saliendo…" paint before the (synchronous) teardown runs.
    setTimeout(() => {
      teardown();
      setEnding(false);
    }, 0);
  };

  const dismissError = () => setError(null);

  const toggleMic = () => {
    const next = !micEnabled;
    clientRef.current?.setMicEnabled(next);
    setMicEnabled(next);
  };

  const toggleCamera = () => {
    if (!cameraAvailable) return;
    const next = !cameraEnabled;
    clientRef.current?.setCameraEnabled(next);
    setCameraEnabled(next);
  };

  return {
    videoRef,
    avatarContainerRef,
    avatarStatus,
    avatarState,
    connection,
    inCall,
    error,
    transcripts,
    loading,
    ending,
    chatOpen,
    micEnabled,
    cameraEnabled,
    cameraAvailable,
    setChatOpen,
    toggleMic,
    toggleCamera,
    startCall,
    endCall,
    dismissError,
  };
}
