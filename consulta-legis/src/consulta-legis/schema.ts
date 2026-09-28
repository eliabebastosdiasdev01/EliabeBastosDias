import { db } from "../db.js";
import { EMBEDDING_DIMENSIONS } from "./config.js";

const SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS law_documents (
  id BIGSERIAL PRIMARY KEY,
  source_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS law_chunks (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES law_documents(id) ON DELETE CASCADE,
  parent_id BIGINT REFERENCES law_chunks(id) ON DELETE CASCADE,
  path TEXT[] NOT NULL,
  level TEXT NOT NULL,
  code TEXT,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  search_text TEXT NOT NULL,
  position INTEGER NOT NULL,
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('portuguese', coalesce(label, '') || ' ' || coalesce(search_text, ''))
  ) STORED,
  embedding vector(${EMBEDDING_DIMENSIONS}),
  UNIQUE(document_id, path, position)
);

CREATE INDEX IF NOT EXISTS law_chunks_search_vector_idx ON law_chunks USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS law_chunks_search_text_trgm_idx ON law_chunks USING GIN(search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS law_chunks_code_idx ON law_chunks(code);
CREATE INDEX IF NOT EXISTS law_chunks_path_idx ON law_chunks USING GIN(path);
CREATE INDEX IF NOT EXISTS law_chunks_embedding_idx ON law_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS answers (
  id BIGSERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  profile TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]',
  documents JSONB NOT NULL DEFAULT '[]',
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  embedding_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function migrate() {
  await db().query(SQL);
}
