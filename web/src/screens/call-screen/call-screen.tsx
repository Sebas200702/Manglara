import {
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Info,
} from "lucide-react";
import { useState } from "react";
import { Avatar } from "../../components/avatar";
import { TranscriptPanel } from "../../components/transcript-panel";
import { useCallScreen } from "./use-call-screen";
import { Logo } from "../../components/brand/logo";
import { PartnerLogos } from "../../components/brand/partner-logos";

const connectionLabels: Record<string, string> = {
  connected: "En llamada",
  connecting: "Conectando…",
  disconnected: "Desconectado",
  error: "Error",
};

export function CallScreen() {
  const {
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
  } = useCallScreen();

  const statusLabel = connectionLabels[connection] ?? connection;

  return (
    <div className="h-dvh flex flex-col bg-[#f8faf6] font-montserrat overflow-hidden select-none relative">

      {/* Header Bar */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-neutral-200/80 bg-white px-4 sm:px-6 z-20 shadow-2xs">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="h-5 w-[1px] bg-neutral-200 hidden sm:inline" />
          <span className="text-xs font-bold text-neutral-400 uppercase tracking-widest mt-0.5 hidden sm:inline">
            Llamada virtual con Manglara
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Status Indicator */}
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold transition-all border ${
              inCall
                ? connection === "connected"
                  ? "bg-brand-55 text-brand-700 border-brand-200"
                  : "bg-status-warning/15 text-neutral-800 border-status-warning/30"
                : "bg-neutral-50 text-neutral-600 border-neutral-200"
            }`}
          >
            <span
              className={`size-2 rounded-full ${
                inCall
                  ? connection === "connected"
                    ? "bg-brand-500 animate-pulse"
                    : "animate-pulse bg-status-warning"
                  : "bg-brand-400"
              }`}
            />
            {inCall ? statusLabel : "Listo para hablar"}
          </span>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="flex-1 flex overflow-hidden min-h-0 relative">

        {/* Call Content Area */}
        <main className={`relative flex flex-col p-4 flex-1 ${chatOpen ? "col-span-1" : "col-span-2"}`}>
          <div className="relative flex-1 overflow-hidden rounded-3xl bg-linear-to-b from-[#f7f9ec] via-[#dde8b7]/40 to-[#ccd63c]/15 border border-brand-200/60 shadow-inner">

            {/* Organic Landscape Background */}
            <svg viewBox="0 0 1000 300" preserveAspectRatio="none" className="absolute bottom-0 left-0 w-full h-40 sm:h-56 pointer-events-none opacity-35 select-none z-0" aria-hidden>
              {/* Background Hills */}
              <path d="M0,220 C200,160 400,280 600,200 C800,120 900,240 1000,180 L1000,300 L0,300 Z" fill="#dde8b7" />
              {/* Foreground Hills */}
              <path d="M0,260 C150,220 300,280 500,230 C700,180 850,250 1000,220 L1000,300 L0,300 Z" fill="#9ebf1b" opacity="0.5" />
              {/* Wind Turbine 1 (Left) */}
              <g transform="translate(160, 80)" stroke="#9ebf1b" strokeWidth="2" fill="none" opacity="0.65">
                <line x1="0" y1="0" x2="0" y2="120" strokeWidth="3" />
                <g className="animate-spin [animation-duration:18s]" style={{ transformOrigin: '0px 0px' }}>
                  <line x1="0" y1="0" x2="0" y2="-40" />
                  <line x1="0" y1="0" x2="35" y2="20" />
                  <line x1="0" y1="0" x2="-35" y2="20" />
                </g>
              </g>
              {/* Wind Turbine 2 (Right) */}
              <g transform="translate(820, 110)" stroke="#ccd63c" strokeWidth="1.5" fill="none" opacity="0.55">
                <line x1="0" y1="0" x2="0" y2="90" strokeWidth="2.5" />
                <g className="animate-spin [animation-duration:12s]" style={{ transformOrigin: '0px 0px' }}>
                  <line x1="0" y1="0" x2="0" y2="-30" />
                  <line x1="0" y1="0" x2="26" y2="15" />
                  <line x1="0" y1="0" x2="-26" y2="15" />
                </g>
              </g>
            </svg>

            {/* Avatar 3D Component */}
            <div className="size-full z-10 relative">
              <Avatar
                state={avatarState}
                containerRef={avatarContainerRef}
                ready={avatarReady}
              />
            </div>

            {/* Assistant floating label */}
            <div className="absolute top-4 left-4 rounded-xl bg-navy-600/90 backdrop-blur-md px-3.5 py-1.5 text-xs font-extrabold text-white border border-navy-500/20 shadow-lg tracking-wide uppercase z-20">
              Manglara
            </div>

            {/* Webcam video preview overlay */}
            <div
              className={`absolute bottom-4 right-4 aspect-video w-36 sm:w-52 overflow-hidden rounded-2xl ring-4 ring-accent-400 shadow-2xl z-20 bg-white transition-all duration-300 ${
                inCall ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-90 pointer-events-none"
              }`}
            >
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`size-full object-cover bg-neutral-100 ${cameraEnabled ? "" : "hidden"}`}
              />
              {!cameraEnabled && (
                <div className="flex size-full flex-col items-center justify-center gap-1 bg-neutral-150 text-neutral-400">
                  <VideoOff className="size-5" aria-hidden />
                  <span className="text-[8px] font-extrabold uppercase tracking-wider">Cámara apagada</span>
                </div>
              )}
              <div className="absolute bottom-1.5 left-1.5 rounded bg-navy-600/80 backdrop-blur-md px-2 py-0.5 text-[8px] font-bold text-white border border-navy-500/10">
                Tú
              </div>
            </div>

            {/* Floating Info Overlay Card if not in call */}
            {!inCall && (
              <div className="absolute top-4 right-4 max-w-xs bg-white/95 backdrop-blur-md border border-brand-200/60 rounded-2xl p-4 shadow-xl text-left space-y-2 hidden md:block z-20">
                <h4 className="text-[10px] font-black text-brand-600 uppercase tracking-widest flex items-center gap-1">
                  <Info className="size-3 text-brand-500" />
                  ¿Cómo te ayuda Manglara?
                </h4>
                <p className="text-[11px] text-neutral-600 leading-relaxed font-semibold">
                  Manglara es la asistente oficial de <strong>Habilidades Verdes Ya</strong>. Inicia la llamada para consultarle dudas sobre el Currículo Verde, los stands interactivos del lanzamiento y el material didáctico.
                </p>
              </div>
            )}
          </div>

          {/* Floating controls dock overlay (aligned to bottom) */}
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3 w-full max-w-sm sm:max-w-md px-4 z-20">
            {error && (
              <p className="text-center text-xs text-white bg-status-error px-4 py-2 rounded-xl shadow-lg border border-status-error/20 font-bold animate-bounce">
                {error}
              </p>
            )}

            <div className="flex items-center gap-3 rounded-full border border-brand-200/50 bg-white/90 backdrop-blur-md px-5 py-3 shadow-xl transition-all">
              {/* Mic toggle */}
              <button
                type="button"
                onClick={toggleMic}
                title={micEnabled ? "Silenciar micrófono" : "Activar micrófono"}
                aria-label={micEnabled ? "Silenciar micrófono" : "Activar micrófono"}
                className={`flex size-11 items-center justify-center rounded-full transition-all cursor-pointer hover:scale-105 active:scale-95 ${
                  micEnabled
                    ? "bg-neutral-50 border border-neutral-200 text-navy-600 hover:bg-neutral-100 shadow-2xs"
                    : "bg-status-error text-white hover:bg-status-error/90 shadow-md shadow-status-error/20"
                }`}
              >
                {micEnabled ? (
                  <Mic className="size-5" aria-hidden />
                ) : (
                  <MicOff className="size-5" aria-hidden />
                )}
              </button>

              {/* Camera toggle */}
              <button
                type="button"
                onClick={toggleCamera}
                title={cameraEnabled ? "Apagar cámara" : "Encender cámara"}
                aria-label={cameraEnabled ? "Apagar cámara" : "Encender cámara"}
                className={`flex size-11 items-center justify-center rounded-full transition-all cursor-pointer hover:scale-105 active:scale-95 ${
                  cameraEnabled
                    ? "bg-neutral-50 border border-neutral-200 text-navy-600 hover:bg-neutral-100 shadow-2xs"
                    : "bg-status-error text-white hover:bg-status-error/90 shadow-md shadow-status-error/20"
                }`}
              >
                {cameraEnabled ? (
                  <Video className="size-5" aria-hidden />
                ) : (
                  <VideoOff className="size-5" aria-hidden />
                )}
              </button>

              {/* Chat panel toggler */}
              <button
                type="button"
                onClick={() => setChatOpen((v) => !v)}
                title="Transcripción"
                aria-label="Abrir transcripción"
                className={`relative flex size-11 items-center justify-center rounded-full transition-all cursor-pointer hover:scale-105 active:scale-95 ${
                  chatOpen
                    ? "bg-brand-500 text-white border border-brand-400/20 shadow-md shadow-brand-500/20"
                    : "bg-neutral-50 border border-neutral-200 text-navy-600 hover:bg-neutral-100 shadow-2xs"
                }`}
              >
                <MessageSquare className="size-5" aria-hidden />
                {transcripts.length > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex size-4.5 items-center justify-center rounded-full bg-accent-500 text-[8.5px] font-black text-white border border-white">
                    {transcripts.length}
                  </span>
                )}
              </button>

              <span className="h-6 w-[1px] bg-neutral-200" />

              {/* Call Join/End Action Button */}
              {!inCall ? (
                <button
                  type="button"
                  onClick={() => void startCall()}
                  disabled={loading}
                  className="flex h-11 items-center gap-2 rounded-full bg-brand-500 hover:bg-brand-600 px-5 text-xs font-black text-white transition-all cursor-pointer hover:scale-105 active:scale-95 shadow-md shadow-brand-500/25 tracking-wide uppercase disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <Phone className="size-4 shrink-0 animate-bounce" />
                  <span>{loading ? "Conectando…" : "Llamar"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={endCall}
                  className="flex h-11 items-center gap-2 rounded-full bg-status-error hover:bg-status-error/90 px-5 text-xs font-black text-white transition-all cursor-pointer hover:scale-105 active:scale-95 shadow-md shadow-status-error/25 tracking-wide uppercase"
                >
                  <PhoneOff className="size-4 shrink-0" />
                  <span>Colgar</span>
                </button>
              )}
            </div>
          </div>
        </main>

        {/* Sidebar Transcript Panel */}
        {chatOpen && (
          <aside className="flex w-72 md:w-80 shrink-0 flex-col border-l border-neutral-200/80 bg-white z-20 relative h-full overflow-hidden animate-panel-slide-in">
            <TranscriptPanel entries={transcripts} />
          </aside>
        )}

      </div>

      {/* Footer Partner logos */}
      <PartnerLogos className="bg-white border-t border-neutral-200/80 py-3.5 shrink-0 z-10" />
    </div>
  );
}
