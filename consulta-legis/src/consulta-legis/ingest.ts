import { db } from "../db.js";
import { embed } from "./agent.js";
import { LAW_SOURCE_URL } from "./config.js";
import { parseLaw } from "./law-parser.js";
import { migrate } from "./schema.js";

const ifEmpty = process.argv.includes("--if-empty");

function decode(buffer: ArrayBuffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

async function fetchSource() {
  const urls = [
    LAW_SOURCE_URL,
    LAW_SOURCE_URL.replace("https://planalto.gov.br", "https://www.planalto.gov.br"),
    "https://r.jina.ai/http://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm",
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) return decode(await response.arrayBuffer());
    } catch {}
  }
  throw new Error("Não foi possível baixar a lei.");
}

async function ingestLaw() {
  const html = await fetchSource();
  const nodes = parseLaw(html);
  const client = await db().connect();
  const ids: string[] = [];
  try {
    await client.query("BEGIN");
    const document = await client.query<{ id: string }>(
      `INSERT INTO law_documents (source_url, title) VALUES ($1, $2)
       ON CONFLICT (source_url) DO UPDATE SET ingested_at = now()
       RETURNING id`,
      [LAW_SOURCE_URL, "Código de Defesa do Consumidor"],
    );
    const documentId = document.rows[0].id;
    await client.query("DELETE FROM law_chunks WHERE document_id = $1", [documentId]);
    for (const node of nodes) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO law_chunks (document_id, parent_id, path, level, code, label, text, search_text, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          documentId,
          node.parentIndex === null ? null : ids[node.parentIndex],
          node.path,
          node.level,
          node.code,
          node.label,
          node.text,
          `${node.path.join(" ")} ${node.text}`,
          node.position,
        ],
      );
      ids.push(result.rows[0].id);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.log(`Ingestão concluída: ${nodes.length} chunks em ${LAW_SOURCE_URL}`);
}

async function embedMissing() {
  for (;;) {
    const { rows } = await db().query<{ id: string; search_text: string }>(
      "SELECT id::text, search_text FROM law_chunks WHERE embedding IS NULL ORDER BY position LIMIT 32",
    );
    if (!rows.length) break;
    const result = await embed(rows.map((row) => row.search_text));
    await db().query(
      `UPDATE law_chunks c SET embedding = v.embedding::vector
       FROM unnest($1::bigint[], $2::text[]) AS v(id, embedding)
       WHERE c.id = v.id`,
      [rows.map((row) => row.id), result.vectors.map((vector) => `[${vector.join(",")}]`)],
    );
    console.log(`Embeddings: +${rows.length}`);
  }
}

try {
  await migrate();
  const { rows } = await db().query<{ chunks: number }>("SELECT COUNT(*)::int AS chunks FROM law_chunks");
  if (ifEmpty && rows[0].chunks > 0) console.log(`Lei já ingerida (${rows[0].chunks} chunks).`);
  else await ingestLaw();
  await embedMissing().catch((error) => console.warn("Embeddings interrompidos:", error instanceof Error ? error.message : error));
} finally {
  await db().end();
}
