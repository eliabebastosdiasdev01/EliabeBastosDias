import { db } from "../db.js";
import type { Intent } from "./agent.js";

export type LawChunk = { id: string; parent_id: string | null; path: string[]; level: string; code: string | null; label: string; text: string; score: number };

export type Answer = {
  question: string;
  answer: string;
  profile: string;
  citations: unknown[];
  documents: unknown[];
  model: string;
  promptTokens: number;
  completionTokens: number;
  embeddingTokens: number;
  costUsd: number;
};

export async function saveAnswer(item: Answer) {
  await db().query(
    `INSERT INTO answers (question, answer, profile, citations, documents, model, prompt_tokens, completion_tokens, embedding_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      item.question,
      item.answer,
      item.profile,
      JSON.stringify(item.citations),
      JSON.stringify(item.documents),
      item.model,
      item.promptTokens,
      item.completionTokens,
      item.embeddingTokens,
      item.costUsd,
    ],
  );
}

export async function history(before: string | null, limit: number) {
  const { rows } = await db().query(
    `SELECT id::text, question, answer, profile, citations, documents, model,
            prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens"
     FROM answers
     WHERE $1::bigint IS NULL OR id < $1::bigint
     ORDER BY id DESC
     LIMIT $2`,
    [before, limit + 1],
  );
  return { items: rows.slice(0, limit), more: rows.length > limit };
}
const HEADINGS = ["titulo", "capitulo", "secao"];
const COMMON = new Set([
  "fornecedor", "fornecedores", "consumidor", "consumidores", "produto", "produtos", "servico", "servicos",
  "pode", "posso", "podem", "poderia", "direito", "direitos", "lei", "codigo", "cdc", "que", "qual", "quais",
  "como", "quando", "uma", "uns", "umas", "meu", "minha", "sobre", "para", "com", "sem", "isso", "esse", "essa",
]);
const fold = (word: string) => word.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export async function searchLaw(intent: Intent, question: string, embedding: number[] | null, limit = 12): Promise<LawChunk[]> {
  const terms = [...intent.terms, ...intent.entities, ...intent.actions, ...intent.references].filter(Boolean).join(" ") || question;
  const vector = embedding?.length ? `[${embedding.join(",")}]` : null;
  const lexical = [...new Set(question.split(/\s+/).map((term) => term.replace(/[^\p{L}\p{N}-]/gu, "")).filter((term) => term.length > 2 && !COMMON.has(fold(term))))]
    .slice(0, 24)
    .join(" OR ") || terms;
  const { rows } = await db().query<LawChunk>(
    `WITH ranked AS (
      SELECT c.*,
        CASE
          WHEN $2::text[] && c.path THEN 8
          WHEN c.code = ANY($2::text[]) THEN 20
          ELSE 0
        END
        + ts_rank_cd(c.search_vector, websearch_to_tsquery('portuguese', $4)) * 10
        + similarity(c.search_text, $1) * 4
        + CASE
            WHEN $3::text IS NOT NULL AND c.embedding IS NOT NULL
            THEN (1 - (c.embedding <=> $3::vector)) * 6
            ELSE 0
          END AS score
      FROM law_chunks c
      WHERE c.level <> ALL($5::text[])
        AND (c.search_vector @@ websearch_to_tsquery('portuguese', $4)
          OR c.search_text ILIKE '%' || $1 || '%'
          OR c.search_text % $1
          OR c.code = ANY($2::text[])
          OR ($3::text IS NOT NULL AND c.embedding IS NOT NULL))
      ORDER BY score DESC
      LIMIT 8
    ),
    related AS (
      SELECT c.*, r.score - 1 AS score
      FROM law_chunks c
      JOIN ranked r ON c.document_id = r.document_id
        AND (c.id = r.parent_id OR r.path @> c.path OR c.path @> r.path)
      WHERE c.id <> r.id AND c.level <> ALL($5::text[])
    ),
    combined AS (
      SELECT * FROM ranked
      UNION ALL
      SELECT * FROM related
    )
    SELECT DISTINCT ON (id) id, parent_id, path, level, code, label, text, score
    FROM combined
    ORDER BY id, score DESC`,
    [terms, intent.references, vector, lexical, HEADINGS],
  );
  return rows.sort((a, b) => Number(b.score) - Number(a.score)).slice(0, limit);
}

export type DocumentChunk = { id: string; parent_id: string | null; level: string; code: string | null; text: string };
export type LawDocument = { id: string; level: string; code: string | null; label: string; chunks: DocumentChunk[] };
export async function lawDocuments(chunkIds: string[]) {
  if (!chunkIds.length) return { documents: [] as LawDocument[], rootOf: new Map<string, string>() };
  const { rows: roots } = await db().query<{ start_id: string; root_id: string }>(
    `WITH RECURSIVE up AS (
      SELECT c.id AS start_id, c.id, c.parent_id, c.level FROM law_chunks c WHERE c.id = ANY($1::bigint[])
      UNION ALL
      SELECT up.start_id, p.id, p.parent_id, p.level FROM up JOIN law_chunks p ON p.id = up.parent_id WHERE up.level <> 'artigo'
    )
    SELECT s.id::text AS start_id, COALESCE(a.id, s.id)::text AS root_id
    FROM law_chunks s
    LEFT JOIN up a ON a.start_id = s.id AND a.level = 'artigo'
    WHERE s.id = ANY($1::bigint[])`,
    [chunkIds],
  );
  const rootOf = new Map(roots.map((row) => [row.start_id, row.root_id]));
  const { rows } = await db().query<DocumentChunk & { root_id: string; position: number; label: string; root_level: string }>(
    `WITH RECURSIVE down AS (
      SELECT c.id AS root_id, c.level AS root_level, c.id, c.parent_id, c.level, c.code, c.label, c.text, c.position
      FROM law_chunks c WHERE c.id = ANY($1::bigint[])
      UNION ALL
      SELECT d.root_id, d.root_level, c.id, c.parent_id, c.level, c.code, c.label, c.text, c.position
      FROM law_chunks c JOIN down d ON c.parent_id = d.id
      WHERE d.root_level = 'artigo'
    )
    SELECT root_id::text, root_level, id::text, parent_id::text, level, code, label, text, position
    FROM down ORDER BY root_id, position`,
    [[...new Set(rootOf.values())]],
  );
  const documents = new Map<string, LawDocument>();
  for (const row of rows) {
    if (row.id === row.root_id) documents.set(row.root_id, { id: row.root_id, level: row.level, code: row.code, label: row.label, chunks: [] });
    documents.get(row.root_id)?.chunks.push({ id: row.id, parent_id: row.parent_id, level: row.level, code: row.code, text: row.text });
  }
  return { documents: [...documents.values()], rootOf };
}

export async function fullLaw() {
  const doc = await db().query<{ title: string; ingested_at: string }>("SELECT title, ingested_at FROM law_documents ORDER BY ingested_at DESC LIMIT 1");
  const { rows } = await db().query<{ id: string; level: string; code: string | null; text: string }>(
    `SELECT c.id::text, c.level, c.code, c.text FROM law_chunks c
     WHERE c.document_id = (SELECT id FROM law_documents ORDER BY ingested_at DESC LIMIT 1)
     ORDER BY c.position`,
  );
  return { title: doc.rows[0]?.title ?? "", ingestedAt: doc.rows[0]?.ingested_at ?? null, chunks: rows };
}

export async function usageSummary() {
  const totals = await db().query(
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens + embedding_tokens), 0)::int AS total_tokens,
            COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd,
            COUNT(*)::int AS questions
     FROM answers`,
  );
  const recent = await db().query(
    `SELECT model, prompt_tokens, embedding_tokens, prompt_tokens + completion_tokens + embedding_tokens AS total_tokens, cost_usd, created_at
     FROM answers ORDER BY created_at DESC LIMIT 50`,
  );
  return { totals: totals.rows[0], recent: recent.rows };
}
