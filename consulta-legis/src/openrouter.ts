export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function openRouterChat(input: { model: string; messages: ChatMessage[]; temperature?: number; maxTokens?: number }) {
  const data = await call("/chat/completions", {
    model: input.model,
    messages: input.messages,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
  }) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  return {
    text: data.choices?.[0]?.message?.content?.trim() ?? "",
    model: input.model,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

export async function openRouterEmbed(model: string, texts: string[], dimensions: number) {
  const data = await call("/embeddings", { model, input: texts, dimensions }) as {
    data?: { index: number; embedding: number[] }[];
    usage?: { prompt_tokens?: number };
  };
  return {
    vectors: (data.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding),
    tokens: data.usage?.prompt_tokens ?? 0,
  };
}

async function call(route: string, body: Record<string, unknown>) {
  const response = await fetch(`https://openrouter.ai/api/v1${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || `openrouter_${response.status}`);
  return data;
}
