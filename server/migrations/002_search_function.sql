-- Functions for vector similarity search via Supabase REST API (rpc)
-- Run this in Supabase SQL Editor

-- Search within a single document
CREATE OR REPLACE FUNCTION search_chunks(
    p_document_id UUID,
    p_embedding vector(384),
    p_top_k INTEGER DEFAULT 5
)
RETURNS TABLE(content TEXT, page_num INTEGER, chunk_index INTEGER, distance FLOAT)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT c.content, c.page_num, c.chunk_index,
           (c.embedding <=> p_embedding) AS distance
    FROM chunks c
    WHERE c.document_id = p_document_id
    ORDER BY c.embedding <=> p_embedding
    LIMIT p_top_k;
END;
$$;

-- Search across multiple documents
CREATE OR REPLACE FUNCTION search_chunks_multi(
    p_document_ids UUID[],
    p_embedding vector(384),
    p_top_k INTEGER DEFAULT 10
)
RETURNS TABLE(content TEXT, page_num INTEGER, chunk_index INTEGER, distance FLOAT)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT c.content, c.page_num, c.chunk_index,
           (c.embedding <=> p_embedding) AS distance
    FROM chunks c
    WHERE c.document_id = ANY(p_document_ids)
    ORDER BY c.embedding <=> p_embedding
    LIMIT p_top_k;
END;
$$;
