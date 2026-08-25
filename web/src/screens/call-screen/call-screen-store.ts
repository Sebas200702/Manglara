import { create } from "zustand";
import type { ConnectionState } from "../../lib/voice-client";
import type { TranscriptEntry } from "../../components/transcript-panel";

let entryCounter = 0;

function nextEntryId(): string {
  return `t-${++entryCounter}-${Date.now()}`;
}

interface CallScreenState {
  connection: ConnectionState;
  speaking: boolean;
  thinking: boolean;
  inCall: boolean;
  error: string | null;
  transcripts: TranscriptEntry[];
  loading: boolean;
  chatOpen: boolean;
  micEnabled: boolean;
  cameraEnabled: boolean;
  setConnection: (connection: ConnectionState) => void;
  setSpeaking: (speaking: boolean) => void;
  setThinking: (thinking: boolean) => void;
  setInCall: (inCall: boolean) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  setChatOpen: (chatOpen: boolean | ((open: boolean) => boolean)) => void;
  setMicEnabled: (enabled: boolean) => void;
  setCameraEnabled: (enabled: boolean) => void;
  appendTranscript: (role: "user" | "model", text: string) => void;
  clearTranscripts: () => void;
  resetCallState: () => void;
}

export const useCallScreenStore = create<CallScreenState>((set) => ({
  connection: "disconnected",
  speaking: false,
  thinking: false,
  inCall: false,
  error: null,
  transcripts: [],
  loading: false,
  chatOpen: false,
  micEnabled: true,
  cameraEnabled: true,

  setConnection: (connection) => set({ connection }),
  setSpeaking: (speaking) => set({ speaking }),
  setThinking: (thinking) => set({ thinking }),
  setInCall: (inCall) => set({ inCall }),
  setError: (error) => set({ error }),
  setLoading: (loading) => set({ loading }),
  setChatOpen: (chatOpen) =>
    set((state) => ({
      chatOpen: typeof chatOpen === "function" ? chatOpen(state.chatOpen) : chatOpen,
    })),

  setMicEnabled: (micEnabled) => set({ micEnabled }),
  setCameraEnabled: (cameraEnabled) => set({ cameraEnabled }),

  appendTranscript: (role, text) =>
    set((state) => {
      const last = state.transcripts[state.transcripts.length - 1];
      if (last && last.role === role) {
        return {
          transcripts: [
            ...state.transcripts.slice(0, -1),
            { ...last, text: last.text + text },
          ],
        };
      }
      return {
        transcripts: [...state.transcripts, { id: nextEntryId(), role, text }],
      };
    }),

  clearTranscripts: () => set({ transcripts: [] }),

  resetCallState: () =>
    set({
      inCall: false,
      speaking: false,
      thinking: false,
      connection: "disconnected",
      chatOpen: false,
      micEnabled: true,
      cameraEnabled: true,
    }),
}));
