import { Download, History, RotateCcw, X } from "lucide-react";
import type { HistoryTarget } from "./knowledge-screen-store";

export interface HistoryDrawerProps {
  history: HistoryTarget | null;
  onClose: () => void;
  onRestore: (documentId: string, version: number) => void;
  onDownload: (documentId: string) => void;
}

export function HistoryDrawer({
  history,
  onClose,
  onRestore,
  onDownload,
}: HistoryDrawerProps) {
  if (!history) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-navy-950/40 backdrop-blur-xs" onClick={onClose}>
      <aside
        className="h-full w-full max-w-md bg-white border-l border-neutral-200 shadow-xl font-montserrat flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-bold text-neutral-800">
              <History className="h-4 w-4 text-navy-600" />
              Historial
            </h2>
            <p className="truncate text-xs text-neutral-500">{history.documentName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {history.loading ? (
            <p className="text-sm text-neutral-400">Cargando versiones…</p>
          ) : history.versions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center">
              <p className="font-semibold text-neutral-700 text-sm">
                Todavía no hay versiones guardadas
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                Al reemplazar una cartilla, el contenido anterior queda aquí y
                se puede restaurar con un clic.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {history.versions.map((version) => (
                <li
                  key={version.id}
                  className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold text-neutral-800">
                      Versión {version.version}
                    </p>
                    <button
                      type="button"
                      onClick={() => onRestore(history.documentId, version.version)}
                      className="flex items-center gap-1.5 rounded-lg bg-navy-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-navy-700"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restaurar resumen
                    </button>
                  </div>
                  <p className="mt-1 truncate text-xs text-neutral-600">
                    {version.name}
                    {version.page_count ? ` · ${version.page_count} pág` : ""}
                    {version.digest
                      ? ` · ${version.digest.length.toLocaleString("es-CO")} chars`
                      : ""}
                  </p>
                  {version.note && (
                    <p className="mt-0.5 text-[11px] text-neutral-400">{version.note}</p>
                  )}
                  <p className="mt-1 text-[11px] text-neutral-400">
                    {new Date(version.created_at).toLocaleString("es-CO")}
                    {version.created_by ? ` · ${version.created_by}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="border-t border-neutral-200 px-5 py-3">
          <button
            type="button"
            onClick={() => onDownload(history.documentId)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
          >
            <Download className="h-4 w-4" />
            Descargar archivo actual
          </button>
        </footer>
      </aside>
    </div>
  );
}
