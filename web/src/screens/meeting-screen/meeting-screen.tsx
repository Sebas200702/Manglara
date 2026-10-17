import {
  Hourglass,
  Link2,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  Pause,
  PhoneOff,
  Play,
  Plug,
  RotateCcw,
  Video,
  VideoOff,
} from "lucide-react";
import type { FormEvent } from "react";
import { Logo } from "../../components/brand/logo";
import { MangroveVideo } from "../../components/brand/mangrove-video";
import { PartnerLogos } from "../../components/brand/partner-logos";
import { SectionNav } from "../../components/section-nav";
import { TranscriptPanel } from "../../components/transcript-panel";
import type { MeetingProvider } from "../../lib/meeting-client";
import {
  PROVIDER_LABELS,
  useMeetingScreen,
  type MeetingStatusTone,
} from "./use-meeting-screen";

const PROVIDER_BADGE: Record<MeetingProvider, string> = {
  teams: "bg-[#5b5fc7]/10 text-[#4b4fb0] border-[#5b5fc7]/30",
  zoom: "bg-[#2d8cff]/10 text-[#1f6fd6] border-[#2d8cff]/30",
  meet: "bg-[#00897b]/10 text-[#00796b] border-[#00897b]/30",
};

const STATUS_CHIP: Record<MeetingStatusTone, { chip: string; dot: string }> = {
  idle: { chip: "bg-neutral-50 text-neutral-600 border-neutral-200", dot: "bg-neutral-300" },
  progress: {
    chip: "bg-status-warning/15 text-neutral-800 border-status-warning/30",
    dot: "bg-status-warning animate-pulse",
  },
  waiting: {
    chip: "bg-accent-50 text-accent-700 border-accent-200",
    dot: "bg-accent-500 animate-pulse",
  },
  live: { chip: "bg-navy-50 text-navy-600 border-navy-200", dot: "bg-navy-400" },
  active: {
    chip: "bg-brand-50 text-brand-700 border-brand-200",
    dot: "bg-brand-500 animate-pulse",
  },
  error: {
    chip: "bg-status-error/10 text-status-error border-status-error/30",
    dot: "bg-status-error",
  },
};

const TRANSCRIPT_LABELS = { user: "Participante", model: "Manglara" } as const;

