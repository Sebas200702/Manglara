import {
  CircleAlert,
  CircleCheck,
  Download,
  GripVertical,
  History as HistoryIcon,
  Loader2,
  RotateCcw,
  ArrowDown,
  ArrowUp,
  Repeat,
} from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import type { KnowledgeSource } from "../../lib/knowledge-client";

const STATUS_META: Record<
  KnowledgeSource["status"],
  { label: string; className: string }
> = {
  ready: { label: "Lista", className: "bg-brand-100 text-brand-800" },
  processing: { label: "Procesando", className: "bg-amber-100 text-amber-800" },
  error: { label: "Con error", className: "bg-red-100 text-red-700" },
  archived: { label: "Archivada", className: "bg-neutral-200 text-neutral-600" },
};

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}

export interface SourcesListProps {
  sources: KnowledgeSource[];
  busySourceId: string | null;
  jobDocumentId: string | null;
  onActivate: (id: string, active: boolean) => void;
  onMove: (id: string, targetIndex: number) => void;
  onMoveStep: (id: string, delta: -1 | 1) => void;
  onReplace: (id: string, name: string) => void;
  onHistory: (id: string, name: string) => void;
  onDownload: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  showArchived: boolean;
}

export function SourcesList(props: SourcesListProps) {
  const { sources, showArchived } = props;
  const rows = showArchived ? sources : sources.filter((s) => s.status !== "archived");
  const dragId = useRef<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  function onDrop(targetIndex: number) {
    const id = dragId.current;
    dragId.current = null;
    setDragOverIndex(null);
    if (id) props.onMove(id, targetIndex);
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((source, index) => (
        <SourceRow
          key={source.id}
          source={source}
          index={index}
          dragging={dragId.current === source.id}
          dragOver={dragOverIndex === index}
          busy={props.busySourceId === source.id}
          jobActive={props.jobDocumentId === source.id}
          showArchived={showArchived}
          onActivate={props.onActivate}
          onReplace={(id: string, name: string) => props.onReplace(id, name)}
          onHistory={props.onHistory}
          onDownload={props.onDownload}
          onArchive={props.onArchive}
          onRestore={props.onRestore}
          onMoveStep={props.onMoveStep}
          onDragStart={() => {
            dragId.current = source.id;
          }}
          onDragOver={(e: DragEvent) => {
            e.preventDefault();
            setDragOverIndex(index);
          }}
          onDropSelf={() => onDrop(index)}
          onDragEnd={() => {
            dragId.current = null;
            setDragOverIndex(null);
          }}
        />
      ))}
    </ul>
  );
}

interface SourceRowProps {
  source: KnowledgeSource;
  index: number;
  dragging: boolean;
  dragOver: boolean;
  busy: boolean;
  jobActive: boolean;
  showArchived: boolean;
  onActivate: (id: string, active: boolean) => void;
  onMoveStep: (id: string, delta: -1 | 1) => void;
  onReplace: (id: string, name: string) => void;
  onHistory: (id: string, name: string) => void;
  onDownload: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDragStart: () => void;
  onDragOver: (e: DragEvent) => void;
  onDropSelf: () => void;
  onDragEnd: () => void;
}

