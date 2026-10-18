import {
  Ban,
  Download,
  Eye,
  FileUp,
  LogOut,
  Phone,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../../components/brand/logo";

import { LoginView } from "./login-view";
import { HistoryDrawer } from "./history-drawer";
import { PromptPreviewModal } from "./prompt-preview-modal";
import { SourcesList, SourcesEmpty } from "./sources-list";
import { UploadDialog } from "./upload-dialog";
import { useKnowledgeScreen } from "./use-knowledge-screen";

export function KnowledgeScreen() {
  const screen = useKnowledgeScreen();
  const [showArchived, setShowArchived] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<{ id: string; name: string } | null>(null);

  if (screen.checking) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#f8faf6] font-montserrat text-sm text-neutral-400">
        Cargando panel…
      </div>
    );
  }
  if (!screen.authed) {
    return <LoginView onLogin={screen.login} />;
  }

  const activeCount = screen.sources.filter((s) => s.active).length;
  const budget = screen.sources.length
    ? screen.sources
        .filter((s) => s.active)
        .reduce((acc, s) => acc + s.digest_chars, 0)
    : 0;
  const budgetPct = Math.min(100, Math.round((budget / 60000) * 100));

  return (
    <div className="min-h-dvh flex flex-col bg-[#f8faf6] font-montserrat text-neutral-800">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-neutral-200/80 bg-white px-4 sm:px-6 shadow-2xs">
        <div className="flex items-center gap-3 min-w-0">
          <Logo />
          <span className="h-5 w-[1px] bg-neutral-200 hidden sm:inline" />
          <span className="text-xs font-bold text-neutral-400 uppercase tracking-widest mt-0.5 hidden sm:inline truncate">
            Panel de conocimiento
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-navy-700 hover:bg-navy-50"
            title="Volver a la llamada"
          >
            <Phone className="h-4 w-4" />
            <span className="hidden sm:inline">Llamada</span>
          </Link>
          <button
            type="button"
            onClick={screen.logout}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-neutral-500 hover:bg-neutral-100"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Salir</span>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 sm:px-6 py-6 pb-24">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h1 className="text-xl font-bold text-neutral-900">Cartillas de conocimiento</h1>
            <p className="mt-1 text-sm text-neutral-500">
              {activeCount} activa{activeCount === 1 ? "" : "s"} · el orden de
              arriba es el orden en que Manglara lee el material.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setReplaceTarget(null);
              setUploadOpen(true);
            }}
            className="shrink-0 flex items-center gap-2 rounded-xl bg-brand-500 hover:bg-brand-600 text-white font-semibold text-sm px-4 py-2.5 transition shadow-sm"
          >
            <FileUp className="h-4 w-4" />
            Nueva cartilla
          </button>
        </div>

        {/* Barra de presupuesto del preload (60k chars) */}
        <div className="mb-6 rounded-xl border border-neutral-200/80 bg-white px-4 py-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-neutral-600">
              Presupuesto del resumen en llamada
            </span>
            <span
              className={`font-bold ${budgetPct > 100 ? "text-red-600" : budgetPct > 85 ? "text-amber-600" : "text-neutral-600"}`}
            >
              {budget.toLocaleString("es-CO")} / 60.000
            </span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-neutral-200 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${budgetPct > 100 ? "bg-red-500" : budgetPct > 85 ? "bg-amber-400" : "bg-brand-500"}`}
              style={{ width: `${budgetPct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-neutral-400">
            Lo que exceda la barra no cabe en la memoria de la llamada (la
            lectura por RAG igual funciona).
          </p>
        </div>

        {/* Toolbar */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-neutral-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="sr-only peer"
            />
            <span
              aria-hidden
              className="relative h-5 w-9 rounded-full bg-neutral-300 peer-checked:bg-navy-500 transition after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4"
            />
            Mostrar archivadas
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={screen.previewPrompt}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-navy-700 hover:bg-navy-50"
              title="Ver el prompt completo que escuchará Manglara"
            >
              <Eye className="h-3.5 w-3.5" />
              Ver prompt
            </button>
            <button
              type="button"
              onClick={() => screen.exportKnowledge("md")}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-navy-700 hover:bg-navy-50"
              title="Descargar respaldo completo (Markdown)"
            >
              <Download className="h-3.5 w-3.5" />
              Exportar
            </button>
            <button
              type="button"
              onClick={screen.retry}
              className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              title="Refrescar"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Lista */}
        {screen.sources.length === 0 ? (
          <ul>
            <SourcesEmpty hashing={screen.loading} />
          </ul>
        ) : (
          <SourcesList
            sources={screen.sources}
            busySourceId={screen.busySourceId}
            jobDocumentId={screen.job?.state.document_id ?? null}
            showArchived={showArchived}
            onActivate={screen.setActive}
            onMove={screen.moveSource}
            onMoveStep={screen.moveSourceByStep}
            onReplace={(id, name) => {
              setReplaceTarget({ id, name });
              setUploadOpen(true);
            }}
            onHistory={(id, name) => void screen.openHistory(id, name)}
            onDownload={screen.downloadSource}
            onArchive={screen.archive}
            onRestore={screen.restore}
          />
        )}

        <p className="mt-8 text-center text-[11px] text-neutral-400">
          Cada cambio queda registrado con fecha; el respaldo completo incluye
          historial y contenido textual.
        </p>
      </main>

      <UploadDialog
        open={uploadOpen}
        job={screen.job}
        replaceTarget={replaceTarget}
        onClose={() => {
          setUploadOpen(false);
          setReplaceTarget(null);
          screen.closeDialog();
        }}
        onStart={(file, mode, documentId) => void screen.runUpload(file, mode, documentId)}
      />
      <HistoryDrawer
        history={screen.history}
        onClose={screen.closeHistory}
        onRestore={(documentId, version) => void screen.doRestoreVersion(documentId, version)}
        onDownload={(documentId) => void screen.downloadSource(documentId)}
      />
      <PromptPreviewModal preview={screen.promptPreview} onClose={screen.closePreview} />

      {screen.notice && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-navy-700 px-4 py-2 text-sm font-semibold text-white shadow-lg">
          {screen.notice}
        </div>
      )}
      {screen.error && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-lg flex items-center gap-2">
          <Ban className="h-4 w-4" />
          {screen.error}
        </div>
      )}
    </div>
  );
}
