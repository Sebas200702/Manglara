import { useEffect, useRef } from "react";
import {
  MeetingApiError,
  MeetingEvents,
  detectProvider,
  isTerminal,
  meetingApi,
  type BrainState,
  type BridgeState,
  type EndReason,
  type MeetingProvider,
} from "../../lib/meeting-client";
import { useMeetingScreenStore } from "./meeting-screen-store";

/** Survives a page reload so the UI can re-attach to a running meeting. */
const STORAGE_KEY = "manglara.meeting.id";

function storeId(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(STORAGE_KEY, id);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode): reload recovery just won't work
  }
}

function loadId(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export type MeetingStatusTone = "idle" | "progress" | "waiting" | "live" | "active" | "error";

export interface MeetingStatus {
  label: string;
  tone: MeetingStatusTone;
}

export function deriveStatus(
  bridge: BridgeState | null,
  brain: BrainState,
  connecting: boolean
): MeetingStatus {
  if (connecting) return { label: "Conectando…", tone: "progress" };
  switch (bridge) {
    case "idle":
    case "launching":
    case "joining":
      return { label: "Conectando…", tone: "progress" };
    case "lobby":
      return { label: "En sala de espera", tone: "waiting" };
    case "in_meeting":
      if (brain === "active") return { label: "En reunión · escuchando y hablando", tone: "active" };
      if (brain === "starting") return { label: "En reunión · activando…", tone: "progress" };
      if (brain === "stopping") return { label: "En reunión · apagando…", tone: "progress" };
      return { label: "En reunión (dormida)", tone: "live" };
    case "leaving":
      return { label: "Saliendo…", tone: "progress" };
    case "error":
      return { label: "Error", tone: "error" };
    default:
      return { label: "Sin conexión", tone: "idle" };
  }
}

export const END_REASON_NOTICES: Record<EndReason, string> = {
  user: "Manglara salió de la reunión.",
  ended: "La reunión terminó.",
  alone: "Manglara salió porque se quedó sola en la reunión.",
  max_duration: "Manglara salió: se alcanzó la duración máxima de la reunión.",
};

export const PROVIDER_LABELS: Record<MeetingProvider, string> = {
  teams: "Microsoft Teams",
  zoom: "Zoom",
  meet: "Google Meet",
};

function readableError(err: unknown, fallback: string): string {
  if (err instanceof MeetingApiError) {
    if (err.status === 409) return err.message || "Manglara ya está en una reunión";
    if (err.status === 422) return err.message || "URL no reconocida";
    if (err.status === 404) return "La reunión ya terminó";
    return err.message;
  }
  return fallback;
}

export function useMeetingScreen() {
  const eventsRef = useRef<MeetingEvents | null>(null);

  const meetingId = useMeetingScreenStore((s) => s.meetingId);
  const input = useMeetingScreenStore((s) => s.input);
  const provider = useMeetingScreenStore((s) => s.provider);
  const bridgeState = useMeetingScreenStore((s) => s.bridgeState);
  const brainState = useMeetingScreenStore((s) => s.brainState);
  const micOn = useMeetingScreenStore((s) => s.micOn);
  const camOn = useMeetingScreenStore((s) => s.camOn);
  const error = useMeetingScreenStore((s) => s.error);
  const endReason = useMeetingScreenStore((s) => s.endReason);
  const transcripts = useMeetingScreenStore((s) => s.transcripts);
  const connecting = useMeetingScreenStore((s) => s.connecting);
  const busy = useMeetingScreenStore((s) => s.busy);
  const eventsConnected = useMeetingScreenStore((s) => s.eventsConnected);
  const chatOpen = useMeetingScreenStore((s) => s.chatOpen);

  const store = useMeetingScreenStore.getState;

  const inMeeting = bridgeState === "in_meeting";
  /** Joined (or joining) and not finished: the link input is locked. */
  const sessionLive = connecting || (bridgeState !== null && !isTerminal(bridgeState));
  const status = deriveStatus(bridgeState, brainState, connecting);
  const notice =
    bridgeState === "closed" && endReason ? END_REASON_NOTICES[endReason] : null;

  const subscribe = (id: string) => {
    eventsRef.current?.close();
    eventsRef.current = new MeetingEvents(id, {
      onEvent: (event) => {
        const s = store();
        if (event.type === "state") {
          s.applyState(event);
          if (isTerminal(event.bridge)) storeId(null);
        } else if (event.type === "transcript") {
          s.appendTranscript(event.role, event.text);
        } else {
          s.setError(event.message);
          s.resetMeetingState();
          storeId(null);
        }
      },
      onConnectionChange: (connected) => store().setEventsConnected(connected),
    });
  };

  // Re-attach on mount: after switching sections the store still has the id;
  // after a page reload it comes from sessionStorage.
  useEffect(() => {
    const s = store();
    const id = s.meetingId ?? loadId();
    if (!id || (s.bridgeState && isTerminal(s.bridgeState))) return;
    let cancelled = false;
    void meetingApi
      .get(id)
      .then((state) => {
        if (cancelled) return;
        if (!state || isTerminal(state.bridge)) {
          storeId(null);
          if (state) store().applyState(state);
          return;
        }
        store().applyState(state);
        subscribe(state.id);
      })
      .catch(() => {
        // Backend unreachable: leave the screen in its last known state.
      });
    return () => {
      cancelled = true;
      eventsRef.current?.close();
      eventsRef.current = null;
    };
  }, []);

  const setInput = (value: string) => {
    const s = store();
    s.setInput(value);
    if (!sessionLive) s.setProvider(detectProvider(value));
    if (s.error && !sessionLive) s.setError(null);
  };

  const connect = async () => {
    const s = store();
    const value = s.input.trim();
    if (!value) {
      s.setError("Pega el link o el ID de la reunión");
      return;
    }
    if (!detectProvider(value)) {
      s.setError("URL no reconocida: usa un link o ID de Teams, Zoom o Google Meet");
      return;
    }
    s.setError(null);
    s.clearTranscripts();
    s.setConnecting(true);
    try {
      const state = await meetingApi.join(value);
      store().applyState(state);
      storeId(state.id);
      subscribe(state.id);
    } catch (err) {
      store().setError(readableError(err, "No se pudo conectar a la reunión"));
    } finally {
      store().setConnecting(false);
    }
  };

  /** Runs one control command against the current meeting. */
  const command = async (run: (id: string) => Promise<unknown>, fallback: string) => {
    const s = store();
    const id = s.meetingId;
    if (!id || s.busy) return;
    s.setBusy(true);
    s.setError(null);
    try {
      await run(id);
    } catch (err) {
      store().setError(readableError(err, fallback));
    } finally {
      store().setBusy(false);
    }
  };

  const startBrain = () =>
    command((id) => meetingApi.startBrain(id), "No se pudo iniciar Manglara Meeting Live");
  const stopBrain = () =>
    command((id) => meetingApi.stopBrain(id), "No se pudo apagar la interacción");
  const toggleMic = () =>
    command((id) => meetingApi.setMic(id, !store().micOn), "No se pudo cambiar el micrófono");
  const toggleCam = () =>
    command((id) => meetingApi.setCam(id, !store().camOn), "No se pudo cambiar la cámara");
  const leave = () => command((id) => meetingApi.leave(id), "No se pudo desconectar");

  /** After a meeting ended, clear it so a new one can be joined. */
  const dismiss = () => {
    eventsRef.current?.close();
    eventsRef.current = null;
    storeId(null);
    const s = store();
    s.resetMeetingState();
    s.setError(null);
    s.setProvider(detectProvider(s.input));
  };

  return {
    meetingId,
    input,
    provider,
    bridgeState,
    brainState,
    micOn,
    camOn,
    error,
    notice,
    transcripts,
    connecting,
    busy,
    eventsConnected,
    chatOpen,
    inMeeting,
    sessionLive,
    status,
    setInput,
    setChatOpen: useMeetingScreenStore.getState().setChatOpen,
    connect,
    startBrain,
    stopBrain,
    toggleMic,
    toggleCam,
    leave,
    dismiss,
  };
}
