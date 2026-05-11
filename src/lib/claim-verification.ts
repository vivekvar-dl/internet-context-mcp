import type { RankedChunk } from "./chunk-ranking.js";
import { classifyNli } from "./nli-classifier.js";

export type ClaimVerdict = "supported" | "refuted" | "unclear";

export interface ChunkClaimMatch {
  chunk_id: number;
  section: string | null;
  score: number;
  matched_terms: string[];
  contains_negation: boolean;
  text_preview: string;
  nli_label?: "entailment" | "neutral" | "contradiction";
  nli_score?: number;
}

export interface ClaimAgainstSource {
  verdict: ClaimVerdict;
  confidence: number;
  reasons: string[];
  method: "nli" | "regex_fallback";
  supporting_chunks: ChunkClaimMatch[];
  refuting_chunks: ChunkClaimMatch[];
}

const NEGATION_PATTERNS = [
  /\bnot\b/i,
  /\bnever\b/i,
  /\bno longer\b/i,
  /\bcannot\b/i,
  /\bcan't\b/i,
  /\bdoesn't\b/i,
  /\bdoes not\b/i,
  /\bisn't\b/i,
  /\bis not\b/i,
  /\bdid not\b/i,
  /\bwithout\b/i,
  /\bdeprecated\b/i,
  /\bunsupported\b/i,
  /\bdisabled\b/i,
  /\bfalse\b/i,
];

export async function verifyClaimAgainst(
  claim: string,
  ranked: RankedChunk[],
  options: { topN?: number; minScore?: number; useNli?: boolean } = {},
): Promise<ClaimAgainstSource> {
  const topN = options.topN ?? 6;
  const minScore = options.minScore ?? 0.25;
  const claimTerms = significantTerms(claim);

  if (ranked.length === 0 || claimTerms.length === 0) {
    return {
      verdict: "unclear",
      confidence: 0,
      reasons:
        ranked.length === 0 ? ["no_chunks"] : ["no_significant_claim_terms"],
      method: "regex_fallback",
      supporting_chunks: [],
      refuting_chunks: [],
    };
  }

  const candidates = ranked.slice(0, topN).filter((chunk) => {
    if (chunk.normalized_score < minScore) {
      return false;
    }
    // Require at least one meaningful term to keep the NLI batch small.
    const coverage = termCoverage(chunk.matched_terms, claimTerms);
    return coverage >= 0.25;
  });

  if (candidates.length === 0) {
    return {
      verdict: "unclear",
      confidence: 0,
      reasons: ["no_chunks_passed_term_coverage"],
      method: "regex_fallback",
      supporting_chunks: [],
      refuting_chunks: [],
    };
  }

  const useNli = options.useNli ?? true;
  let nliResults: Awaited<ReturnType<typeof classifyNli>> = null;
  if (useNli) {
    nliResults = await classifyNli(
      candidates.map((chunk) => ({
        premise: chunk.text,
        hypothesis: claim,
      })),
    );
  }

  if (nliResults && nliResults.length === candidates.length) {
    return aggregateFromNli(candidates, nliResults, claimTerms);
  }

  return aggregateFromRegex(candidates, claim, claimTerms);
}

function aggregateFromNli(
  candidates: RankedChunk[],
  nliResults: NonNullable<Awaited<ReturnType<typeof classifyNli>>>,
  claimTerms: string[],
): ClaimAgainstSource {
  const supporting: ChunkClaimMatch[] = [];
  const refuting: ChunkClaimMatch[] = [];
  const reasons: string[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const chunk = candidates[i];
    const result = nliResults[i];
    if (!result) {
      continue;
    }

    const match: ChunkClaimMatch = {
      chunk_id: chunk.id,
      section: chunk.section,
      score: chunk.normalized_score,
      matched_terms: chunk.matched_terms.slice(0, 12),
      contains_negation: result.label === "contradiction",
      text_preview: preview(chunk.text),
      nli_label: result.label,
      nli_score: result.score,
    };

    if (result.label === "entailment" && result.score >= 0.4) {
      supporting.push(match);
    } else if (result.label === "contradiction" && result.score >= 0.4) {
      refuting.push(match);
    }
    // neutral or low-confidence: discard
  }

  const supportSignal = aggregateScore(supporting);
  const refuteSignal = aggregateScore(refuting);

  if (supporting.length === 0 && refuting.length === 0) {
    reasons.push("all_chunks_neutral_or_low_confidence");
    return {
      verdict: "unclear",
      confidence: 0.2,
      reasons,
      method: "nli",
      supporting_chunks: [],
      refuting_chunks: [],
    };
  }

  let verdict: ClaimVerdict;
  if (supportSignal > refuteSignal * 1.5) {
    verdict = "supported";
    reasons.push("majority_entailment_chunks");
  } else if (refuteSignal > supportSignal * 1.5) {
    verdict = "refuted";
    reasons.push("majority_contradiction_chunks");
  } else {
    verdict = "unclear";
    reasons.push("conflicting_entailment_and_contradiction");
  }

  const confidence = Number(
    Math.min(
      1,
      Math.abs(supportSignal - refuteSignal) /
        Math.max(supportSignal + refuteSignal, 1) +
        0.2,
    ).toFixed(4),
  );

  return {
    verdict,
    confidence: verdict === "unclear" ? Math.min(confidence, 0.5) : confidence,
    reasons,
    method: "nli",
    supporting_chunks: supporting,
    refuting_chunks: refuting,
  };
}

