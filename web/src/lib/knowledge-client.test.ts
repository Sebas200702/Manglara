import { afterEach, describe, expect, test } from "bun:test";
import {
  contentTypeFor,
  isSessionExpired,
  isServerUnreachable,
  KnowledgeApiError,
  knowledgeClient,
} from "./knowledge-client";

const originalFetch = globalThis.fetch;
const calls: { url: string; init?: RequestInit }[] = [];

function fakeFetch(body: unknown, status = 200) {
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

describe("knowledge-client", () => {
  test("las llamadas van por /api del propio origen (sin VITE_BACKEND_URL)", async () => {
    fakeFetch({ authenticated: true });
    await knowledgeClient.me();
    expect(calls[0]?.url).toBe("/api/auth/me");
  });

  test("login manda la clave en el body y no en la URL", async () => {
    fakeFetch({ ok: true });
    await knowledgeClient.login("clave-secreta");
    expect(calls[0]?.url).toBe("/api/auth/login");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.password).toBe("clave-secreta");
    expect(String(calls[0]?.url).includes("clave-secreta")).toBe(false);
  });

  test("errores de la API exponen el detail de FastAPI", async () => {
    fakeFetch({ detail: "La clave no es correcta" }, 401);
    let message = "";
    try {
      await knowledgeClient.login("mala");
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    expect(message).toBe("La clave no es correcta");
  });

  test("reorder manda los ids en el nuevo orden", async () => {
    fakeFetch({ ok: true });
    await knowledgeClient.reorder(["b", "a", "c"]);
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.ids).toEqual(["b", "a", "c"]);
  });

  test("initUpload separa modo y documento", async () => {
    fakeFetch({ job_id: "j1", upload_url: "https://supa/signed", storage_path: "p", filename: "a.pdf" });
    await knowledgeClient.initUpload({
      filename: "a.pdf",
      size: 100,
      mode: "replace",
      document_id: "doc1",
    });
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({ filename: "a.pdf", size: 100, mode: "replace", document_id: "doc1" });
  });

  test("contentTypeFor mapea docx y pdf", () => {
    expect(contentTypeFor("modulo crafted.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(contentTypeFor("cartilla.PDF")).toBe("application/pdf");
  });

  test("un fallo de red se envuelve como KnowledgeApiError(0) en español", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    let error: unknown;
    try {
      await knowledgeClient.me();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(KnowledgeApiError);
    expect((error as KnowledgeApiError).status).toBe(0);
    expect((error as KnowledgeApiError).message).toBe("No se pudo contactar al servidor");
    expect(isServerUnreachable(error)).toBe(true);
  });

  test("respuestas sin JSON se traducen según el estado", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("<html>Bad Gateway</html>", { status: 502 }))) as unknown as typeof fetch;
    let error: unknown;
    try {
      await knowledgeClient.listSources();
    } catch (e) {
      error = e;
    }
    expect((error as KnowledgeApiError).status).toBe(502);
    expect((error as KnowledgeApiError).message).toStartWith("El servidor no está disponible");
    expect(isServerUnreachable(error)).toBe(true);
  });

  test("un 401 se detecta por estado aunque el detail sea otro texto", async () => {
    fakeFetch({ detail: "No autenticado" }, 401);
    let error: unknown;
    try {
      await knowledgeClient.archive("doc1");
    } catch (e) {
      error = e;
    }
    expect(isSessionExpired(error)).toBe(true);
    expect(isServerUnreachable(error)).toBe(false);
    expect(isSessionExpired(new Error("Error 401"))).toBe(false);
  });

  test("exportFile usa el mismo manejo de errores", async () => {
    fakeFetch({ detail: "No autenticado" }, 401);
    let error: unknown;
    try {
      await knowledgeClient.exportFile("md");
    } catch (e) {
      error = e;
    }
    expect(isSessionExpired(error)).toBe(true);
    expect(calls[0]?.url).toBe("/api/knowledge/export?format=md");
  });

  test("listSources reutiliza la petición en vuelo", async () => {
    fakeFetch({ sources: [{ id: "a" }] });
    const [first, second] = await Promise.all([
      knowledgeClient.listSources(),
      knowledgeClient.listSources(),
    ]);
    expect(calls.length).toBe(1);
    expect(first).toBe(second);
    await knowledgeClient.listSources();
    expect(calls.length).toBe(2);
  });
});
