import * as cheerio from "cheerio";

export type LawNode = { level: string; code: string | null; label: string; text: string; path: string[]; parentIndex: number | null; position: number };

const LEVELS: [string, RegExp][] = [
  ["livro", /^LIVRO\b/],
  ["titulo", /^T[ÍI]TULO\b/],
  ["capitulo", /^CAP[ÍI]TULO\b/],
  ["secao", /^SE[ÇC][ÃA]O\b/],
  ["artigo", /^Art\.?\s*\d+/],
  ["paragrafo", /^(?:§\s*\d+|Par[aá]grafo [uú]nico)/],
  ["inciso", /^[IVXLCDM]+\s*[-–—]/],
  ["alinea", /^[a-z]\s*(?:\)|[-–—])/],
];

const SPLIT = /(?=(?:\bArt\.\s*\d+|§\s*\d+|Parágrafo único|\b[IVXLCDM]+\s*[-–—]\s))/;

function classify(text: string) {
  return LEVELS.find(([, pattern]) => pattern.test(text))?.[0] ?? "texto";
}

function codeFor(level: string, text: string) {
  if (level === "artigo") {
    const number = text.match(/Art\.?\s*(\d+(?:-[A-Z])?)/)?.[1];
    return number ? `Art. ${number}` : null;
  }
  if (level === "paragrafo") {
    const number = text.match(/§\s*(\d+)/)?.[1];
    return number ? `§ ${number}` : "Parágrafo único";
  }
  return null;
}

function markdownBlocks(content: string) {
  const body = content.includes("Markdown Content:") ? content.slice(content.indexOf("Markdown Content:") + 17) : content;
  return body
    .split(/\n\s*\n/)
    .map((block) => block
      .replace(/~~[^~]*~~/g, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^(?:\s*>)+/gm, "")
      .replace(/([^\s*])\*\*(?=\p{L})/gu, "$1 ")
      .replace(/\*\*|__|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "")
      .replace(/\s+/g, " ")
      .replace(/\)(?=\p{L})/gu, ") ")
      .trim())
    .filter((block) => block.length >= 3 && block !== "*");
}

function htmlBlocks(content: string) {
  const $ = cheerio.load(content);
  const blocks: string[] = [];
  $("body *").each((_, element) => {
    if ($(element).children().length) return;
    const text = $(element).text().replace(/\s+/g, " ").trim();
    if (text.length >= 3) blocks.push(...text.split(SPLIT).map((part) => part.trim()).filter((part) => part.length > 2));
  });
  return blocks;
}

export function parseLaw(content: string) {
  const blocks = /<(?:html|body|p|div)\b/i.test(content) ? htmlBlocks(content) : markdownBlocks(content);
  const nodes: LawNode[] = [];
  const stack: { depth: number; label: string; index: number }[] = [];
  for (const text of blocks) {
    const level = classify(text);
    const known = LEVELS.findIndex(([name]) => name === level);
    const depth = known === -1 ? (stack.at(-1)?.depth ?? -1) + 1 : known;
    if (level !== "texto") while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
    const node: LawNode = {
      level,
      code: codeFor(level, text),
      label: text.slice(0, 140),
      text,
      path: [...stack.map((item) => item.label), text.slice(0, 90)],
      parentIndex: stack.at(-1)?.index ?? null,
      position: nodes.length,
    };
    nodes.push(node);
    if (level !== "texto") stack.push({ depth, label: node.label, index: nodes.length - 1 });
  }
  return nodes;
}
