import type { AvatarState } from "@manglara/shared";
import type { RefObject } from "react";

interface AvatarProps {
  state: AvatarState;
  /** Container the TalkingHead canvas mounts into (owned by useCallScreen). */
  containerRef: RefObject<HTMLDivElement | null>;
  /** True once the 3D avatar has loaded; until then the static image shows. */
  ready: boolean;
}

export function Avatar({ state, containerRef, ready }: AvatarProps) {
  return (
    <div className="relative h-full w-full" aria-label={`Avatar: ${state}`}>
      <div
        ref={containerRef}
        className="absolute inset-0 [&>canvas]:!h-full [&>canvas]:!w-full"
      />
      {!ready && (
        <img
          src="/avatar.png"
          alt="Avatar"
          className="absolute left-1/2 top-1/2 w-100 -translate-x-1/2 -translate-y-1/2"
        />
      )}
    </div>
  );
}
