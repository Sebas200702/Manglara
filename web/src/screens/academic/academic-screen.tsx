import { ArrowUp, Leaf, MessageCircle, Mic, X } from "lucide-react";
import { useRef } from "react";
import { Avatar } from "../../components/avatar/avatar";
import { MangroveVideo } from "../../components/brand/mangrove-video";
import { useAcademicTutor } from "./use-academic-tutor";
import "./academic-screen.css";
import "./academic-conversation.css";
import "./academic-panel.css";

/** Tutoría en el manglar: avatar protagonista y conversación dentro de Moodle. */
export const AcademicScreen = () => {
  const tutor = useAcademicTutor();
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <main className={`academic-studio${tutor.panelLayout ? " is-lesson-panel" : ""}`}>
      {tutor.panelLayout && <h1 className="sr-only">Manglara · {tutor.academic?.lessonTitle}</h1>}
      <header hidden={tutor.panelLayout} className="academic-studio-header">
        <div className="academic-studio-title">
          <Leaf size={20} aria-hidden="true" />
          <h1>Manglara · {tutor.academic?.lessonTitle ?? "Validando acceso"}</h1>
          {tutor.academic?.mode === "instructor" && (
            <span>Modo de prueba docente.</span>
          )}
        </div>
        <button type="button" className="academic-exit" onClick={tutor.close}>
          <span>Finalizar tutoría</span>
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      {tutor.error && (
        <p role="alert" className="academic-alert">
          {tutor.error}
        </p>
      )}
      <div className="academic-workspace">
        <section aria-label="Avatar Manglara" className="academic-stage">
          <MangroveVideo />
          <div className="academic-avatar">
            <Avatar
              state={
                tutor.speaking
                  ? "speaking"
                  : tutor.connected
                    ? "listening"
                    : "idle"
              }
              containerRef={tutor.container}
            />
          </div>
          <div className="academic-stage-label">
            <span className={tutor.connected ? "is-connected" : ""} />
            Tu guía en el manglar
          </div>
          <span
            role="status"
            aria-label="Estado del avatar"
            className="sr-only"
          >
            {tutor.avatarReady
              ? "Avatar listo"
              : tutor.avatarError
                ? "Avatar no disponible"
                : "Cargando avatar"}
          </span>
          {!tutor.avatarReady && (
            <p className="academic-avatar-loading" role="status">
              {tutor.avatarError
                ? "Avatar no disponible. Puedes continuar por texto."
                : "Preparando el manglar…"}
            </p>
          )}
          {tutor.canStart && !tutor.connected && (
            <div
              className="academic-manglara-cta"
              role="group"
              aria-label="Acceso rápido a Manglara"
            >
              <button
                type="button"
                className="academic-manglara-fab academic-manglara-fab--voice"
                onClick={() => {
                  void tutor.start(true);
                }}
                aria-label="Hablar con Manglara por voz"
              >
                <Mic size={18} aria-hidden="true" />
                <span>Hablar con Manglara</span>
              </button>
              <button
                type="button"
                className="academic-manglara-fab academic-manglara-fab--text"
                onClick={() => {
                  void tutor.start(false);
                }}
                aria-label="Chatear con Manglara por texto"
              >
                <MessageCircle size={18} aria-hidden="true" />
                <span>Preguntar por texto</span>
              </button>
            </div>
          )}
        </section>
        <section aria-label="Conversación" className="academic-conversation">
          <header className="academic-chat-heading">
            <div>
              <span className="academic-eyebrow">APRENDEMOS CONVERSANDO</span>
              <h2>Tu conversación</h2>
            </div>
            <MessageCircle size={20} aria-hidden="true" />
          </header>
          <p
            role="status"
            aria-label="Estado de tutoría"
            className="academic-session-state"
          >
            <span className={tutor.connected ? "is-connected" : ""} />
            {tutor.connecting
              ? "Conectando tutoría…"
              : tutor.connected
                ? tutor.speaking
                  ? "Manglara está hablando…"
                  : tutor.responding
                    ? "Manglara está preparando tu respuesta…"
                    : tutor.hasResponse
                      ? "Respuesta completada"
                      : "Tutoría conectada"
                : "Micrófono apagado"}
          </p>
          <div
            ref={tutor.conversation}
            role="log"
            aria-label="Mensajes de tutoría"
            aria-live="polite"
            className="academic-messages"
          >
            {tutor.messages.length === 0 && (
              <div className="academic-empty">
                <span className="academic-empty-leaf">
                  <Leaf size={26} aria-hidden="true" />
                </span>
                <h3>
                  Las buenas preguntas
                  <br /> abren caminos.
                </h3>
                <p>
                  Pregunta por voz o escribe. Manglara te responde hablando y
                  por escrito.
                </p>
                <p className="academic-prompt">
                  ¿Cómo puedo aplicar esta lección a mi vida cotidiana?
                </p>
              </div>
            )}
            {tutor.messages.map((message, i) => (
              <div
                key={`${i}-${message.role}`}
                className={`academic-message ${message.role === "user" ? "academic-message-user" : ""}`}
              >
                <strong>{message.role === "user" ? "Tú" : "Manglara"}:</strong>
                <p>{message.text}</p>
              </div>
            ))}
          </div>
          <form
            className="academic-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (input.current && tutor.send(input.current.value))
                input.current.value = "";
            }}
          >
            <label htmlFor="academic-message" className="sr-only">
              Tu pregunta
            </label>
            <input
              id="academic-message"
              ref={input}
              maxLength={4000}
              disabled={!tutor.connected || tutor.responding || tutor.speaking}
              placeholder="Escribe tu pregunta…"
            />
            <button
              type="submit"
              aria-label="Enviar"
              disabled={!tutor.connected || tutor.responding || tutor.speaking}
            >
              <ArrowUp size={20} aria-hidden="true" />
            </button>
          </form>
          <details className="academic-help">
            <summary>Sobre esta práctica</summary>
            <p>
              Practica esta lección y entrega evidencia en Moodle. La
              conversación no asigna notas ni se guarda al cerrar. En modo texto
              el micrófono permanece apagado. Sin cámara.
            </p>
          </details>
        </section>
      </div>
    </main>
  );
};
