import type { AvatarState } from "@manglara/shared";
import "./Avatar.css";

interface AvatarProps {
  state: AvatarState;
}

export function Avatar({ state }: AvatarProps) {
  return (
    <div className={`avatar avatar--${state}`} aria-label={`Avatar: ${state}`}>
      <div className="avatar__ring" aria-hidden />
      <div className="avatar__face">
        <div className="avatar__eyes">
          <span />
          <span />
        </div>
        <div className="avatar__mouth" />
      </div>
      <p className="avatar__label">
        {state === "idle" && "Desconectado"}
        {state === "listening" && "Escuchando"}
        {state === "thinking" && "Pensando"}
        {state === "speaking" && "Hablando"}
      </p>
    </div>
  );
}
