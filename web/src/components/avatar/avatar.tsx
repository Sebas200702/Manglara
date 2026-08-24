import type { AvatarState } from "@manglara/shared";
import type { RefObject } from "react";

interface AvatarProps {
  state: AvatarState;
  /** Container the TalkingHead canvas mounts into (owned by useCallScreen). */
  containerRef: RefObject<HTMLDivElement | null>;
}

export function Avatar({ state, containerRef }: AvatarProps) {
  return (
    <div className="relative h-full w-full" aria-label={`Avatar: ${state}`}>
      <div
        ref={containerRef}
        className="absolute inset-0 [&>canvas]:!h-full [&>canvas]:!w-full"
      />
    </div>
  );
}
