/**
 * User-facing (Spanish) messages for everything that can go wrong in a voice
 * call. Browser and server errors arrive in English or as raw exception text;
 * nothing from them should reach the screen unmapped.
 */
export const CALL_ERROR_MESSAGES = {
  micDenied:
    "No tenemos permiso para usar tu micrófono. Actívalo desde el ícono del candado, junto a la dirección de la página, y vuelve a intentarlo.",
  micNotFound: "No encontramos ningún micrófono. Conecta uno y vuelve a intentarlo.",
  micInUse:
    "Tu micrófono está ocupado por otra aplicación. Ciérrala y vuelve a intentarlo.",
  micConstraints: "Tu micrófono no es compatible con la llamada. Prueba con otro micrófono.",
  mediaUnsupported:
    "Este navegador no permite usar el micrófono aquí. Prueba con Chrome, Edge o Firefox actualizados.",
  network:
    "No pudimos conectar con Manglara. Revisa tu conexión a internet y vuelve a intentarlo.",
  timeout: "Manglara está tardando en responder. Intenta de nuevo en un momento.",
  originRejected:
    "Desde este sitio no se pueden iniciar llamadas con Manglara. Si el problema continúa, contacta a soporte.",
  serverUnavailable: "Manglara no está disponible en este momento. Intenta de nuevo en un momento.",
  reconnectFailed:
    "Se perdió la conexión con Manglara y no pudimos recuperarla. Vuelve a llamar cuando quieras.",
  unknown: "Algo salió mal al iniciar la llamada. Intenta de nuevo.",
} as const;

/** An error whose message is already safe to show to the user. */
export class CallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallError";
  }
}

const MEDIA_ERRORS: Record<string, string> = {
  NotAllowedError: CALL_ERROR_MESSAGES.micDenied,
  PermissionDeniedError: CALL_ERROR_MESSAGES.micDenied,
  SecurityError: CALL_ERROR_MESSAGES.mediaUnsupported,
  NotFoundError: CALL_ERROR_MESSAGES.micNotFound,
  DevicesNotFoundError: CALL_ERROR_MESSAGES.micNotFound,
  NotReadableError: CALL_ERROR_MESSAGES.micInUse,
  TrackStartError: CALL_ERROR_MESSAGES.micInUse,
  AbortError: CALL_ERROR_MESSAGES.micInUse,
  OverconstrainedError: CALL_ERROR_MESSAGES.micConstraints,
  ConstraintNotSatisfiedError: CALL_ERROR_MESSAGES.micConstraints,
};

function errorName(err: unknown): string | null {
  if (err && typeof err === "object" && "name" in err && typeof err.name === "string") {
    return err.name;
  }
  return null;
}

/** Maps a `getUserMedia` failure to an actionable Spanish message. */
export function describeMediaError(err: unknown): string {
  const name = errorName(err);
  return (name && MEDIA_ERRORS[name]) || CALL_ERROR_MESSAGES.unknown;
}

const BUSY_PATTERN = /atendiendo a muchas personas/i;

/** Maps an `{type: "error"}` message from the voice server. */
export function describeServerError(message: string): string {
  if (/origen no permitido/i.test(message)) return CALL_ERROR_MESSAGES.originRejected;
  // Already written for the user by the server.
  if (BUSY_PATTERN.test(message)) return message;
  return CALL_ERROR_MESSAGES.serverUnavailable;
}

/** Any error thrown while starting a call, as a message for the error banner. */
export function toUserMessage(err: unknown): string {
  if (err instanceof CallError) return err.message;
  return describeMediaError(err);
}
