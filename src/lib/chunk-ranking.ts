import { estimateTokens } from "./token-estimate.js";

export interface TextChunk {
  id: number;
  text: string;
  token_estimate: number;
  char_start: number;
  char_end: number;
  section: string | null;
  section_path: string[];
}

export interface RankedChunk extends TextChunk {
  score: number;
  normalized_score: number;
  matched_terms: string[];
  score_breakdown: {
    bm25: number;
    phrase: number;
    heading: number;
    metadata: number;
    structured_data: number;
    position: number;
  };
}

export interface RankChunksOptions {
  maxChunkChars?: number;
  minChunkChars?: number;
  headings?: string[];
  metadataText?: string;
  structuredDataText?: string;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "which",
  "with",
  "you",
  "your",
]);

const TASK_SYNONYMS: Record<string, string[]> = {
  api: ["api", "sdk", "endpoint", "reference", "developer", "docs"],
  auth: ["auth", "authentication", "authorization", "token", "oauth"],
  cache: ["cache", "cached", "caching", "store", "storage"],
  command: ["command", "terminal", "shell", "cli", "run"],
  config: ["config", "configuration", "settings", "mcp", "json"],
  docs: ["docs", "documentation", "guide", "reference", "api", "manual"],
  error: ["error", "exception", "failure", "failed", "troubleshoot"],
  feature: ["feature", "included", "includes", "support", "capability"],
  install: ["install", "installation", "setup", "package", "npm", "pip"],
  integration: ["integration", "connect", "plugin", "api", "webhook"],
  security: ["security", "safe", "permission", "sandbox", "read-only"],
  server: ["server", "service", "daemon", "process", "stdio"],
  tool: ["tool", "function", "capability", "mcp"],
};

export function chunkTextForRanking(
  text: string,
  options: RankChunksOptions = {},
): TextChunk[] {
  const maxChunkChars = options.maxChunkChars ?? 1_800;
  const minChunkChars = options.minChunkChars ?? 80;
  const normalizedText = normalizeWhitespaceForRanking(text);
  const paragraphs = splitParagraphsWithOffsets(normalizedText);
  const knownHeadings = new Set((options.headings ?? []).map(normalizeHeading));
  const chunks: TextChunk[] = [];
  let currentParagraphs: Array<{ text: string; start: number; end: number }> = [];
  let currentSection: string | null = null;
  let currentSectionPath: string[] = [];

  for (const paragraph of paragraphs) {
    const heading = detectHeading(paragraph.text, knownHeadings);

    if (heading) {
      pushChunk(chunks, currentParagraphs, currentSection, currentSectionPath, minChunkChars);
      currentParagraphs = [];
      currentSection = heading;
      currentSectionPath = [heading];
    }

    if (
      currentParagraphs.length > 0 &&
      paragraph.end - currentParagraphs[0].start > maxChunkChars
    ) {
      pushChunk(chunks, currentParagraphs, currentSection, currentSectionPath, minChunkChars);
      currentParagraphs = [];
    }

    currentParagraphs.push(paragraph);
  }

  pushChunk(chunks, currentParagraphs, currentSection, currentSectionPath, minChunkChars);

  return chunks;
}

