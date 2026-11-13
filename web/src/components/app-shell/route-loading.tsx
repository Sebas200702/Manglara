import { Loader2 } from "lucide-react";

/** Minimal fallback shown while a lazily loaded route chunk downloads. */
export function RouteLoading() {
  return (
    <div
      role="status"
      className="flex min-h-dvh items-center justify-center gap-2 bg-neutral-50 font-sans text-sm font-semibold text-navy-600"
    >
      <Loader2 className="size-5 animate-spin" aria-hidden />
      Cargando…
    </div>
  );
}
