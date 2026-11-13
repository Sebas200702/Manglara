import { create } from "zustand";
import type {
  DocumentVersion,
  JobState,
  KnowledgeSource,
  PromptPreview,
} from "../../lib/knowledge-client";
import { createAutoClear } from "./auto-clear";

export interface HistoryTarget {
  documentId: string;
  documentName: string;
  currentVersion: number;
  versions: DocumentVersion[];
  loading: boolean;
}

export interface ActiveJob {
  jobId: string;
  filename: string;
  mode: "new" | "replace";
  replaceTarget: string | null;
  state: JobState;
  running: boolean;
}

/** Error toast; `retry` re-runs the failed action when it is safe to repeat. */
export interface ScreenError {
  message: string;
  retry?: () => void;
}

const ERROR_TTL_MS = 6000;
const NOTICE_TTL_MS = 4000;

/** Returns a new list with `patch` applied to the row `id` (same list if absent). */
export function patchSourceIn(
  sources: KnowledgeSource[],
  id: string,
  patch: Partial<KnowledgeSource>,
): KnowledgeSource[] {
  const index = sources.findIndex((s) => s.id === id);
  if (index === -1) return sources;
  const next = sources.slice();
  next[index] = { ...sources[index], ...patch };
  return next;
}

interface KnowledgeScreenState {
  authed: boolean | null;
  checking: boolean;
  /** Message shown instead of the login when the server cannot be reached. */
  unreachable: string | null;
  /** Message shown on the login view (e.g. expired session). */
  loginNotice: string | null;
  loading: boolean;
  sources: KnowledgeSource[];
  error: ScreenError | null;
  notice: string | null;
  history: HistoryTarget | null;
  promptPreview: PromptPreview | "loading" | null;
  job: ActiveJob | null;
  busySourceId: string | null;
  reorderDirty: boolean;

  setAuthed: (authed: boolean) => void;
  setChecking: (checking: boolean) => void;
  setUnreachable: (message: string | null) => void;
  setLoginNotice: (message: string | null) => void;
  setLoading: (loading: boolean) => void;
  setSources: (sources: KnowledgeSource[]) => void;
  patchSource: (id: string, patch: Partial<KnowledgeSource>) => void;
  showError: (error: ScreenError) => void;
  dismissError: () => void;
  showNotice: (notice: string) => void;
  dismissNotice: () => void;
  setHistory: (
    history:
      | HistoryTarget
      | null
      | ((prev: HistoryTarget | null) => HistoryTarget | null),
  ) => void;
  setPromptPreview: (preview: PromptPreview | "loading" | null) => void;
  setJob: (job: ActiveJob | null) => void;
  patchJob: (patch: Partial<ActiveJob> | null) => void;
  setBusySourceId: (id: string | null) => void;
  setReorderDirty: (dirty: boolean) => void;
}

export const useKnowledgeScreenStore = create<KnowledgeScreenState>((set) => {
  const errorSlot = createAutoClear<ScreenError>((error) => set({ error }), ERROR_TTL_MS);
  const noticeSlot = createAutoClear<string>((notice) => set({ notice }), NOTICE_TTL_MS);

  return {
    authed: null,
    checking: true,
    unreachable: null,
    loginNotice: null,
    loading: false,
    sources: [],
    error: null,
    notice: null,
    history: null,
    promptPreview: null,
    job: null,
    busySourceId: null,
    reorderDirty: false,

    setAuthed: (authed) => set({ authed }),
    setChecking: (checking) => set({ checking }),
    setUnreachable: (unreachable) => set({ unreachable }),
    setLoginNotice: (loginNotice) => set({ loginNotice }),
    setLoading: (loading) => set({ loading }),
    setSources: (sources) => set({ sources }),
    patchSource: (id, patch) =>
      set((s) => ({ sources: patchSourceIn(s.sources, id, patch) })),
    showError: (error) => errorSlot.show(error),
    dismissError: () => errorSlot.clear(),
    showNotice: (notice) => noticeSlot.show(notice),
    dismissNotice: () => noticeSlot.clear(),
    setHistory: (history) =>
      set((s) => ({
        history:
          typeof history === "function"
            ? (history as (prev: HistoryTarget | null) => HistoryTarget | null)(s.history)
            : history,
      })),
    setPromptPreview: (promptPreview) => set({ promptPreview }),
    setJob: (job) => set({ job, reorderDirty: false }),
    patchJob: (patch) =>
      set((s) => ({ job: s.job && patch ? { ...s.job, ...patch } : s.job })),
    setBusySourceId: (busySourceId) => set({ busySourceId }),
    setReorderDirty: (reorderDirty) => set({ reorderDirty }),
  };
});
