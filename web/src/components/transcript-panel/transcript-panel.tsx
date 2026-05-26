import type { TranscriptPanelProps } from "./transcript-panel-types";

export function TranscriptPanel({ entries }: TranscriptPanelProps) {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="shrink-0 border-b border-neutral-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-neutral-900">Conversación</h2>
        <p className="mt-0.5 text-xs text-neutral-500">Transcripción en vivo</p>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 font-[family-name:var(--font-inter)]">
        {entries.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-neutral-500">
            La transcripción aparecerá aquí cuando empieces a hablar.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={`rounded-xl px-3 py-2.5 ${
                  entry.role === "user"
                    ? "ml-4 bg-brand-50 text-neutral-800"
                    : "mr-4 bg-neutral-100 text-neutral-800"
                }`}
              >
                <span
                  className={`mb-1 block text-[11px] font-medium uppercase tracking-wide ${
                    entry.role === "user" ? "text-brand-600" : "text-neutral-500"
                  }`}
                >
                  {entry.role === "user" ? "Tú" : "Manglara"}
                </span>
                <p className="text-sm leading-relaxed">{entry.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
