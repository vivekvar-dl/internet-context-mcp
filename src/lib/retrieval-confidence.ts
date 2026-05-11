import type { RankedChunk } from "./chunk-ranking.js";

export type RetrievalConfidence = "high" | "medium" | "low";

export interface RetrievalConfidenceSummary {
  level: RetrievalConfidence;
  score: number;
  reasons: string[];
  suggestion: string | null;
}

interface AssessInput {
  task: string;
  rankedChunks: RankedChunk[];
  selectedChunks: RankedChunk[];
  maxTokens: number;
}

export function assessRetrievalConfidence(input: AssessInput): RetrievalConfidenceSummary {
  const reasons: string[] = [];
  const queryTermCount = countQueryTerms(input.task);
  const top = input.selectedChunks[0];
  const topScore = top?.normalized_score ?? 0;
  const matchedTermCoverage = topMatchCoverage(top, queryTermCount);
  const selectedTokens = input.selectedChunks.reduce(
    (sum, chunk) => sum + chunk.token_estimate,
    0,
  );
  const tokenFill = input.maxTokens > 0 ? selectedTokens / input.maxTokens : 0;

  if (input.selectedChunks.length === 0) {
    return {
      level: "low",
      score: 0,
      reasons: ["no_chunks_selected"],
      suggestion: "Call web_read with a wider token budget or revise the task wording.",
    };
  }

  if (topScore < 0.35) {
    reasons.push("low_top_score");
  }

  if (matchedTermCoverage < 0.34 && queryTermCount > 1) {
    reasons.push("few_query_terms_matched");
  }

  if (input.selectedChunks.length === 1 && tokenFill < 0.2) {
    reasons.push("very_short_evidence");
  }

  const score = Number(
    Math.min(
      1,
      topScore * 0.6 + matchedTermCoverage * 0.3 + Math.min(tokenFill, 0.5) * 0.2,
    ).toFixed(4),
  );

  const level: RetrievalConfidence =
    reasons.length === 0 && score >= 0.6
      ? "high"
      : reasons.length >= 2 || score < 0.3
        ? "low"
        : "medium";

  const suggestion =
    level === "low"
      ? "Consider broader web_search or re-running web_context with a larger max_tokens budget or a more specific task."
      : level === "medium"
        ? "Returned context may be partial. The host agent should treat conclusions as tentative or follow up with web_search."
        : null;

  return { level, score, reasons, suggestion };
}

function countQueryTerms(task: string): number {
  return task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2).length;
}

function topMatchCoverage(
  top: RankedChunk | undefined,
  queryTermCount: number,
): number {
  if (!top || queryTermCount === 0) {
    return 0;
  }

  return Math.min(1, top.matched_terms.length / queryTermCount);
}
