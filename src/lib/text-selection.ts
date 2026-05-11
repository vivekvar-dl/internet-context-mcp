import { trimToTokenBudget } from "./token-estimate.js";
import { rankChunksForTask, selectRankedChunks } from "./chunk-ranking.js";

export function selectRelevantText(
  text: string,
  query: string | undefined,
  maxTokens: number,
): string {
  const normalized = normalizeWhitespace(text);

  if (!query?.trim()) {
    return trimToTokenBudget(normalized, maxTokens);
  }

  const ranked = rankChunksForTask(normalized, query);

  if (ranked.length === 0) {
    return trimToTokenBudget(normalized, maxTokens);
  }

  const selected = selectRankedChunks(ranked, maxTokens, 0.05);

  return selected
    .map((item) => item.text.trim())
    .join("\n\n---\n\n");
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