export function rankChunksForTask(
  text: string,
  task: string,
  options: RankChunksOptions = {},
): RankedChunk[] {
  const chunks = chunkTextForRanking(text, options);
  const queryTerms = expandTaskTerms(tokenize(task));
  const metadataTerms = tokenize(options.metadataText ?? "");
  const structuredTerms = tokenize(options.structuredDataText ?? "");

  if (chunks.length === 0) {
    return [];
  }

  if (queryTerms.length === 0) {
    return chunks.map((chunk, index) => ({
      ...chunk,
      score: index === 0 ? 1 : 0,
      normalized_score: index === 0 ? 1 : 0,
      matched_terms: [],
      score_breakdown: {
        bm25: index === 0 ? 1 : 0,
        phrase: 0,
        heading: 0,
        metadata: 0,
        structured_data: 0,
        position: 0,
      },
    }));
  }

  const tokenizedChunks = chunks.map((chunk) => tokenize(chunk.text));
  const avgLength =
    tokenizedChunks.reduce((sum, tokens) => sum + tokens.length, 0) /
    tokenizedChunks.length;
  const documentFrequency = calculateDocumentFrequency(tokenizedChunks, queryTerms);
  const scored = chunks.map((chunk, index) => {
    const tokens = tokenizedChunks[index];
    const termFrequency = calculateTermFrequency(tokens);
    const matchedTerms = queryTerms.filter((term) => termFrequency.has(term));
    const bm25 = bm25Score({
      queryTerms,
      termFrequency,
      documentFrequency,
      documentLength: tokens.length,
      averageDocumentLength: avgLength,
      documentCount: chunks.length,
    });
    const phrase = phraseBonus(chunk.text, task);
    const heading = headingBoost(chunk, queryTerms);
    const metadata = externalSignalBoost(tokens, metadataTerms, queryTerms, 0.35);
    const structuredData = externalSignalBoost(
      tokens,
      structuredTerms,
      queryTerms,
      0.45,
    );
    const position = index === 0 ? 0.05 : 0;
    const score = bm25 + phrase + heading + metadata + structuredData + position;

    return {
      ...chunk,
      score,
      normalized_score: 0,
      matched_terms: matchedTerms,
      score_breakdown: {
        bm25,
        phrase,
        heading,
        metadata,
        structured_data: structuredData,
        position,
      },
    };
  });

  const maxScore = Math.max(...scored.map((chunk) => chunk.score), 0);

  return scored
    .map((chunk) => ({
      ...chunk,
      score: Number(chunk.score.toFixed(4)),
      normalized_score:
        maxScore === 0 ? 0 : Number((chunk.score / maxScore).toFixed(4)),
      score_breakdown: {
        bm25: Number(chunk.score_breakdown.bm25.toFixed(4)),
        phrase: Number(chunk.score_breakdown.phrase.toFixed(4)),
        heading: Number(chunk.score_breakdown.heading.toFixed(4)),
        metadata: Number(chunk.score_breakdown.metadata.toFixed(4)),
        structured_data: Number(chunk.score_breakdown.structured_data.toFixed(4)),
        position: Number(chunk.score_breakdown.position.toFixed(4)),
      },
    }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
}

export function selectRankedChunks(
  rankedChunks: RankedChunk[],
  maxTokens: number,
  minNormalizedScore = 0,
): RankedChunk[] {
  const selected: RankedChunk[] = [];
  let tokenCount = 0;

  for (const chunk of rankedChunks) {
    if (chunk.normalized_score < minNormalizedScore && selected.length > 0) {
      continue;
    }

    if (tokenCount + chunk.token_estimate > maxTokens && selected.length > 0) {
      continue;
    }

    selected.push(chunk);
    tokenCount += chunk.token_estimate;

    if (tokenCount >= maxTokens) {
      break;
    }
  }

  return selected.sort((a, b) => a.id - b.id);
}

function splitParagraphsWithOffsets(
  text: string,
): Array<{ text: string; start: number; end: number }> {
  const paragraphs: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /\S[\s\S]*?(?=\n{2,}|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    const raw = match[0];
    const trimmed = raw.trim();

    if (!trimmed) {
      continue;
    }

    const leadingWhitespace = raw.search(/\S/);
    const start = match.index + Math.max(leadingWhitespace, 0);
    const end = start + trimmed.length;

    paragraphs.push({
      text: trimmed,
      start,
      end,
    });
  }

  return paragraphs;
}

function pushChunk(
  chunks: TextChunk[],
  paragraphs: Array<{ text: string; start: number; end: number }>,
  section: string | null,
  sectionPath: string[],
  minChunkChars: number,
): void {
  if (paragraphs.length === 0) {
    return;
  }

  const text = normalizeWhitespaceForRanking(
    paragraphs.map((paragraph) => paragraph.text).join("\n\n"),
  );

  if (!text || text.length < minChunkChars) {
    return;
  }

  chunks.push({
    id: chunks.length + 1,
    text,
    token_estimate: estimateTokens(text),
    char_start: paragraphs[0].start,
    char_end: paragraphs.at(-1)?.end ?? paragraphs[0].end,
    section,
    section_path: sectionPath,
  });
}

function detectHeading(paragraph: string, knownHeadings: Set<string>): string | null {
  const normalized = normalizeHeading(paragraph);

  if (knownHeadings.has(normalized)) {
    return paragraph;
  }

  if (
    paragraph.length <= 80 &&
    !/[.!?]$/.test(paragraph) &&
    /^[A-Z0-9][A-Za-z0-9 /:_-]+$/.test(paragraph)
  ) {
    return paragraph;
  }

  return null;
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function normalizeWhitespaceForRanking(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function expandTaskTerms(terms: string[]): string[] {
  return Array.from(
    new Set(terms.flatMap((term) => TASK_SYNONYMS[term] ?? [term])),
  );
}

function calculateDocumentFrequency(
  tokenizedChunks: string[][],
  queryTerms: string[],
): Map<string, number> {
  const frequency = new Map<string, number>();

  for (const term of queryTerms) {
    let count = 0;

    for (const tokens of tokenizedChunks) {
      if (tokens.includes(term)) {
        count += 1;
      }
    }

    frequency.set(term, count);
  }

  return frequency;
}

function calculateTermFrequency(tokens: string[]): Map<string, number> {
  const frequency = new Map<string, number>();

  for (const token of tokens) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  return frequency;
}

function bm25Score(input: {
  queryTerms: string[];
  termFrequency: Map<string, number>;
  documentFrequency: Map<string, number>;
  documentLength: number;
  averageDocumentLength: number;
  documentCount: number;
}): number {
  const k1 = 1.4;
  const b = 0.75;
  let score = 0;

  for (const term of input.queryTerms) {
    const tf = input.termFrequency.get(term) ?? 0;

    if (tf === 0) {
      continue;
    }

    const df = input.documentFrequency.get(term) ?? 0;
    const idf = Math.log(
      1 + (input.documentCount - df + 0.5) / Math.max(df + 0.5, 1),
    );
    const denominator =
      tf +
      k1 *
        (1 -
          b +
          b * (input.documentLength / Math.max(input.averageDocumentLength, 1)));

    score += idf * ((tf * (k1 + 1)) / denominator);
  }

  return score;
}

function phraseBonus(chunkText: string, task: string): number {
  const normalizedChunk = chunkText.toLowerCase();
  const meaningfulPhrases = task
    .toLowerCase()
    .split(/[,.;:]/)
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.split(/\s+/).length >= 2);
  let bonus = 0;

  for (const phrase of meaningfulPhrases) {
    if (normalizedChunk.includes(phrase)) {
      bonus += 1.5;
    }
  }

  return bonus;
}

function headingBoost(chunk: TextChunk, queryTerms: string[]): number {
  const sectionTerms = tokenize([chunk.section, ...chunk.section_path].join(" "));
  const matches = queryTerms.filter((term) => sectionTerms.includes(term)).length;

  return matches * 0.25;
}

function externalSignalBoost(
  chunkTerms: string[],
  externalTerms: string[],
  queryTerms: string[],
  weight: number,
): number {
  if (externalTerms.length === 0) {
    return 0;
  }

  const chunkSet = new Set(chunkTerms);
  const externalSet = new Set(externalTerms);
  const matchedQueryTerms = queryTerms.filter(
    (term) => chunkSet.has(term) && externalSet.has(term),
  );

  return matchedQueryTerms.length * weight;
}
