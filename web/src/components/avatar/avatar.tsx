import type { AvatarState } from "@manglara/shared";

interface AvatarProps {
  state: AvatarState;
}

const stateRing: Record<AvatarState, string> = {
  idle: "ring-neutral-600/40",
  listening: "ring-brand-200/60",
  thinking: "ring-brand-300/70",
  speaking: "ring-brand-400 animate-speaking-pulse",
};

const stateMouth: Record<AvatarState, string> = {
  idle: "h-1 w-6 rounded-full bg-neutral-500",
  listening: "h-1.5 w-5 rounded-full bg-brand-300",
  thinking: "h-3 w-3 rounded-full bg-brand-400",
  speaking: "h-4 w-7 rounded-b-full rounded-t-sm bg-brand-400",
};

export function Avatar({ state }: AvatarProps) {
  return (
    <div
      className="flex flex-col items-center gap-4"
      aria-label={`Avatar: ${state}`}
    >
     <img src="/avatar.png" alt="Avatar" className="w-100 " />
    </div>
  )
}