function aggregateFromRegex(
  candidates: RankedChunk[],
  claim: string,
  claimTerms: string[],
): ClaimAgainstSource {
  const supporting: ChunkClaimMatch[] = [];
  const refuting: ChunkClaimMatch[] = [];

  for (const chunk of candidates) {
    const coverage = termCoverage(chunk.matched_terms, claimTerms);
    if (coverage < 0.4) {
      continue;
    }

    const negation = chunkContainsNegationNearTerms(chunk.text, claimTerms);
    const match: ChunkClaimMatch = {
      chunk_id: chunk.id,
      section: chunk.section,
      score: chunk.normalized_score,
      matched_terms: chunk.matched_terms.slice(0, 12),
      contains_negation: negation,
      text_preview: preview(chunk.text),
    };
    if (negation) {
      refuting.push(match);
    } else {
      supporting.push(match);
    }
  }

  const supportSignal = aggregateScore(supporting);
  const refuteSignal = aggregateScore(refuting);
  const reasons: string[] = [];
  let verdict: ClaimVerdict;

  if (supportSignal === 0 && refuteSignal === 0) {
    verdict = "unclear";
    reasons.push("no_chunks_passed_term_coverage");
  } else if (supportSignal > refuteSignal * 1.5) {
    verdict = "supported";
    reasons.push("majority_supporting_chunks");
  } else if (refuteSignal > supportSignal * 1.5) {
    verdict = "refuted";
    reasons.push("majority_refuting_chunks");
  } else {
    verdict = "unclear";
    reasons.push("mixed_or_conflicting_chunks");
  }

  const confidence = Number(
    Math.min(1, Math.abs(supportSignal - refuteSignal) / 2 + 0.2).toFixed(4),
  );

  return {
    verdict,
    confidence: verdict === "unclear" ? Math.min(confidence, 0.5) : confidence,
    reasons,
    method: "regex_fallback",
    supporting_chunks: supporting,
    refuting_chunks: refuting,
  };
}

export function combineVerdicts(
  perSource: Array<{ url: string; result: ClaimAgainstSource }>,
): { verdict: ClaimVerdict; confidence: number; reasons: string[] } {
  const supported = perSource.filter(
    (entry) => entry.result.verdict === "supported",
  );
  const refuted = perSource.filter(
    (entry) => entry.result.verdict === "refuted",
  );
  const reasons: string[] = [];

  if (supported.length > 0 && refuted.length === 0) {
    reasons.push(`${supported.length}_sources_support`);
    return {
      verdict: "supported",
      confidence: averageConfidence(supported),
      reasons,
    };
  }
  if (refuted.length > 0 && supported.length === 0) {
    reasons.push(`${refuted.length}_sources_refute`);
    return {
      verdict: "refuted",
      confidence: averageConfidence(refuted),
      reasons,
    };
  }
  if (supported.length > 0 && refuted.length > 0) {
    reasons.push("sources_conflict");
    return { verdict: "unclear", confidence: 0.4, reasons };
  }
  reasons.push("no_source_returned_a_verdict");
  return { verdict: "unclear", confidence: 0.1, reasons };
}

function aggregateScore(matches: ChunkClaimMatch[]): number {
  return matches.reduce((sum, match) => sum + match.score, 0);
}

function averageConfidence(
  entries: Array<{ result: ClaimAgainstSource }>,
): number {
  if (entries.length === 0) {
    return 0;
  }
  const total = entries.reduce((sum, entry) => sum + entry.result.confidence, 0);
  return Number((total / entries.length).toFixed(4));
}

function significantTerms(claim: string): string[] {
  const stopWords = new Set([
    "and",
    "are",
    "but",
    "for",
    "from",
    "has",
    "have",
    "into",
    "that",
    "the",
    "this",
    "with",
    "your",
    "you",
    "was",
    "were",
    "will",
    "should",
    "could",
    "would",
    "any",
    "all",
    "its",
    "their",
    "they",
    "them",
  ]);

  return Array.from(
    new Set(
      claim
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length > 2 && !stopWords.has(term)),
    ),
  );
}

function termCoverage(matched: string[], claimTerms: string[]): number {
  if (claimTerms.length === 0) {
    return 0;
  }
  const matchedSet = new Set(matched.map((term) => term.toLowerCase()));
  const overlap = claimTerms.filter((term) => matchedSet.has(term)).length;
  return overlap / claimTerms.length;
}

function chunkContainsNegationNearTerms(
  text: string,
  claimTerms: string[],
): boolean {
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const hasTerm = claimTerms.some((term) => lower.includes(term));
    if (!hasTerm) {
      continue;
    }
    if (NEGATION_PATTERNS.some((pattern) => pattern.test(lower))) {
      return true;
    }
  }
  return false;
}

function preview(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 240) {
    return trimmed;
  }
  return `${trimmed.slice(0, 237)}...`;
}
