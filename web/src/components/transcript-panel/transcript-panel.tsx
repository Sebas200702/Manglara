import type { TranscriptPanelProps } from "./transcript-panel-types";

export function TranscriptPanel({ entries }: TranscriptPanelProps) {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="shrink-0 border-b border-neutral-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-neutral-900">Conversación</h2>
        <p className="mt-0.5 text-xs text-neutral-500">Transcripción en vivo</p>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {entries.length === 0 ? (
          <p className="px-1 py-8 text-center text-xs text-neutral-500 leading-relaxed font-medium">
            La transcripción aparecerá aquí cuando empieces a hablar con Manglaria.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={`rounded-2xl px-3.5 py-2.5 border transition-all duration-300 ${
                  entry.role === "user"
                    ? "ml-6 bg-accent-50/60 border-accent-100 text-navy-900 shadow-2xs"
                    : "mr-6 bg-brand-50/60 border-brand-100 text-navy-900 shadow-2xs"
                }`}
              >
                <span
                  className={`mb-1 block text-[9px] font-extrabold uppercase tracking-widest ${
                    entry.role === "user" ? "text-accent-600" : "text-brand-600"
                  }`}
                >
                  {entry.role === "user" ? "Tú" : "Manglaria"}
                </span>
                <p className="text-xs leading-relaxed font-medium">{entry.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
