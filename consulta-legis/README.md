# Consulta Legis

RAG sobre o Código de Defesa do Consumidor (Lei nº 8.078/1990). Você pergunta em linguagem comum e a resposta cita o artigo, parágrafo ou inciso que a sustenta. A IA responde **somente** com os trechos recuperados da lei.

## Como rodar

Requisitos: Docker e uma chave do [OpenRouter](https://openrouter.ai/keys).

```sh
cp .env.example .env   # preencha OPENROUTER_API_KEY
docker compose up --build
```

Abra <http://localhost:3000> (outra porta: `PORT=3001` no `.env`).

Na primeira subida a aplicação baixa o CDC, divide em título › capítulo › seção › artigo › parágrafo › inciso › alínea e gera os embeddings. As próximas reaproveitam o banco.

### Sem Docker

Node.js 22+ e um PostgreSQL com `pgvector` apontado por `DATABASE_URL` no `.env`:

```sh
npm install
npm start
```

`npm run ingest` baixa a lei de novo e refaz os chunks.

## Como funciona

1. **Reescrita:** a IA transforma a pergunta em até 3 consultas com vocabulário do CDC.
2. **Busca híbrida:** referência exata ao artigo, full-text em português, trigramas e similaridade vetorial, expandindo para os dispositivos pai e filhos.
3. **Resposta:** o prompt do perfil (*Leigo* ou *Técnico*) recebe as fontes que cabem no limite de tokens e cita cada uma como `[Fonte N]`.

## Estrutura

```
web/index.html                 página única (HTML, CSS e JS)
src/server.ts                  servidor Express
src/openrouter.ts              chat e embeddings via OpenRouter
src/consulta-legis/
  config.ts                    modelos, preços e limites de tokens
  agent.ts                     prompts, reescrita e resposta
  law-parser.ts                parser da lei em hierarquia
  ingest.ts                    download da lei, chunks e embeddings
  repository.ts                consultas ao banco
  schema.ts                    tabelas e índices
  index.ts                     rotas /api/*
```