function SourceRow(props: SourceRowProps) {
  const { source } = props;
  const status = STATUS_META[source.status];
  const archived = source.status === "archived";
  const canToggle = source.status === "ready" && !archived;

  return (
    <li
      draggable={!archived && !props.busy}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDropSelf}
      onDragEnd={props.onDragEnd}
      className={`group bg-white border rounded-xl px-3 py-2.5 flex items-center gap-3 transition
        ${archived ? "opacity-70" : ""}
        ${props.dragOver ? "border-brand-400 ring-2 ring-brand-200" : "border-neutral-200/80"}
        ${props.dragging ? "opacity-50" : ""}`}
    >
      <span
        className={`cursor-grab text-neutral-300 hover:text-neutral-500 transition ${archived ? "invisible" : ""}`}
        title="Arrastrar para ordenar"
      >
        <GripVertical className="h-4 w-4" />
      </span>

      <div className={`flex sm:hidden flex-col ${archived ? "invisible" : ""}`}>
        <button
          type="button"
          disabled={props.index === 0}
          onClick={() => props.onMoveStep(source.id, -1)}
          className="text-neutral-300 hover:text-brand-600 disabled:opacity-30"
        >
          <ArrowUp className="h-3 w-3" />
        </button>
        <button type="button" onClick={() => props.onMoveStep(source.id, 1)} className="text-neutral-300 hover:text-brand-600">
          <ArrowDown className="h-3 w-3" />
        </button>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-semibold text-sm text-neutral-800 truncate">
            {source.name}
          </p>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${status.className}`}>
            {status.label}
          </span>
          <span className="shrink-0 rounded-full bg-navy-50 text-navy-700 px-2 py-0.5 text-[11px] font-bold">
            v{source.version}
          </span>
          {source.origin === "upload" && (
            <span className="shrink-0 rounded-full bg-neutral-100 text-neutral-500 px-2 py-0.5 text-[11px] font-bold">
              subida
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-neutral-500 truncate">
          {source.status === "error" && source.message ? (
            <>
              <CircleAlert className="inline h-3 w-3 text-red-500" /> {source.message}
            </>
          ) : (
            <>
              resumen {source.digest_chars.toLocaleString("es-CO")} chars
              {source.page_count ? ` · ${source.page_count} "páginas"` : ""}
              {source.updated_at && ` · editada ${formatWhen(source.updated_at)}`}
              {props.jobActive && " · procesando ahora…"}
            </>
          )}
        </p>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none shrink-0">
        <input
          type="checkbox"
          className="sr-only peer"
          disabled={!canToggle || props.busy}
          checked={source.active}
          onChange={(e) => props.onActivate(source.id, e.target.checked)}
        />
        <span
          aria-hidden
          className="relative h-6 w-10 rounded-full bg-neutral-300 peer-checked:bg-brand-500 transition
            after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition
            peer-checked:after:translate-x-4 peer-disabled:opacity-50"
        />
        <span className="hidden sm:inline text-xs font-semibold text-neutral-600">
          {source.active ? "Activa" : "Inactiva"}
        </span>
      </label>

      <div className="flex items-center gap-0.5 shrink-0">
        {props.busy ? (
          <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
        ) : archived ? (
          <RowAction title="Restaurar" onClick={() => props.onRestore(source.id)}>
            <RotateCcw className="h-4 w-4" />
          </RowAction>
        ) : (
          <>
            <RowAction
              title="Reemplazar archivo"
              onClick={() => props.onReplace(source.id, source.name)}
            >
              <Repeat className="h-4 w-4" />
            </RowAction>
            <RowAction title="Historial de versiones" onClick={() => props.onHistory(source.id, source.name)}>
              <HistoryIcon className="h-4 w-4" />
            </RowAction>
            <RowAction
              title="Descargar original"
              onClick={() => props.onDownload(source.id)}
              disabled={!source.digest_chars && !source.page_count}
            >
              <Download className="h-4 w-4" />
            </RowAction>
            <RowAction title="Archivar" onClick={() => props.onArchive(source.id)}>
              <CircleAlert className="h-4 w-4" />
            </RowAction>
          </>
        )}
      </div>
    </li>
  );
}

function RowAction({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="p-2 rounded-lg text-neutral-400 hover:text-navy-700 hover:bg-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed transition"
    >
      {children}
    </button>
  );
}

export function SourcesEmpty({ hashing }: { hashing: boolean }) {
  return (
    <li className="rounded-xl border border-dashed border-neutral-300 bg-white/60 px-4 py-10 text-center">
      <CircleCheck className="mx-auto h-6 w-6 text-brand-400" />
      <p className="mt-2 font-semibold text-neutral-700">
        {hashing ? "Cargando…" : "Sin cartillas todavía"}
      </p>
      <p className="mt-1 text-sm text-neutral-500">
        {hashing ? "" : "Sube la primera y actívala."}
      </p>
    </li>
  );
}
