# Runbook — Panel de conocimiento (Fase 1)

Gestión de lo que Manglara sabe: subir cartillas, activarlas, ordenarlas,
historial y respaldo. Para gestores no técnicos (Manglara team).

---

## Acceso

* URL: **`https://manglara.vercel.app/conocimiento`**
* Acceso = **una sola clave** (decisión de producto: gestor único).
* La clave vive SOLO como hash en la variable `ADMIN_PASSWORD_HASH`
  (formato `scrypt:N:r:p:salt:hash`) del proyecto **manglara-server** en
  Vercel. Nunca en el repo.
* Sesión: cookie `manglara_knowledge` firmada con HMAC (12 h). Sin CORS:
  la web hace proxy de `/api/*` al server (`web/vercel.json`), cookie
  first-party.
* Límite de intentos: 5 por minuto por IP.

### Reciclar la clave

```bash
python scripts/hash_password.py        # pregunta la nueva y reemplaza el hash en .env local
# copiar la línea ADMIN_PASSWORD_HASH=... a Vercel:
vercel env add ADMIN_PASSWORD_HASH production --cwd .. --scope <team>
# (o pegarla en Dashboard → manglara-server → Settings → Environment Variables)
# redeploy de manglara-server
```

La clave en claro vive en `scripts/.admin-password.secret` (git-ignored) para
compartirsela a la gestora. Borrarla de esa máquina si se recicla.

---

## Flujo del panel

1. **Subir** → *Nueva cartilla* (.pdf/.docx, ≤50MB). Funciona con el
   `Introduccion_Curriculo_Verde.docx` de 18MB porque el archivo sube
   **directo a Supabase Storage** con URL firmada y después una función
   de Vercel lo procesa por etapas (límite del body 4.5MB saltado).
2. **Procesar** → pipeline reanudable:
   `signed → extracting → embedding (por lotes) → digesting → done`.
   Si Vercel corta el run a los ~240s, el job queda `needs_continue` y el
   navegador vuelve a invocar `/run`: NADA se pierde (los chunks ya
   insertados se respetan vía `chunk_index` máximo).
3. **Activar** → toggle *Activa*. `documents.active` es la única fuente de
   verdad: la próxima sesión `/ws/voice` lee el set activo fresco de la BD
   (sin allowlists ni memoria de proceso).
4. **Ordenar** → arrastrar (o flechas en móvil). Guarda `sort_order`.
5. **Reemplazar** → icono ⟲ sobre la fila: sube el archivo nuevo; la
   versión anterior queda en `document_versions` (nombre, digest, páginas,
   ruta de Storage) y el archivo viejo se borra de Storage.
6. **Historial** → icono 🕑: lista de versiones; *Restaurar resumen* vuelve
   al digest de esa versión (el digest alimenta el preload del prompt; el
   archivo actual y los chunks se mantienen — restauro de CONOCIMIENTO, no
   de archivo: para volver al archivo original está "Descargar").
7. **Presupuesto** → barra 60.000 chars (MAX_KNOWLEDGE_CHARS en
   `pdf/digest.py`, igual que antes del panel). Lo que exceda no entra en
   la memoria de la llamada; el RAG igual findel contenido.
8. **Exportar** → respaldo completo JSON/Markdown (documentos+chunks+
   versiones+eventos). Copia periódica recomendada mientras el Supabase
   no esté bajo control propio del usuario.

---

## Operativa

```bash
# backend local con panel + auth
cd server && uvicorn main:app --port 3000   # usa .env del repo

# panel local
cd web && bun run dev        # /conocimiento ya proxía /api al 3000

# re-vectorizar todo tras cambiar de modelo de embeddings
python scripts/reembed_chunk_sources.py          # simulación
python scripts/reembed_chunk_sources.py --apply  # aplica (UPSERT merge)

# re-ingesta canónica desde cartillas/ (activa las 6)
python scripts/reload_knowledge.py --apply

# verificación puntual de RAG
python - <<'PY'
import sys, asyncio; sys.path.insert(0,'server')
async def m():
    import db
    from knowledge.embedding import embed_texts
    emb=(await embed_texts(["¿horas de formación?"], task_type="RETRIEVAL_QUERY"))[0]
    ids=[d["id"] for d in await db.list_active_documents()]
    print(await db.search_chunks_multi(ids, emb, top_k=3))
asyncio.run(m())
PY
```

## Estado actual

* Migración `006_knowledge_management.sql` aplicada (2026-10-17) en
  Supabase ref `rrtewkdcerikywdxwmtj` (vía pooler IPv4
  `aws-1-us-east-2.pooler.supabase.com`: la máquina local no tiene IPv6).
* 6 cartillas canónicas activas (`sort_order` 1-6), 55 chunks
  re-vectorizados con `gemini-embedding-2` a 384 dims (mayo 2026: con 2048
  tokens límite el `gemini-embedding-001` agotó cuota free en el primer
  intento).
* Pendiente de deploy: `ADMIN_PASSWORD_HASH` en Vercel + push de la rama.

## Riesgos conocidos

| Riesgo | Mitigación |
|---|---|
| Supabase no es del usuario | endpoint `/export` documentado arriba |
| Cuota free de embeddings (429) | backoff exponencial en `knowledge/embedding.py`; si persiste, cambiar `GEMINI_EMBEDDING_MODEL` |
| Serverless corta el run | `needs_continue` + re-run desde `chunks_done` |
| Clave compartida filtrada | `hash_password.py` recicla en 30s |
