-- ============================================================
-- Migration 004: allow an 'archived' document status
-- Archived documents stay stored (rows + chunks + digest) but are
-- excluded from activation, so they never reach the Gemini Live
-- system prompt or the retrieval search. This is how a superseded
-- document is invalidated without losing it. Fully reversible: the
-- /api/documents/{id}/unarchive endpoint sets the status back to 'ready'.
-- Run this in Supabase SQL Editor (or apply via SUPABASE_DB_URL).
-- ============================================================

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
    CHECK (status IN ('processing', 'ready', 'error', 'archived'));
