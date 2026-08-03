-- ============================================================
-- Migration 003: digest column on documents
-- Stores a condensed knowledge digest per document, generated at
-- ingest time and preloaded into the Gemini Live system prompt.
-- Run this in Supabase SQL Editor
-- ============================================================

ALTER TABLE documents ADD COLUMN IF NOT EXISTS digest TEXT;
