-- Enable required extensions for Owletto
-- This runs once when the database is first created

-- pg_trgm: Fuzzy text search (trigram matching)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- vector: pgvector for embedding storage and similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify extensions are loaded
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION 'pg_trgm extension failed to load';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'vector extension failed to load';
  END IF;

  RAISE NOTICE 'All required extensions loaded successfully';
END
$$;