export function MeetingScreen() {
  const {
    input,
    provider,
    bridgeState,
    brainState,
    micOn,
    camOn,
    error,
    transcripts,
    connecting,
    busy,
    eventsConnected,
    chatOpen,
    inMeeting,
    sessionLive,
    status,
    setInput,
    setChatOpen,
    connect,
    startBrain,
    stopBrain,
    toggleMic,
    toggleCam,
    leave,
    dismiss,
  } = useMeetingScreen();

  const brainOn = brainState === "active" || brainState === "starting";
  const brainBusy = brainState === "starting" || brainState === "stopping";
  const finished = bridgeState === "closed" || bridgeState === "error";
  const chip = STATUS_CHIP[status.tone];

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!sessionLive) void connect();
  };

  return (
    <div className="h-dvh flex flex-col bg-[#f8faf6] font-montserrat overflow-hidden relative">
      {/* Header */}
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-neutral-200/80 bg-white px-4 sm:px-6 z-20 shadow-2xs">
        <div className="flex items-center gap-3 min-w-0">
          <Logo />
          <span className="h-5 w-[1px] bg-neutral-200 hidden md:inline" />
          <span className="text-xs font-bold text-neutral-400 uppercase tracking-widest mt-0.5 hidden md:inline truncate">
            Live Meeting con Manglara
          </span>
        </div>

        <div className="flex items-center gap-2">
          <SectionNav />
          <span
            className={`hidden sm:inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold transition-all border ${chip.chip}`}
          >
            <span className={`size-2 rounded-full ${chip.dot}`} />
            {status.label}
          </span>
        </div>
      </header>

      {/* Workspace */}
      <div className="flex-1 flex overflow-hidden min-h-0 relative">
        <main className="relative flex flex-col p-4 flex-1 min-w-0">
          <div className="relative flex-1 overflow-hidden rounded-3xl border border-brand-200/60 shadow-inner bg-linear-to-b from-[#f7f9ec] via-[#dde8b7]/40 to-[#ccd63c]/15">
            <MangroveVideo />
            <div className="absolute inset-0 bg-white/55 backdrop-blur-[2px] z-0" />

            <div className="relative z-10 flex h-full flex-col items-center justify-center gap-5 overflow-y-auto px-4 py-6">
              {/* Connection card */}
              <form
                onSubmit={onSubmit}
                className="w-full max-w-xl rounded-3xl border border-brand-200/70 bg-white/95 p-5 shadow-xl"
              >
                <div className="flex items-center justify-between gap-3">
                  <h1 className="text-sm font-extrabold uppercase tracking-wider text-navy-600">
                    Conectar a una reunión
                  </h1>
                  <span
                    className={`inline-flex sm:hidden items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${chip.chip}`}
                  >
                    <span className={`size-1.5 rounded-full ${chip.dot}`} />
                    {status.label}
                  </span>
                </div>
                <p className="mt-1 text-xs font-medium text-neutral-500">
                  Pega el link o el ID de una reunión de Microsoft Teams, Zoom o Google Meet.
                </p>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <label className="relative flex-1">
                    <span className="sr-only">Link o ID de la reunión</span>
                    <Link2
                      className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-neutral-400"
                      aria-hidden
                    />
                    <input
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      disabled={sessionLive}
                      maxLength={500}
                      placeholder="https://zoom.us/j/… · meet.google.com/abc-defg-hij"
                      className="h-11 w-full rounded-full border border-neutral-200 bg-neutral-50 pl-9 pr-4 text-sm font-medium text-navy-900 outline-none transition-all focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-200 disabled:opacity-70"
                    />
                  </label>

                  {!sessionLive && !finished && (
                    <button
                      type="submit"
                      disabled={connecting || !input.trim()}
                      className="flex h-11 items-center justify-center gap-2 rounded-full bg-brand-500 px-5 text-xs font-black uppercase tracking-wide text-white shadow-md shadow-brand-500/25 transition-all hover:scale-105 hover:bg-brand-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100 cursor-pointer"
                    >
                      {connecting ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                      ) : (
                        <Plug className="size-4" aria-hidden />
                      )}
                      {connecting ? "Conectando…" : "Conectar"}
                    </button>
                  )}

                  {finished && (
                    <button
                      type="button"
                      onClick={dismiss}
                      className="flex h-11 items-center justify-center gap-2 rounded-full border border-neutral-200 bg-white px-5 text-xs font-black uppercase tracking-wide text-navy-600 shadow-2xs transition-all hover:scale-105 hover:bg-neutral-50 active:scale-95 cursor-pointer"
                    >
                      <RotateCcw className="size-4" aria-hidden />
                      Nueva reunión
                    </button>
                  )}
                </div>

                <div className="mt-3 flex min-h-6 flex-wrap items-center gap-2">
                  {provider ? (
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${PROVIDER_BADGE[provider]}`}
                    >
                      {PROVIDER_LABELS[provider]}
                    </span>
                  ) : input.trim() ? (
                    <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-0.5 text-[11px] font-bold text-neutral-500">
                      Proveedor no reconocido
                    </span>
                  ) : null}
                  {sessionLive && !eventsConnected && !connecting && (
                    <span className="text-[11px] font-semibold text-neutral-500">
                      Reconectando con el servidor…
                    </span>
                  )}
                </div>
              </form>

              {error && (
                <p
                  role="alert"
                  className="w-full max-w-xl rounded-2xl border border-status-error/20 bg-status-error px-4 py-2.5 text-center text-xs font-bold text-white shadow-lg"
                >
                  {error}
                </p>
              )}

              {bridgeState === "lobby" && (
                <div className="flex w-full max-w-xl items-center gap-3 rounded-2xl border border-accent-200 bg-accent-50/95 px-4 py-3 text-xs font-semibold text-accent-800 shadow-md">
                  <Hourglass className="size-4 shrink-0" aria-hidden />
                  Admisión pendiente: el anfitrión debe admitir a Manglara desde la sala de espera.
                </div>
              )}

              {(bridgeState === "launching" || bridgeState === "joining") && (
                <div className="flex items-center gap-2 text-xs font-semibold text-navy-600">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Manglara se está uniendo a la reunión…
                </div>
              )}

              {/* Control panel (only inside the meeting) */}
              {inMeeting && (
                <section
                  aria-label="Controles de Manglara en la reunión"
                  className="flex w-full max-w-xl flex-col items-center gap-4 rounded-3xl border border-brand-200/70 bg-white/95 p-5 shadow-xl"
                >
                  <p className="text-center text-xs font-medium text-neutral-500">
                    {brainOn
                      ? "Manglara está escuchando a los participantes y responde en la reunión."
                      : "Manglara está en la reunión con su avatar, pero dormida: no escucha ni habla."}
                  </p>

                  {!brainOn ? (
                    <button
                      type="button"
                      onClick={() => void startBrain()}
                      disabled={busy || brainBusy}
                      className="flex h-14 w-full items-center justify-center gap-3 rounded-full bg-brand-500 px-6 text-sm font-black uppercase tracking-wide text-white shadow-lg shadow-brand-500/30 transition-all hover:scale-[1.02] hover:bg-brand-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                    >
                      {busy || brainBusy ? (
                        <Loader2 className="size-5 animate-spin" aria-hidden />
                      ) : (
                        <Play className="size-5 fill-current" aria-hidden />
                      )}
                      Iniciar Manglara Meeting Live
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void stopBrain()}
                      disabled={busy || brainBusy}
                      className="flex h-14 w-full items-center justify-center gap-3 rounded-full bg-navy-600 px-6 text-sm font-black uppercase tracking-wide text-white shadow-lg shadow-navy-600/30 transition-all hover:scale-[1.02] hover:bg-navy-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                    >
                      {brainBusy ? (
                        <Loader2 className="size-5 animate-spin" aria-hidden />
                      ) : (
                        <Pause className="size-5 fill-current" aria-hidden />
                      )}
                      Apagar interacción
                    </button>
                  )}

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void toggleMic()}
                      disabled={busy}
                      title={micOn ? "Silenciar a Manglara" : "Activar la voz de Manglara"}
                      aria-label={micOn ? "Silenciar a Manglara" : "Activar la voz de Manglara"}
                      className={`flex size-11 items-center justify-center rounded-full transition-all cursor-pointer hover:scale-105 active:scale-95 disabled:opacity-60 ${
                        micOn
                          ? "bg-neutral-50 border border-neutral-200 text-navy-600 hover:bg-neutral-100 shadow-2xs"
                          : "bg-status-error text-white hover:bg-status-error/90 shadow-md shadow-status-error/20"
                      }`}
                    >
                      {micOn ? <Mic className="size-5" aria-hidden /> : <MicOff className="size-5" aria-hidden />}
                    </button>

                    <button
                      type="button"
                      onClick={() => void toggleCam()}
                      disabled={busy}
                      title={camOn ? "Apagar cámara de Manglara" : "Encender cámara de Manglara"}
                      aria-label={camOn ? "Apagar cámara de Manglara" : "Encender cámara de Manglara"}
                      className={`flex size-11 items-center justify-center rounded-full transition-all cursor-pointer hover:scale-105 active:scale-95 disabled:opacity-60 ${
                        camOn
                          ? "bg-neutral-50 border border-neutral-200 text-navy-600 hover:bg-neutral-100 shadow-2xs"
                          : "bg-status-error text-white hover:bg-status-error/90 shadow-md shadow-status-error/20"
                      }`}
                    >
                      {camOn ? <Video className="size-5" aria-hidden /> : <VideoOff className="size-5" aria-hidden />}
                    </button>

                    <span className="h-6 w-[1px] bg-neutral-200" />

                    <button
                      type="button"
                      onClick={() => void leave()}
                      disabled={busy}
                      className="flex h-11 items-center gap-2 rounded-full bg-status-error px-5 text-xs font-black uppercase tracking-wide text-white shadow-md shadow-status-error/25 transition-all hover:scale-105 hover:bg-status-error/90 active:scale-95 disabled:opacity-60 cursor-pointer"
                    >
                      <PhoneOff className="size-4 shrink-0" aria-hidden />
                      Desconectar
                    </button>
                  </div>
                </section>
              )}

              {/* Leaving the lobby / joining also needs an exit */}
              {sessionLive && !inMeeting && bridgeState !== "leaving" && !connecting && (
                <button
                  type="button"
                  onClick={() => void leave()}
                  disabled={busy}
                  className="flex h-10 items-center gap-2 rounded-full border border-status-error/30 bg-white/95 px-4 text-xs font-bold text-status-error shadow-2xs transition-all hover:bg-status-error hover:text-white disabled:opacity-60 cursor-pointer"
                >
                  <PhoneOff className="size-4" aria-hidden />
                  Cancelar
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => setChatOpen((v) => !v)}
              title="Transcripción"
              aria-label="Mostrar u ocultar la transcripción"
              className={`absolute right-4 top-4 z-40 flex size-10 items-center justify-center rounded-full transition-all cursor-pointer hover:scale-105 active:scale-95 ${
                chatOpen
                  ? "bg-brand-500 text-white shadow-md shadow-brand-500/20"
                  : "bg-white border border-neutral-200 text-navy-600 shadow-2xs"
              }`}
            >
              <MessageSquare className="size-5" aria-hidden />
              {transcripts.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex size-4.5 items-center justify-center rounded-full bg-accent-500 text-[8.5px] font-black text-white border border-white">
                  {transcripts.length}
                </span>
              )}
            </button>
          </div>
        </main>

        {chatOpen && (
          <aside className="absolute inset-y-0 right-0 flex w-full sm:w-80 md:relative shrink-0 flex-col border-l border-neutral-200/80 bg-white z-30 h-full overflow-hidden animate-panel-slide-in">
            <TranscriptPanel
              entries={transcripts}
              labels={TRANSCRIPT_LABELS}
              emptyText="La transcripción aparecerá aquí cuando actives a Manglara en la reunión."
            />
          </aside>
        )}
      </div>

      <PartnerLogos className="bg-white border-t border-neutral-200/80 py-3.5 shrink-0 z-10" />
    </div>
  );
}
