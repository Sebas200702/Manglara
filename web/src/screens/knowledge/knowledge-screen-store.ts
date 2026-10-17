import { create } from "zustand";
import type {
  DocumentVersion,
  JobState,
  KnowledgeSource,
  PromptPreview,
} from "../../lib/knowledge-client";

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

interface KnowledgeScreenState {
  authed: boolean | null;
  checking: boolean;
  loading: boolean;
  sources: KnowledgeSource[];
  error: string | null;
  notice: string | null;
  history: HistoryTarget | null;
  promptPreview: PromptPreview | "loading" | null;
  job: ActiveJob | null;
  busySourceId: string | null;
  reorderDirty: boolean;

  setAuthed: (authed: boolean) => void;
  setChecking: (checking: boolean) => void;
  setLoading: (loading: boolean) => void;
  setSources: (sources: KnowledgeSource[]) => void;
  setError: (error: string | null) => void;
  setNotice: (notice: string | null) => void;
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

export const useKnowledgeScreenStore = create<KnowledgeScreenState>((set) => ({
  authed: null,
  checking: true,
  loading: true,
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
  setLoading: (loading) => set({ loading }),
  setSources: (sources) => set({ sources }),
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
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
}));
