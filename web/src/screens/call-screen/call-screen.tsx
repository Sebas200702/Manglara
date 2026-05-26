import {
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
} from "lucide-react";
import { Avatar } from "../../components/avatar";
import { TranscriptPanel } from "../../components/transcript-panel";
import { useCallScreen } from "./use-call-screen";

const connectionLabels: Record<string, string> = {
  connected: "En llamada",
  connecting: "Conectando…",
  disconnected: "Desconectado",
  error: "Error",
};

export function CallScreen() {
  const {
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
  } = useCallScreen();

  const statusLabel = connectionLabels[connection] ?? connection;

  return (
    <div className=" h-dvh grid grid-cols-[1fr_auto] grid-rows-[auto_1fr_auto] bg-neutral-50">
      <header className="flex h-14 shrink-0 items-center justify-between border-b col-span-2 border-neutral-200 bg-linear-to-r from-brand-50 to-neutral-50 px-4 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-neutral-900">
            Manglara
          </h1>
          <p className="text-xs text-neutral-500">Llamada virtual</p>
        </div>

        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            connection === "connected"
              ? "bg-brand-100 text-brand-700"
              : connection === "connecting"
                ? "bg-status-warning/15 text-neutral-700"
                : "bg-neutral-100 text-neutral-600"
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${
              connection === "connected"
                ? "bg-brand-500"
                : connection === "connecting"
                  ? "animate-pulse bg-status-warning"
                  : "bg-neutral-400"
            }`}
          />
          {statusLabel}
        </span>
      </header>
        <main className={`flex min-w-0 flex-1 flex-col p-3 sm:p-4 ${chatOpen ? "col-span-1" : "col-span-2"}`}>
          <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-2xl bg-radial from-brand-300 to-brand-800">
            <div className="flex flex-1 items-end justify-center">
              <Avatar state={avatarState} />
            </div>

            <div className="absolute bottom-3 left-3 rounded-md bg-neutral-800 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm sm:bottom-4 sm:left-4">
              Manglara
            </div>

            <div className="absolute bottom-3 right-3 aspect-video w-64 overflow-hidden rounded-xl ring-2 ring-white/20">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`size-full bg-brand-100 object-cover ${cameraEnabled ? "" : "hidden"}`}
              />
              {!cameraEnabled && (
                <div className="flex size-full flex-col items-center justify-center gap-2 bg-neutral-800 text-neutral-400">
                  <VideoOff className="size-6" aria-hidden />
                  <span className="text-[10px] font-medium">Cámara apagada</span>
                </div>
              )}
              <div className="absolute bottom-1.5 left-1.5 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                Tú
              </div>
            </div>
          </div>
        </main>

        {chatOpen && (
          <aside className="flex w-72 row-span-2 flex-col border-l border-neutral-200 bg-white sm:w-80">
            <TranscriptPanel entries={transcripts} />
          </aside>
        )}
    

      <footer className={`flex shrink-0 flex-col items-center gap-2 px-4 pb-5 pt-2 ${chatOpen ? "col-span-1" : "col-span-2"}`}>
        {error && (
          <p className="max-w-md text-center text-sm text-status-error">{error}</p>
        )}

        <div className="flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-2 shadow-lg shadow-neutral-900/5">
          {inCall && (
            <>
              <button
                type="button"
                onClick={toggleMic}
                title={micEnabled ? "Silenciar micrófono" : "Activar micrófono"}
                aria-label={micEnabled ? "Silenciar micrófono" : "Activar micrófono"}
                aria-pressed={!micEnabled}
                className={`flex size-11 items-center justify-center rounded-full transition-colors ${
                  micEnabled
                    ? "text-neutral-600 hover:bg-neutral-100"
                    : "bg-status-error text-white hover:bg-status-error/90"
                }`}
              >
                {micEnabled ? (
                  <Mic className="size-5" aria-hidden />
                ) : (
                  <MicOff className="size-5" aria-hidden />
                )}
              </button>

              <button
                type="button"
                onClick={toggleCamera}
                title={cameraEnabled ? "Apagar cámara" : "Encender cámara"}
                aria-label={cameraEnabled ? "Apagar cámara" : "Encender cámara"}
                aria-pressed={!cameraEnabled}
                className={`flex size-11 items-center justify-center rounded-full transition-colors ${
                  cameraEnabled
                    ? "text-neutral-600 hover:bg-neutral-100"
                    : "bg-status-error text-white hover:bg-status-error/90"
                }`}
              >
                {cameraEnabled ? (
                  <Video className="size-5" aria-hidden />
                ) : (
                  <VideoOff className="size-5" aria-hidden />
                )}
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => setChatOpen((v) => !v)}
            title="Transcripción"
            aria-label="Abrir transcripción"
            aria-pressed={chatOpen}
            className={`relative flex size-11 items-center justify-center rounded-full transition-colors ${
              chatOpen
                ? "bg-brand-100 text-brand-700"
                : "text-neutral-600 hover:bg-neutral-100"
            }`}
          >
            <MessageSquare className="size-5" aria-hidden />
            {transcripts.length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-brand-500 text-[10px] font-semibold text-white">
                {transcripts.length}
              </span>
            )}
          </button>

          {!inCall ? (
            <button
              type="button"
              onClick={() => void startCall()}
              disabled={loading}
              className="flex h-11 items-center gap-2 rounded-full bg-brand-600 px-5 text-sm font-medium text-white transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Phone className="size-5" aria-hidden />
              {loading ? "Conectando…" : "Iniciar llamada"}
            </button>
          ) : (
            <button
              type="button"
              onClick={endCall}
              className="flex h-11 items-center gap-2 rounded-full bg-status-error px-5 text-sm font-medium text-white transition-colors hover:bg-status-error/90"
            >
              <PhoneOff className="size-5" aria-hidden />
              Colgar
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
