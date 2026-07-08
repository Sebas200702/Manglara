import { Leaf } from "./leaf";

interface LogoProps {
  className?: string;
  /** Renders the wordmark in white for use on dark/photographic surfaces. */
  negative?: boolean;
}

/**
 * "Habilidades Verdes Ya" wordmark lockup — a clean vector rendition of the
 * brand logo: a lime accent bar, navy HABILIDADES, green VERDES with the leaf
 * motif, and the YA pill.
 */
export function Logo({ className, negative = false }: LogoProps) {
  const habilidades = negative ? "text-white/90" : "text-navy-600";
  const verdes = negative ? "text-white" : "text-brand-500";
  const leaf = negative ? "text-white" : "text-brand-600";
  const pill = negative
    ? "bg-white text-accent-500"
    : "bg-brand-300 text-white";

  return (
    <div
      className={`flex items-center gap-2.5 ${className ?? ""}`}
      aria-label="Habilidades Verdes Ya"
    >
      <span
        className={`h-9 w-[5px] shrink-0 rounded-full ${negative ? "bg-white" : "bg-brand-300"}`}
        aria-hidden
      />
      <span className="flex flex-col leading-none">
        <span
          className={`text-[0.62rem] font-bold uppercase tracking-[0.2em] ${habilidades}`}
        >
          Habilidades
        </span>
        <span className="mt-1 flex items-baseline gap-1.5">
          <span
            className={`text-2xl font-extrabold uppercase leading-none tracking-tight ${verdes}`}
          >
            Ver
            <span className="relative inline-flex items-center">
              d
              <Leaf className={`mx-[-1px] size-4 -translate-y-[1px] ${leaf}`} />
              es
            </span>
          </span>
          <span
            className={`translate-y-[-2px] rounded-md px-1.5 py-0.5 text-xs font-extrabold uppercase leading-none ${pill}`}
          >
            Ya
          </span>
        </span>
      </span>
    </div>
  );
}
