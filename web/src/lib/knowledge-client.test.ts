import { afterEach, describe, expect, test } from "bun:test";
import { contentTypeFor, knowledgeClient } from "./knowledge-client";

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
});
