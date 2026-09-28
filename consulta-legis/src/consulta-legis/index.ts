import express from "express";
import { analyzeIntent, answerWithSources, embed, fitSources, pickModel, pickProfile, PROFILE_PROMPTS, REWRITE_PROMPT, rewriteQuestion } from "./agent.js";
import { DEFAULT_MODEL, LAW_SOURCE_URL, LIMITS, MODELS, QUESTION_MAX_CHARS } from "./config.js";
import * as repo from "./repository.js";
import type { LawChunk, LawDocument } from "./repository.js";

export const router = express.Router();

router.get("/models", (_req, res) => {
  res.json({ models: MODELS, defaultModel: DEFAULT_MODEL });
});

router.get("/prompts", (_req, res) => {
  res.json({ profiles: PROFILE_PROMPTS, rewrite: REWRITE_PROMPT, limits: LIMITS });
});

router.get("/law", async (_req, res) => {
  res.json({ url: LAW_SOURCE_URL, ...(await repo.fullLaw()) });
});

router.get("/usage", async (_req, res) => {
  res.json(await repo.usageSummary());
});

router.get("/history", async (req, res) => {
  const before = typeof req.query.before === "string" && /^\d{1,18}$/.test(req.query.before) ? req.query.before : null;
  const page = await repo.history(before, 4);
  res.json({
    more: page.more,
    items: page.items.reverse().map(({ promptTokens, completionTokens, ...item }) => ({ ...item, usage: { promptTokens, completionTokens } })),
  });
});

router.post("/chat", async (req, res) => {
  const question = String(req.body?.question ?? "").trim();
  if (question.length < 3 || question.length > QUESTION_MAX_CHARS) return res.status(400).json({ error: "invalid_question_length" });
  const model = pickModel(req.body?.model);
  const profile = pickProfile(req.body?.profile);
  try {
    const rewrite = await rewriteQuestion(question, model);
    const queries = [question, ...rewrite.queries];
    let embedding = { vectors: [] as number[][], tokens: 0, costUsd: 0 };
    try {
      embedding = await embed(queries);
    } catch (error) {
      console.warn("Busca vetorial indisponível; usando busca lexical:", error instanceof Error ? error.message : error);
    }
    const found = await Promise.all(queries.map((query, index) => repo.searchLaw(analyzeIntent(query), query, embedding.vectors[index] ?? null)));
    const chunks = fitSources(question, profile, mergeResults(found)).sources;
    const response = chunks.length
      ? await answerWithSources({ question, profile, model, sources: chunks })
      : { model, content: "Não encontrei essa informação nas fontes disponíveis.", promptTokens: 0, completionTokens: 0, costUsd: 0 };
    const usage = {
      model: response.model,
      promptTokens: response.promptTokens + rewrite.promptTokens,
      completionTokens: response.completionTokens + rewrite.completionTokens,
      embeddingTokens: embedding.tokens,
      costUsd: response.costUsd + rewrite.costUsd + embedding.costUsd,
    };
    const { documents, rootOf } = await repo.lawDocuments(chunks.map((chunk) => chunk.id));
    const citations = chunks.map((chunk) => citationFor(chunk, rootOf.get(chunk.id) ?? chunk.id, documents));
    const lawDocs = documents.map((doc) => ({ ...doc, url: lawUrl(doc) }));
    await repo.saveAnswer({ question, answer: response.content, profile, citations, documents: lawDocs, ...usage });
    res.json({ answer: response.content, profile, citations, documents: lawDocs, usage });
  } catch (error) {
    console.error("Falha na consulta:", error);
    res.status(502).json({ error: "chat_unavailable", message: error instanceof Error ? error.message : "" });
  }
});

function mergeResults(lists: LawChunk[][]) {
  const best = new Map<string, LawChunk>();
  for (const chunk of lists.flat()) {
    const seen = best.get(chunk.id);
    if (!seen || Number(chunk.score) > Number(seen.score)) best.set(chunk.id, chunk);
  }
  return [...best.values()].sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 12);
}

function lawUrl(doc: LawDocument) {
  const opening = doc.chunks[0]?.text.split(/\s+/).slice(0, 6).join(" ");
  return opening ? `${LAW_SOURCE_URL}#:~:text=${encodeURIComponent(opening)}` : LAW_SOURCE_URL;
}

function referenceFor(chunkId: string, doc: LawDocument | undefined, fallback: string) {
  if (!doc) return fallback.slice(0, 48);
  const byId = new Map(doc.chunks.map((chunk) => [chunk.id, chunk]));
  const parts: string[] = [];
  for (let chunk = byId.get(chunkId); chunk; chunk = chunk.parent_id ? byId.get(chunk.parent_id) : undefined) {
    if (chunk.level === "artigo" && chunk.code) parts.unshift(chunk.code);
    else if (chunk.level === "paragrafo" && chunk.code) parts.unshift(chunk.code === "Parágrafo único" ? "parágrafo único" : `${chunk.code}º`);
    else if (chunk.level === "inciso") parts.unshift(chunk.text.match(/^([IVXLCDM]+)/i)?.[1] ?? "");
    else if (chunk.level === "alinea") parts.unshift(`alínea ${chunk.text.match(/^([a-z])/i)?.[1] ?? ""}`);
  }
  const reference = parts.filter(Boolean).join(", ");
  return reference || (doc.code ?? fallback).slice(0, 48);
}

function citationFor(chunk: LawChunk, documentId: string, documents: LawDocument[]) {
  const doc = documents.find((item) => item.id === documentId);
  return { id: chunk.id, documentId, reference: referenceFor(chunk.id, doc, chunk.label), label: chunk.label, path: chunk.path, text: chunk.text };
}
