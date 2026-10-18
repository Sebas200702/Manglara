import { FileUp, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { STAGE_LABELS } from "./use-knowledge-screen";
import type { ActiveJob } from "./knowledge-screen-store";

export interface UploadDialogProps {
  open: boolean;
  job: ActiveJob | null;
  /** Documento al que se reemplaza su archivo (si no hay, es "nueva"). */
  replaceTarget: { id: string; name: string } | null;
  onClose: () => void;
  onStart: (file: File, mode: "new" | "replace", documentId: string | null) => void;
}

export function UploadDialog({ open, job, replaceTarget, onClose, onStart }: UploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busy = job !== null;

  useEffect(() => {
    if (!busy && inputRef.current) inputRef.current.value = "";
  }, [busy]);

  function submit(selected: File) {
    onStart(
      selected,
      replaceTarget ? "replace" : "new",
      replaceTarget ? replaceTarget.id : null,
    );
  }

  const progress = job?.state.progress ?? 0;
  const stageLabel = job ? STAGE_LABELS[job.state.stage ?? job.state.status] ?? job.state.status : "";
  const chunksInfo =
    job?.state.chunks_done != null && job?.state.chunks_total
      ? `${job.state.chunks_done}/${job.state.chunks_total}`
      : "";

  if (!open && !job) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/45 px-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md bg-white rounded-2xl border border-neutral-200 shadow-xl p-6 font-montserrat">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-neutral-800">
              {job?.mode === "replace" ? "Reemplazar cartilla" : "Nueva cartilla"}
            </h2>
            <p className="mt-1 text-xs text-neutral-500">
              {job?.mode === "replace"
                ? "Sube el archivo nuevo; el contenido anterior queda en el historial."
                : "PDF o DOCX hasta 50MB. Se procesa por etapas y luego se activa."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100"
            disabled={busy}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {job ? (
          <div className="mt-6 flex flex-col gap-3">
            {replaceTarget && (
              <p className="text-xs text-neutral-500">
                Reemplazando: <span className="font-semibold">{replaceTarget.name}</span>
              </p>
            )}
            <p className="text-sm font-semibold text-neutral-700 truncate">
              {job.filename}
            </p>
            <div className="h-2 rounded-full bg-neutral-200 overflow-hidden">
              <div
                className="h-full rounded-full bg-brand-500 transition-all duration-500"
                style={{ width: `${Math.max(progress, 6)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-neutral-600">
              <span>
                {chunksInfo
                  ? `Vectorizando ${chunksInfo} fragmentos…`
                  : stageLabel}
              </span>
              <span className="font-bold">{progress}%</span>
            </div>
            {job.state.status === "done" ? (
              <button
                type="button"
                onClick={onClose}
                className="mt-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-semibold px-4 py-2"
              >
                Listo, cerrar
              </button>
            ) : job.state.status === "error" ? (
              <div className="mt-2">
                <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                  {job.state.error || "Falló el procesamiento"}
                </p>
                <button
                  type="button"
                  onClick={onClose}
                  className="mt-2 text-sm font-semibold text-navy-700 hover:underline"
                >
                  Cerrar
                </button>
              </div>
            ) : (
              <p className="text-xs text-neutral-400 flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Puedes dejar esta ventana abierta: el proceso continúa aunque
                Vercel rote el servidor.
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className={`mt-6 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 transition border-neutral-300 hover:border-brand-400 hover:bg-brand-50/40`}
          >
            <FileUp className="h-7 w-7 text-brand-500" />
            <span className="text-sm font-semibold text-neutral-700">
              Elegir archivo (.pdf / .docx)
            </span>
            <span className="text-xs text-neutral-400">
              el archivo se sube directo a Supabase, sin pasar por el servidor
            </span>
          </button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx"
          hidden
          onChange={(e) => {
            const selected = e.target.files?.[0];
            setFile(selected ?? null);
            if (selected) submit(selected);
          }}
        />
        {!job && file ? (
          <p className="mt-3 text-xs text-neutral-500 truncate">
            Seleccionado: {file.name}
          </p>
        ) : null}
      </div>
    </div>
  );
}
