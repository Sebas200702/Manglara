/**
 * Cliente HTTP del panel de conocimiento.
 *
 * Todas las llamadas van a /api/* del propio origen: en Vercel un rewrite
 * las lleva a manglara-server y en desarrollo el proxy de Vite hace lo
 * mismo. La cookie de sesión (httpOnly) viaja sola; el navegador nunca ve
 * la clave ni la service key de Supabase.
 */

export interface KnowledgeSource {
  id: string;
  name: string;
  status: "processing" | "ready" | "error" | "archived";
  active: boolean;
  sort_order: number | null;
  version: number;
  origin: "api" | "upload" | "restore";
  page_count: number | null;
  digest_chars: number;
  created_at: string | null;
  updated_at: string | null;
  message: string | null;
}

export interface KnowledgeBudget {
  budget: number;
  used: number;
  over_budget: boolean;
  active_count: number;
  docs: { id: string; name: string; chars: number }[];
}

export interface KnowledgeEvent {
  id: string;
  document_id: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
}

export interface DocumentVersion {
  id: string;
  version: number;
  name: string;
  digest: string | null;
  page_count: number | null;
  storage_path: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export type JobStage =
  | "signed"
  | "extracting"
  | "embedding"
  | "digesting"
  | "done";

export interface JobState {
  status:
    | "signed"
    | "extracting"
    | "embedding"
    | "digesting"
    | "needs_continue"
    | "done"
    | "error";
  stage: JobStage | null;
  progress: number;
  chunks_total: number | null;
  chunks_done: number | null;
  document_id: string | null;
  error: string | null;
}

export interface InitUploadResult {
  job_id: string;
  upload_url: string;
  storage_path: string;
  filename: string;
}

export interface PromptPreview {
  doc_ids: string[];
  knowledge_chars: number;
  prompt_chars: number;
  prompt: string;
}

export class KnowledgeApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const NETWORK_ERROR_MESSAGE = "No se pudo contactar al servidor";

/** Spanish fallback when the response carries no usable `detail`. */
export function messageForStatus(status: number): string {
  if (status === 0) return NETWORK_ERROR_MESSAGE;
  if (status === 401) return "Tu sesión expiró. Vuelve a entrar.";
  if (status === 403) return "No tienes permiso para hacer esto.";
  if (status === 404) return "No encontramos lo que buscabas.";
  if (status === 413) return "El archivo es demasiado grande.";
  if (status === 429) return "Demasiados intentos. Espera un momento y vuelve a probar.";
  if (status === 502 || status === 503 || status === 504) {
    return "El servidor no está disponible en este momento. Inténtalo de nuevo en unos minutos.";
  }
  if (status >= 500) return "Algo falló en el servidor. Inténtalo de nuevo.";
  return `No se pudo completar la acción (error ${status}).`;
}

/** The session cookie is missing or expired: the user must log in again. */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof KnowledgeApiError && error.status === 401;
}

/** The server could not be reached or is failing (network error or 5xx). */
export function isServerUnreachable(error: unknown): boolean {
  return (
    error instanceof KnowledgeApiError && (error.status === 0 || error.status >= 500)
  );
}

/** Fetches `/api{path}`, mapping network and HTTP failures to KnowledgeApiError. */
async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}) },
    });
  } catch {
    throw new KnowledgeApiError(0, NETWORK_ERROR_MESSAGE);
  }
  if (!response.ok) {
    let detail = messageForStatus(response.status);
    try {
      const body = await response.json();
      if (typeof body.detail === "string" && body.detail.trim()) detail = body.detail;
    } catch {
      // non-JSON body (proxy page, gateway error): keep the status message
    }
    throw new KnowledgeApiError(response.status, detail);
  }
  return response;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  return response.json() as Promise<T>;
}

let sourcesInFlight: Promise<KnowledgeSource[]> | null = null;

export const knowledgeClient = {
  me: () => api<{ authenticated: boolean }>("/auth/me"),

  login: (password: string) =>
    api<{ ok: boolean }>("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }),

  logout: () => api<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  /** Concurrent callers share the same in-flight request. */
  listSources: () => {
    if (!sourcesInFlight) {
      sourcesInFlight = api<{ sources: KnowledgeSource[] }>("/knowledge/sources")
        .then((r) => r.sources)
        .finally(() => {
          sourcesInFlight = null;
        });
    }
    return sourcesInFlight;
  },

  setActive: (id: string, active: boolean) =>
    api<{ ok: boolean; active: boolean }>(`/knowledge/sources/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    }),

  reorder: (ids: string[]) =>
    api<{ ok: true }>(`/knowledge/sources/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }),

  archive: (id: string) =>
    api<{ ok: true }>(`/knowledge/sources/${id}/archive`, { method: "POST" }),

  restore: (id: string) =>
    api<{ ok: true }>(`/knowledge/sources/${id}/restore`, { method: "POST" }),

  delete: (id: string) =>
    api<{ ok: true }>(`/documents/${id}`, { method: "DELETE" }),

  listVersions: (id: string) =>
    api<{
      document_id: string;
      current_version: number;
      versions: DocumentVersion[];
    }>(`/knowledge/sources/${id}/versions`),

  restoreVersion: (id: string, version: number) =>
    api<{ ok: true; new_version: number }>(
      `/knowledge/sources/${id}/versions/${version}/restore`,
      { method: "POST" },
    ),

  download: (id: string) =>
    api<{ url: string }>(`/knowledge/sources/${id}/download`),

  budget: () => api<KnowledgeBudget>("/knowledge/budget"),

  preview: () => api<PromptPreview>("/knowledge/preview"),

  initUpload: (input: {
    filename: string;
    size: number;
    mode: "new" | "replace";
    document_id?: string;
  }) =>
    api<InitUploadResult>("/knowledge/uploads/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),

  /** Sube el archivo DIRECTO a Supabase Storage (URL firmada). */
  uploadFile: (uploadUrl: string, contentType: string, file: File) => {
    return fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: file,
    }).catch(() => {
      throw new KnowledgeApiError(0, "No se pudo subir el archivo: revisa tu conexión");
    }).then((r) => {
      if (!r.ok) {
        throw new KnowledgeApiError(r.status, `No se pudo subir el archivo (${r.status})`);
      }
    });
  },

  runJob: (jobId: string) =>
    api<JobState>(`/knowledge/jobs/${jobId}/run`, { method: "POST" }),

  jobStatus: (jobId: string) => api<JobState & { id: string; filename: string; mode: string }>(
    `/knowledge/jobs/${jobId}`,
  ),

  exportFile: (format: "md" | "json") =>
    request(`/knowledge/export?format=${format}`).then((r) => r.blob()),
};

export function contentTypeFor(filename: string): string {
  if (filename.toLowerCase().endsWith(".pdf")) return "application/pdf";
  return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}
