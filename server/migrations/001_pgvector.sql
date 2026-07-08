-- ============================================================
-- Migration 001: Enable pgvector + create document tables
-- Run this in Supabase SQL Editor
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    file_uri     TEXT,
    page_count   INTEGER,
    status       TEXT DEFAULT 'processing'
                    CHECK (status IN ('processing', 'ready', 'error')),
    message      TEXT,
    created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE chunks (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    page_num     INTEGER,
    chunk_index  INTEGER,
    embedding    vector(384),
    created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_chunks_document_id ON chunks(document_id);
CREATE INDEX idx_chunks_embedding
    ON chunks
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- ============================================================
-- After running SQL, create a Storage bucket named "documents"
-- in the Supabase Dashboard > Storage > New bucket
-- Make it private (access via service_role key)
-- ============================================================
