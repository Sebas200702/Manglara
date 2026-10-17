import { create } from "zustand";
import type { TranscriptEntry } from "../../components/transcript-panel";
import type {
  BrainState,
  BridgeState,
  EndReason,
  MeetingProvider,
  MeetingState,
  MeetingTranscriptRole,
} from "../../lib/meeting-client";

let entryCounter = 0;

function nextEntryId(): string {
  return `m-${++entryCounter}-${Date.now()}`;
}

/** Meeting roles reuse the transcript panel's two sides. */
const PANEL_ROLE: Record<MeetingTranscriptRole, TranscriptEntry["role"]> = {
  participant: "user",
  manglara: "model",
};

interface MeetingScreenState {
  /** Backend session id of the current/last meeting (null = never joined). */
  meetingId: string | null;
  input: string;
  /** Provider detected locally from `input`, confirmed by the backend on join. */
  provider: MeetingProvider | null;
  bridgeState: BridgeState | null;
  brainState: BrainState;
  micOn: boolean;
  camOn: boolean;
  error: string | null;
  /** Why the last meeting ended, shown as a notice. */
  endReason: EndReason | null;
  transcripts: TranscriptEntry[];
  /** Join request in flight. */
  connecting: boolean;
  /** A control command (brain/mic/cam/leave) is in flight. */
  busy: boolean;
  /** The event WebSocket is currently open. */
  eventsConnected: boolean;
  chatOpen: boolean;
  setMeetingId: (id: string | null) => void;
  setInput: (input: string) => void;
  setProvider: (provider: MeetingProvider | null) => void;
  setError: (error: string | null) => void;
  setConnecting: (connecting: boolean) => void;
  setBusy: (busy: boolean) => void;
  setEventsConnected: (connected: boolean) => void;
  setChatOpen: (chatOpen: boolean | ((open: boolean) => boolean)) => void;
  applyState: (state: MeetingState) => void;
  appendTranscript: (role: MeetingTranscriptRole, text: string) => void;
  clearTranscripts: () => void;
  resetMeetingState: () => void;
}

const initialSession = {
  meetingId: null,
  bridgeState: null,
  brainState: "off" as BrainState,
  endReason: null,
  micOn: false,
  camOn: true,
  connecting: false,
  busy: false,
  eventsConnected: false,
};

export const useMeetingScreenStore = create<MeetingScreenState>((set) => ({
  ...initialSession,
  input: "",
  provider: null,
  error: null,
  transcripts: [],
  // Open by default on desktop; on phones it would cover the controls.
  chatOpen: typeof window !== "undefined" && window.matchMedia?.("(min-width: 768px)").matches === true,

  setMeetingId: (meetingId) => set({ meetingId }),
  setInput: (input) => set({ input }),
  setProvider: (provider) => set({ provider }),
  setError: (error) => set({ error }),
  setConnecting: (connecting) => set({ connecting }),
  setBusy: (busy) => set({ busy }),
  setEventsConnected: (eventsConnected) => set({ eventsConnected }),
  setChatOpen: (chatOpen) =>
    set((state) => ({
      chatOpen: typeof chatOpen === "function" ? chatOpen(state.chatOpen) : chatOpen,
    })),

  applyState: (s) =>
    set({
      meetingId: s.id,
      provider: s.provider,
      bridgeState: s.bridge,
      brainState: s.brain,
      micOn: s.mic_enabled,
      camOn: s.cam_enabled,
      error: s.error,
      endReason: s.end_reason,
    }),

  appendTranscript: (role, text) =>
    set((state) => {
      const panelRole = PANEL_ROLE[role];
      const last = state.transcripts[state.transcripts.length - 1];
      if (last && last.role === panelRole) {
        return {
          transcripts: [
            ...state.transcripts.slice(0, -1),
            { ...last, text: last.text + text },
          ],
        };
      }
      return {
        transcripts: [...state.transcripts, { id: nextEntryId(), role: panelRole, text }],
      };
    }),

  clearTranscripts: () => set({ transcripts: [] }),

  /** Back to "Sin conexión", keeping the typed link and the transcript. */
  resetMeetingState: () => set({ ...initialSession }),
}));
