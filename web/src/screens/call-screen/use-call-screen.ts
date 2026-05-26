import type { AvatarState } from "@manglara/shared";
import { useRef } from "react";
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
  const prependFrame = useCallScreenStore((s) => s.prependFrame);
  const clearTranscripts = useCallScreenStore((s) => s.clearTranscripts);
  const resetCallState = useCallScreenStore((s) => s.resetCallState);

  const avatarState = deriveAvatarState(connection, speaking, thinking);

  const startCall = async () => {
    setError(null);
    setLoading(true);
    clearTranscripts();

    const client = new VoiceClient({
      onConnectionChange: setConnection,
      onTranscript: (role, text) => {
        if (role === "user") setThinking(true);
        appendTranscript(role, text);
      },
      onTurnComplete: () => {
        setThinking(true);
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
      onVideoFrame: (canvas) => {
        prependFrame(canvas.toDataURL("image/jpeg"));
      },
    });

    clientRef.current = client;

    try {
      await client.connect();
      await client.startMic();
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

  const endCall = () => {
    clientRef.current?.disconnect();
    clientRef.current = null;
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
