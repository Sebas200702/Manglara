import { useCallback, useEffect, useRef } from "react";
import { contentTypeFor, knowledgeClient } from "../../lib/knowledge-client";
import { useKnowledgeScreenStore } from "./knowledge-screen-store";

export const STAGE_LABELS: Record<string, string> = {
  signed: "Esperando archivo…",
  extracting: "Extrayendo el texto del documento…",
  embedding: "Vectorizando el contenido…",
  digesting: "Generando el resumen (digest)…",
  done: "Listo",
};

export function useKnowledgeScreen() {
  const authed = useKnowledgeScreenStore((s) => s.authed);
  const checking = useKnowledgeScreenStore((s) => s.checking);
  const loading = useKnowledgeScreenStore((s) => s.loading);
  const sources = useKnowledgeScreenStore((s) => s.sources);
  const error = useKnowledgeScreenStore((s) => s.error);
  const notice = useKnowledgeScreenStore((s) => s.notice);
  const history = useKnowledgeScreenStore((s) => s.history);
  const promptPreview = useKnowledgeScreenStore((s) => s.promptPreview);
  const job = useKnowledgeScreenStore((s) => s.job);
  const busySourceId = useKnowledgeScreenStore((s) => s.busySourceId);

  const setAuthed = useKnowledgeScreenStore((s) => s.setAuthed);
  const setChecking = useKnowledgeScreenStore((s) => s.setChecking);
  const setSources = useKnowledgeScreenStore((s) => s.setSources);
  const setError = useKnowledgeScreenStore((s) => s.setError);
  const setNotice = useKnowledgeScreenStore((s) => s.setNotice);
  const setHistory = useKnowledgeScreenStore((s) => s.setHistory);
  const setPromptPreview = useKnowledgeScreenStore((s) => s.setPromptPreview);
  const setJob = useKnowledgeScreenStore((s) => s.setJob);
  const patchJob = useKnowledgeScreenStore((s) => s.patchJob);
  const setBusySourceId = useKnowledgeScreenStore((s) => s.setBusySourceId);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  const showError = useCallback(
    (message: string) => {
      setError(message);
      window.setTimeout(() => setError(null), 5000);
    },
    [setError],
  );

  const loadSources = useCallback(async () => {
    try {
      const rows = await knowledgeClient.listSources();
      if (cancelled.current) return;
      setSources(rows);
    } catch (e) {
      if (e instanceof Error && e.message === "Error 401") {
        setAuthed(false);
      } else if (e instanceof Error) {
        showError(e.message);
      }
    }
  }, [setAuthed, setSources, showError]);

  const initialize = useCallback(async () => {
    setChecking(true);
    try {
      const { authenticated } = await knowledgeClient.me();
      setAuthed(authenticated);
      if (authenticated) await loadSources();
    } catch {
      setAuthed(false);
    } finally {
      setChecking(false);
    }
  }, [loadSources, setAuthed, setChecking]);

  const login = useCallback(
    async (password: string) => {
      try {
        await knowledgeClient.login(password);
        setAuthed(true);
        await loadSources();
      } catch (e) {
        throw e instanceof Error ? e : new Error("No se pudo iniciar sesión");
      }
    },
    [loadSources, setAuthed],
  );

  const logout = useCallback(async () => {
    try {
      await knowledgeClient.logout();
    } finally {
      setAuthed(false);
      setSources([]);
    }
  }, [setAuthed, setSources]);

  const setActive = useCallback(
    async (id: string, active: boolean) => {
      setBusySourceId(id);
      try {
        await knowledgeClient.setActive(id, active);
        const rows = await knowledgeClient.listSources();
        setSources(rows.filter((r) => r.status !== "archived"));
      } catch (e) {
        if (e instanceof Error) showError(e.message);
      } finally {
        setBusySourceId(null);
      }
    },
    [setBusySourceId, setSources, showError],
  );

  /** Reordena localmente (drag & drop) y persiste la nueva lista. */
  const moveSource = useCallback(
    async (fromId: string, toIndex: number) => {
      const visible = useKnowledgeScreenStore.getState().sources;
      const from = visible.findIndex((r) => r.id === fromId);
      if (from === -1 || toIndex === from) return;
      const next = visible.slice();
      const [row] = next.splice(from, 1);
      next.splice(toIndex, 0, row);
      setSources(next);
      try {
        await knowledgeClient.reorder(next.map((r) => r.id));
      } catch (e) {
        if (e instanceof Error) showError(e.message);
        await loadSources();
      }
    },
    [loadSources, setSources, showError],
  );

  const moveSourceByStep = useCallback(
    async (id: string, delta: -1 | 1) => {
      const visible = useKnowledgeScreenStore.getState().sources;
      const index = visible.findIndex((r) => r.id === id);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= visible.length) return;
      await moveSource(id, target);
    },
    [moveSource],
  );

  const archive = useCallback(
    async (id: string) => {
      setBusySourceId(id);
      try {
        await knowledgeClient.archive(id);
        await loadSources();
      } catch (e) {
        if (e instanceof Error) showError(e.message);
      } finally {
        setBusySourceId(null);
      }
    },
    [loadSources, setBusySourceId, showError],
  );

  const restore = useCallback(
    async (id: string) => {
      setBusySourceId(id);
      try {
        await knowledgeClient.restore(id);
        await loadSources();
      } catch (e) {
        if (e instanceof Error) showError(e.message);
      } finally {
        setBusySourceId(null);
      }
    },
    [loadSources, setBusySourceId, showError],
  );

  const openHistory = useCallback(async (id: string, name: string) => {
    setHistory({
      documentId: id,
      documentName: name,
      currentVersion: 0,
      versions: [],
      loading: true,
    });
    setPromptPreview(null);
    try {
      const { versions, current_version } = await knowledgeClient.listVersions(id);
    setHistory((h) =>
      h && h.documentId === id
        ? { ...h, versions, currentVersion: current_version, loading: false }
        : h,
    );
    } catch (e) {
      setHistory(null);
      if (e instanceof Error) showError(e.message);
    }
  }, [setHistory, showError]);

  const doRestoreVersion = useCallback(
    async (documentId: string, version: number) => {
      try {
        await knowledgeClient.restoreVersion(documentId, version);
        setNotice(`Se restauró el resumen de la versión ${version}`);
        window.setTimeout(() => setNotice(null), 4000);
        await loadSources();
        const name = useKnowledgeScreenStore.getState().history?.documentName ?? "";
        await openHistory(documentId, name);
      } catch (e) {
        if (e instanceof Error) showError(e.message);
      }
    },
    [loadSources, openHistory, setNotice, showError],
  );

  const downloadSource = useCallback(async (id: string) => {
    try {
      const { url } = await knowledgeClient.download(id);
      window.open(url, "_blank", "noopener");
    } catch (e) {
      if (e instanceof Error) showError(e.message);
    }
  }, [showError]);

  const previewPrompt = useCallback(async () => {
    setPromptPreview("loading");
    try {
      const preview = await knowledgeClient.preview();
      setPromptPreview(preview);
    } catch (e) {
      setPromptPreview(null);
      if (e instanceof Error) showError(e.message);
    }
  }, [setPromptPreview, showError]);

  /** Sube el archivo y corre el pipeline, reinvocando /run si Vercel corta
   *  por tiempo (needs_continue). Detiene la ronda al desmontar. */
  const runUpload = useCallback(
    async (file: File, mode: "new" | "replace", documentId: string | null) => {
      try {
        const init = await knowledgeClient.initUpload({
          filename: file.name,
          size: file.size,
          mode,
          document_id: documentId ?? undefined,
        });
        setJob({
          jobId: init.job_id,
          filename: init.filename,
          mode,
          replaceTarget: documentId,
          state: { status: "signed", stage: "signed", progress: 4, chunks_total: null, chunks_done: null, document_id: null, error: null },
          running: false,
        });
        await knowledgeClient.uploadFile(init.upload_url, contentTypeFor(file.name), file);

        let last: { status: string; stage: string | null; progress: number } | null = null;
        for (;;) {
          if (cancelled.current) break;
          patchJob({ running: true });
          const state = await knowledgeClient.runJob(init.job_id);
          patchJob({ state });
          if (state.status === "needs_continue") {
            // el run cortó por presupuesto de tiempo; vuelta a invocar
            continue;
          }
          last = { status: state.status, stage: state.stage, progress: state.progress };
          break;
        }
        if (last?.status === "done") {
          setNotice(mode === "replace" ? "Cartilla actualizada" : "Cartilla lista");
          window.setTimeout(() => setNotice(null), 4000);
        } else if (last?.status === "error") {
          showError("El procesamiento falló; revisa el detalle en la lista");
        }
      } catch (e) {
        if (e instanceof Error) showError(e.message);
        setJob(null);
      } finally {
        await loadSources();
      }
    },
    [loadSources, patchJob, setJob, setNotice, showError],
  );

  const closeDialog = useCallback(() => {
    cancelled.current = true;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setJob(null);
    cancelled.current = false;
  }, [setJob]);

  const exportKnowledge = useCallback(
    async (format: "md" | "json") => {
      try {
        const response = await fetch(knowledgeClient.exportUrl(format));
        if (!response.ok) throw new Error(`Error ${response.status}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `manglara-conocimiento.${format}`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        if (e instanceof Error) showError(e.message);
      }
    },
    [showError],
  );

  useEffect(() => {
    cancelled.current = false;
    void initialize();
    return () => {
      cancelled.current = true;
    };
  }, [initialize]);

  return {
    authed,
    checking,
    loading,
    sources,
    error,
    notice,
    history,
    promptPreview,
    job,
    busySourceId,
    login,
    logout,
    setActive,
    moveSource,
    moveSourceByStep,
    archive,
    restore,
    openHistory,
    doRestoreVersion,
    closeHistory: () => setHistory(null),
    downloadSource,
    previewPrompt,
    closePreview: () => setPromptPreview(null),
    runUpload,
    closeDialog,
    exportKnowledge,
    retry: initialize,
  };
}
