import { useCallback, useEffect, useRef } from "react";
import {
  contentTypeFor,
  isServerUnreachable,
  isSessionExpired,
  knowledgeClient,
  messageForStatus,
} from "../../lib/knowledge-client";
import { useKnowledgeScreenStore } from "./knowledge-screen-store";

export const STAGE_LABELS: Record<string, string> = {
  signed: "Esperando archivo…",
  extracting: "Extrayendo el texto del documento…",
  embedding: "Vectorizando el contenido…",
  digesting: "Generando el resumen (digest)…",
  done: "Listo",
};

const SESSION_EXPIRED_MESSAGE = messageForStatus(401);
const UNKNOWN_ERROR_MESSAGE = "Algo salió mal. Inténtalo de nuevo.";

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : UNKNOWN_ERROR_MESSAGE;
}

export function useKnowledgeScreen() {
  const authed = useKnowledgeScreenStore((s) => s.authed);
  const checking = useKnowledgeScreenStore((s) => s.checking);
  const unreachable = useKnowledgeScreenStore((s) => s.unreachable);
  const loginNotice = useKnowledgeScreenStore((s) => s.loginNotice);
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
  const setUnreachable = useKnowledgeScreenStore((s) => s.setUnreachable);
  const setLoginNotice = useKnowledgeScreenStore((s) => s.setLoginNotice);
  const setLoading = useKnowledgeScreenStore((s) => s.setLoading);
  const setSources = useKnowledgeScreenStore((s) => s.setSources);
  const patchSource = useKnowledgeScreenStore((s) => s.patchSource);
  const showError = useKnowledgeScreenStore((s) => s.showError);
  const dismissError = useKnowledgeScreenStore((s) => s.dismissError);
  const showNotice = useKnowledgeScreenStore((s) => s.showNotice);
  const dismissNotice = useKnowledgeScreenStore((s) => s.dismissNotice);
  const setHistory = useKnowledgeScreenStore((s) => s.setHistory);
  const setPromptPreview = useKnowledgeScreenStore((s) => s.setPromptPreview);
  const setJob = useKnowledgeScreenStore((s) => s.setJob);
  const patchJob = useKnowledgeScreenStore((s) => s.patchJob);
  const setBusySourceId = useKnowledgeScreenStore((s) => s.setBusySourceId);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  /** Back to the login with a notice; the rest of the panel state is dropped. */
  const expireSession = useCallback(() => {
    dismissError();
    setSources([]);
    setHistory(null);
    setPromptPreview(null);
    setLoginNotice(SESSION_EXPIRED_MESSAGE);
    setAuthed(false);
  }, [dismissError, setAuthed, setHistory, setLoginNotice, setPromptPreview, setSources]);

  /** Single error path: 401 ends the session, anything else is a toast. */
  const fail = useCallback(
    (e: unknown, retry?: () => void) => {
      if (isSessionExpired(e)) {
        expireSession();
        return;
      }
      showError({ message: messageOf(e), retry });
    },
    [expireSession, showError],
  );

  const loadSources = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await knowledgeClient.listSources();
      if (cancelled.current) return;
      setSources(rows);
    } catch (e) {
      fail(e, () => void loadSources());
    } finally {
      setLoading(false);
    }
  }, [fail, setLoading, setSources]);

  const initialize = useCallback(async () => {
    setChecking(true);
    setUnreachable(null);
    try {
      const { authenticated } = await knowledgeClient.me();
      setAuthed(authenticated);
      if (authenticated) await loadSources();
    } catch (e) {
      if (isServerUnreachable(e)) {
        setUnreachable(messageOf(e));
      } else {
        setAuthed(false);
      }
    } finally {
      setChecking(false);
    }
  }, [loadSources, setAuthed, setChecking, setUnreachable]);

  const login = useCallback(
    async (password: string) => {
      try {
        await knowledgeClient.login(password);
        setLoginNotice(null);
        setAuthed(true);
        await loadSources();
      } catch (e) {
        throw e instanceof Error ? e : new Error("No se pudo iniciar sesión");
      }
    },
    [loadSources, setAuthed, setLoginNotice],
  );

  const logout = useCallback(async () => {
    try {
      await knowledgeClient.logout();
    } catch {
      // the local session is closed anyway
    } finally {
      setLoginNotice(null);
      setAuthed(false);
      setSources([]);
    }
  }, [setAuthed, setLoginNotice, setSources]);

  /** Optimistic toggle: flip locally, confirm with the server, revert on failure. */
  const setActive = useCallback(
    async (id: string, active: boolean) => {
      setBusySourceId(id);
      patchSource(id, { active });
      try {
        const result = await knowledgeClient.setActive(id, active);
        patchSource(id, { active: result.active });
      } catch (e) {
        patchSource(id, { active: !active });
        fail(e, () => void setActive(id, active));
      } finally {
        setBusySourceId(null);
      }
    },
    [fail, patchSource, setBusySourceId],
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
        fail(e);
        if (!isSessionExpired(e)) await loadSources();
      }
    },
    [fail, loadSources, setSources],
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
        // mirrors the server: archived sources are also deactivated
        patchSource(id, { status: "archived", active: false });
      } catch (e) {
        fail(e, () => void archive(id));
      } finally {
        setBusySourceId(null);
      }
    },
    [fail, patchSource, setBusySourceId],
  );

  const restore = useCallback(
    async (id: string) => {
      setBusySourceId(id);
      try {
        await knowledgeClient.restore(id);
        patchSource(id, { status: "ready" });
      } catch (e) {
        fail(e, () => void restore(id));
      } finally {
        setBusySourceId(null);
      }
    },
    [fail, patchSource, setBusySourceId],
  );

  const openHistory = useCallback(
    async (id: string, name: string) => {
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
        fail(e, () => void openHistory(id, name));
      }
    },
    [fail, setHistory, setPromptPreview],
  );

  const doRestoreVersion = useCallback(
    async (documentId: string, version: number) => {
      try {
        await knowledgeClient.restoreVersion(documentId, version);
        showNotice(`Se restauró el resumen de la versión ${version}`);
        // version, digest and timestamps change server-side: refetch
        await loadSources();
        const name = useKnowledgeScreenStore.getState().history?.documentName ?? "";
        await openHistory(documentId, name);
      } catch (e) {
        fail(e);
      }
    },
    [fail, loadSources, openHistory, showNotice],
  );

  const downloadSource = useCallback(
    async (id: string) => {
      try {
        const { url } = await knowledgeClient.download(id);
        window.open(url, "_blank", "noopener");
      } catch (e) {
        fail(e, () => void downloadSource(id));
      }
    },
    [fail],
  );

  const previewPrompt = useCallback(async () => {
    setPromptPreview("loading");
    try {
      const preview = await knowledgeClient.preview();
      setPromptPreview(preview);
    } catch (e) {
      setPromptPreview(null);
      fail(e, () => void previewPrompt());
    }
  }, [fail, setPromptPreview]);

  /** Sube el archivo y corre el pipeline, reinvocando /run si Vercel corta
   *  por tiempo (needs_continue). Detiene la ronda al desmontar. */
  const runUpload = useCallback(
    async (file: File, mode: "new" | "replace", documentId: string | null) => {
      let expired = false;
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
          showNotice(mode === "replace" ? "Cartilla actualizada" : "Cartilla lista");
        } else if (last?.status === "error") {
          showError({ message: "El procesamiento falló; revisa el detalle en la lista" });
        }
      } catch (e) {
        expired = isSessionExpired(e);
        fail(e);
        setJob(null);
      } finally {
        // new or replaced document: the list must come from the server
        if (!expired) await loadSources();
      }
    },
    [fail, loadSources, patchJob, setJob, showError, showNotice],
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
        const blob = await knowledgeClient.exportFile(format);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `manglara-conocimiento.${format}`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        fail(e, () => void exportKnowledge(format));
      }
    },
    [fail],
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
    unreachable,
    loginNotice,
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
    refresh: loadSources,
    dismissError,
    dismissNotice,
    retry: initialize,
  };
}
