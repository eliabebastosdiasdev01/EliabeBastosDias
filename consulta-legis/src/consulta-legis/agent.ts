import { openRouterChat, openRouterEmbed } from "../openrouter.js";
import { DEFAULT_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, LIMITS, MODELS, PRICE } from "./config.js";

export type Profile = "leigo" | "tecnico";

export type Intent = {
  actions: string[];
  entities: string[];
  references: string[];
  terms: string[];
};

export type Source = { label: string; text: string; path: string[] };

export const PROFILE_PROMPTS: Record<Profile, string> = {
  leigo: `Você é um assistente que explica direitos do consumidor para pessoas sem
conhecimento jurídico.

Regras:
- Responda usando SOMENTE as informações das fontes recuperadas abaixo.
- Se as fontes não contiverem a resposta, diga: "Não encontrei essa
  informação nas fontes disponíveis." Não use conhecimento externo.
- Use linguagem simples e frases curtas. Evite termos jurídicos; quando
  forem inevitáveis, explique-os em uma frase.
- Estruture a resposta em passos ou tópicos quando houver mais de uma ação
  possível para o consumidor.
- Cite cada afirmação com a fonte correspondente no formato [Fonte N],
  logo após a frase.

Fontes recuperadas:
{contexto}

Pergunta do usuário:
{pergunta}`,
  tecnico: `Você é um assistente jurídico especializado no Código de Defesa do
Consumidor (Lei nº 8.078/1990), atendendo profissionais da área.

Regras:
- Responda usando SOMENTE as informações das fontes recuperadas abaixo.
- Se as fontes não contiverem a resposta, diga: "Não encontrei essa
  informação nas fontes disponíveis." Não use conhecimento externo.
- Seja objetivo e preciso. Pode usar terminologia jurídica.
- Referencie artigos, incisos e parágrafos quando presentes nas fontes
  (ex.: "art. 6º, III, do CDC").
- Se houver mais de uma interpretação ou regra aplicável nas fontes,
  apresente todas, sem escolher uma.
- Cite cada afirmação com a fonte correspondente no formato [Fonte N],
  logo após a frase.

Fontes recuperadas:
{contexto}

Pergunta do usuário:
{pergunta}`,
};

export const REWRITE_PROMPT = `Reescreva a pergunta abaixo como uma consulta de busca sobre o Código de
Defesa do Consumidor, para melhorar a recuperação de trechos relevantes
em uma base vetorial.

Regras:
- Preserve exatamente a intenção original; não responda a pergunta.
- Traduza linguagem informal para termos jurídicos do CDC quando possível
  (ex.: "loja não quer trocar" → "vício do produto; prazo de troca;
  art. 18 e 26 do CDC").
- Gere até 3 variações curtas da consulta, uma por linha.
- Não adicione fatos que não estejam na pergunta.

Pergunta: {pergunta}`;

const ACTIONS: [string, RegExp][] = [
  ["prazo", /prazo|dias|conta|quando/],
  ["direito", /posso|direito|permit|pode/],
  ["consequencia", /acontece|consequencia|restitu|devolv|repar/],
  ["proibicao", /proibid|vedad|ilegal|pode fazer/],
];

export function pickModel(model: unknown) {
  return typeof model === "string" && MODELS.includes(model) ? model : DEFAULT_MODEL;
}

export function pickProfile(profile: unknown): Profile {
  return profile === "tecnico" ? "tecnico" : "leigo";
}
export function estimateTokens(text: string) {
  return Math.ceil(text.length / 3.5);
}

function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function cost(promptTokens: number, completionTokens: number) {
  return (promptTokens * PRICE.input + completionTokens * PRICE.output) / 1_000_000;
}

export function analyzeIntent(question: string): Intent {
  const normalized = question.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  return {
    actions: ACTIONS.filter(([, pattern]) => pattern.test(normalized)).map(([name]) => name),
    entities: ["consumidor", "fornecedor", "produto", "servico"].filter((word) => normalized.includes(word)),
    references: [...new Set([...question.matchAll(/\b(?:art(?:igo)?\.?\s*)?(\d{1,3})(?:\s*º)?/gi)].map((match) => `Art. ${match[1]}`))],
    terms: normalized.split(/\s+/).filter((word) => word.length > 3).slice(0, 24),
  };
}

export async function embed(texts: string[]) {
  const result = await openRouterEmbed(EMBEDDING_MODEL, texts, EMBEDDING_DIMENSIONS);
  return { ...result, costUsd: (result.tokens * PRICE.embedding) / 1_000_000 };
}
export async function rewriteQuestion(question: string, model: string) {
  const prompt = fill(REWRITE_PROMPT, { pergunta: question.slice(0, LIMITS.rewrite.input * 3) });
  try {
    const reply = await openRouterChat({
      model,
      temperature: 0,
      maxTokens: LIMITS.rewrite.output,
      messages: [{ role: "user", content: prompt }],
    });
    const queries = reply.text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["“]|["”]$/g, "").trim())
      .filter((line) => line.length > 2)
      .slice(0, 3);
    return { queries, promptTokens: reply.promptTokens, completionTokens: reply.completionTokens, costUsd: cost(reply.promptTokens, reply.completionTokens) };
  } catch (error) {
    console.warn("Reescrita indisponível:", error instanceof Error ? error.message : error);
    return { queries: [] as string[], promptTokens: 0, completionTokens: 0, costUsd: 0 };
  }
}
export function fitSources<T extends Source>(question: string, profile: Profile, sources: T[]) {
  const base = estimateTokens(fill(PROFILE_PROMPTS[profile], { contexto: "", pergunta: question }));
  const kept: T[] = [];
  let total = base;
  for (const source of sources) {
    const size = estimateTokens(formatSource(source, kept.length + 1)) + 1;
    if (total + size > LIMITS.answer.input) break;
    kept.push(source);
    total += size;
  }
  return { sources: kept, estimatedInput: total };
}

function formatSource(source: Source, n: number) {
  return `[Fonte ${n}] ${source.label} | ${source.path.join(" > ")}\n${source.text}`;
}

export async function answerWithSources(input: { question: string; profile: Profile; model: string; sources: Source[] }) {
  const contexto = input.sources.map((source, index) => formatSource(source, index + 1)).join("\n\n");
  const prompt = fill(PROFILE_PROMPTS[input.profile], { contexto, pergunta: input.question });
  const reply = await openRouterChat({
    model: input.model,
    temperature: 0.1,
    maxTokens: LIMITS.answer.output,
    messages: [{ role: "user", content: prompt }],
  });
  return {
    model: reply.model,
    content: reply.text || "Não foi possível gerar uma resposta.",
    promptTokens: reply.promptTokens,
    completionTokens: reply.completionTokens,
    costUsd: cost(reply.promptTokens, reply.completionTokens),
  };
}
