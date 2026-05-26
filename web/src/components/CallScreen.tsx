import type { AvatarState } from "@manglara/shared";
import { useCallback, useRef, useState } from "react";
import { VoiceClient, type ConnectionState } from "../lib/voice-client.js";
import { Avatar } from "./Avatar.js";
import {
  TranscriptPanel,
  type TranscriptEntry,
} from "./TranscriptPanel.js";
import "./CallScreen.css";

let entryCounter = 0;

function nextEntryId(): string {
  return `t-${++entryCounter}-${Date.now()}`;
}

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

export function CallScreen() {
  const clientRef = useRef<VoiceClient | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [frames, setFrames] = useState<string[]>([]);

  const avatarState = deriveAvatarState(connection, speaking, thinking);

  const appendTranscript = useCallback((role: "user" | "model", text: string) => {
    setTranscripts((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role) {
        return [
          ...prev.slice(0, -1),
          { ...last, text: last.text + text },
        ];
      }
      return [...prev, { id: nextEntryId(), role, text }];
    });
  }, []);

  const startCall = async () => {
    setError(null);
    setLoading(true);
    setTranscripts([]);

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
        const imageData = canvas.toDataURL('image/jpeg');
        setFrames((prev) => {
          const updated = [imageData, ...prev];
          return updated.slice(0, 12);
        });
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
    setInCall(false);
    setSpeaking(false);
    setThinking(false);
    setConnection("disconnected");
    setChatOpen(false);
    setFrames([]);
  };

  return (
    <div className="call-screen">
      <header className="call-screen__header">
        <h1>Manglara</h1>
        <div className="call-screen__header-right">
          <button
            type="button"
            className={`call-screen__chat-toggle ${chatOpen ? "call-screen__chat-toggle--active" : ""}`}
            onClick={() => setChatOpen((v) => !v)}
            title="Transcripción"
          >
            💬
            {transcripts.length > 0 && (
              <span className="call-screen__chat-badge">{transcripts.length}</span>
            )}
          </button>
          <span className={`call-screen__status call-screen__status--${connection}`}>
            {connection === "connected" ? "En llamada" : connection}
          </span>
        </div>
      </header>

      <main className="call-screen__main">
        <div className="call-screen__tiles">
          <div className="call-screen__tile call-screen__tile--manglara">
            <Avatar state={avatarState} />
            <span className="call-screen__tile-label">Manglara</span>
          </div>
          <div className="call-screen__tile call-screen__tile--you">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="call-screen__self-video"
            />
            <span className="call-screen__tile-label">Tú</span>
          </div>
        </div>

        {error && <p className="call-screen__error">{error}</p>}

        <div className="call-screen__actions">
          {!inCall ? (
            <button
              type="button"
              className="call-screen__btn call-screen__btn--primary"
              onClick={() => void startCall()}
              disabled={loading}
            >
              {loading ? "Conectando…" : "Iniciar llamada"}
            </button>
          ) : (
            <button
              type="button"
              className="call-screen__btn call-screen__btn--danger"
              onClick={endCall}
            >
              Colgar
            </button>
          )}
        </div>

        <div className={`call-screen__chat ${chatOpen ? "call-screen__chat--open" : ""}`}>
          <TranscriptPanel entries={transcripts} />
        </div>

        {frames.length > 0 && (
          <div className="call-screen__frames-section">
            <h3 className="call-screen__frames-title">Frames enviados ({frames.length})</h3>
            <div className="call-screen__frames-gallery">
              {frames.map((frame, index) => (
                <img
                  key={index}
                  src={frame}
                  alt={`Frame ${index}`}
                  className="call-screen__frame-thumb"
                />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
