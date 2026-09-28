export const MODELS = ["openai/gpt-4o-mini"];
export const DEFAULT_MODEL = MODELS[0];
export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const LAW_SOURCE_URL = "https://planalto.gov.br/ccivil_03/leis/l8078compilado.htm";
export const QUESTION_MAX_CHARS = 500;

export const PRICE = { input: 0.15, output: 0.6, embedding: 0.02 };

export const LIMITS = {
  rewrite: { input: 400, output: 150 },
  answer: { input: 9000, output: 3000 },
};
