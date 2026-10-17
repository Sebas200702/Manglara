import { FileText, Loader2, X } from "lucide-react";
import type { PromptPreview } from "../../lib/knowledge-client";

export interface PromptPreviewModalProps {
  preview: PromptPreview | "loading" | null;
  onClose: () => void;
}

export function PromptPreviewModal({ preview, onClose }: PromptPreviewModalProps) {
  if (!preview) return null;

  const isLoaded = preview !== "loading";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/45 px-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl h-[80dvh] flex flex-col bg-white rounded-2xl border border-neutral-200 shadow-xl font-montserrat overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 font-bold text-neutral-800">
              <FileText className="h-4 w-4 text-navy-600" />
              Prompt de la próxima llamada
            </h2>
            <p className="text-xs text-neutral-500">
              {isLoaded
                ? `${preview.prompt_chars.toLocaleString("es-CO")} caracteres · ${preview.doc_ids.length} fuentes activas`
                : "Calculando…"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto bg-neutral-50">
        {isLoaded ? (
            <pre className="whitespace-pre-wrap break-words p-5 text-xs leading-relaxed text-neutral-700 font-mono">
              {preview.prompt}
            </pre>
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Generando el prompt real…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
