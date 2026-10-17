-- ============================================================
-- Migration 006: knowledge management (Fase 1 — cartillas)
-- Añade la columna de gestión de conocimiento al panel
-- (gestor + panel web): activos, orden, versiones, jobs y auditoría.
-- Todas las operaciones son ADITIVAS (creación de columnas/tablas);
-- los dos UPDATE solo cambian datos, no estructuras.
-- Se puede ejecutar varias veces (idempotente).
-- Ejecutar en Supabase SQL Editor o con psql:
--   psql "$SUPABASE_DB_URL" -f server/migrations/006_knowledge_management.sql
-- ============================================================

-- 1) Columnas de gestión en documents -----------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sort_order INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE documents ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'api';
    -- origin: 'api' (creado por script/servidor), 'upload' (panel), 'restore'

-- 2) Historial por documento (snapshot en cada reemplazo) ---------
CREATE TABLE IF NOT EXISTS document_versions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    name         TEXT NOT NULL,
    digest       TEXT,
    page_count   INTEGER,
    storage_path TEXT,
    file_uri     TEXT,
    note         TEXT,
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, version)
);
CREATE INDEX IF NOT EXISTS idx_document_versions_document_id
    ON document_versions (document_id, version DESC);

-- 3) Jobs de ingesta reanudable ----------------------------------
-- status: signed | paid   -- estados usados por el pipeline:
--   signed    → file at Storage, waiting run
--   extracting→ read text
--   chunking  → build chunks
--   embedding → vectorize chunks by batches (resumable via chunks_done)
--   digesting → Gemini digest being generated (optional)
--   needs_continue → soft timeout hit, call /run again
--   done      → success
--   error     → failed (see error)
CREATE TABLE IF NOT EXISTS knowledge_jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  UUID REFERENCES documents(id) ON DELETE SET NULL,
    filename     TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    mode         TEXT NOT NULL DEFAULT 'new',            -- new | replace
    status       TEXT NOT NULL DEFAULT 'signed',
    stage        TEXT,                                   -- 'documents' | 'chunks' | 'digest'
    progress     INTEGER NOT NULL DEFAULT 0,             -- 0-100
    chunks_total INTEGER,
    chunks_done  INTEGER,
    error        TEXT,
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_updated_at
    ON knowledge_jobs (updated_at DESC);

-- 4) Auditoría ----------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
                -- upload | replace | activate | deactivate | archive |
                -- unarchive | reorder | restore | digest | error
    detail      JSONB,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_events_created_at
    ON knowledge_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_events_document_id
    ON knowledge_events (document_id, created_at DESC);

-- 5) Índices que usa el panel --------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_active_order
    ON documents (active, sort_order);

-- 6) Seed: marcar activas las cartillas de currículo ya ingeridas;
--    respeta el orden canónico que antes vivía hardcodeado en
--    server/pdf/sources.py (CURRICULUM_SOURCES).
UPDATE documents
SET active = TRUE,
    sort_order = sub.rn
FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY name) AS rn
    FROM documents
    WHERE name IN (
        'Introduccion_Curriculo_Verde.docx',
        '2_Modulo1_HabilidadesVerdes.docx',
        '3_Modulo2_HabilidadesVerdes.docx',
        '4_Modulo3_HabilidadesVerdes.docx',
        '5_Modulo4_HabilidadesVerdes.docx',
        '6_Modulo5_HabilidadesVerdes.docx'
    ) AND status = 'ready'
) AS sub
WHERE documents.id = sub.id;

-- ------------------------------------------------------------
-- Rollback (solo si hace falta; NO automático):
--   ALTER TABLE documents DROP COLUMN IF EXISTS origin;
--   ALTER TABLE documents DROP COLUMN IF EXISTS updated_at;
--   ALTER TABLE documents DROP COLUMN IF EXISTS version;
--   ALTER TABLE documents DROP COLUMN IF EXISTS sort_order;
--   ALTER TABLE documents DROP COLUMN IF EXISTS active;
--   DROP TABLE IF EXISTS knowledge_events;
--   DROP TABLE IF EXISTS knowledge_jobs;
--   DROP TABLE IF EXISTS document_versions;
--   (documents.unique_name si existe)
-- Los datos de versiones/jobs/events se pierden. Las columnas
-- active/sort_order se conservan para poder revertir el código.
-- ------------------------------------------------------------
