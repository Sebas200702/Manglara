import type { AvatarState } from "@manglara/shared";
import { Loader2, UserRound } from "lucide-react";
import type { RefObject } from "react";

export type AvatarStatus = "loading" | "ready" | "failed";

const stateLabels: Record<AvatarState, string> = {
  idle: "en espera",
  listening: "escuchando",
  thinking: "pensando",
  speaking: "hablando",
};

interface AvatarProps {
  state: AvatarState;
  /** Whether the 3D model is still downloading, ready, or failed to load. */
  status?: AvatarStatus;
  /** Container the TalkingHead canvas mounts into (owned by useCallScreen). */
  containerRef: RefObject<HTMLDivElement | null>;
}

export function Avatar({ state, status = "ready", containerRef }: AvatarProps) {
  return (
    <div
      className="relative h-full w-full"
      role="img"
      aria-label={`Manglara, ${stateLabels[state]}`}
      aria-busy={status === "loading"}
    >
      <div
        ref={containerRef}
        className="absolute inset-0 [&>canvas]:h-full! [&>canvas]:w-full!"
      />

      {status === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-brand-700">
          <Loader2 className="size-8 animate-spin" aria-hidden />
          <span className="text-xs font-bold">Preparando a Manglara…</span>
        </div>
      )}

      {status === "failed" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <span className="flex size-24 items-center justify-center rounded-full border border-brand-200 bg-white/80 text-brand-600 shadow-inner">
            <UserRound className="size-12" aria-hidden />
          </span>
          <span className="max-w-xs text-xs font-medium text-neutral-600">
            No pudimos cargar la imagen de Manglara, pero puedes hablar con ella igual.
          </span>
        </div>
      )}
    </div>
  );
}
