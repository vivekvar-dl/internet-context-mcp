import type { CrossSourceChunk } from "./cross-source-rank.js";
import { cosineSimilarity, embedTexts } from "./embeddings.js";
import { classifyNli } from "./nli-classifier.js";

export interface Contradiction {
  a: ContradictionSide;
  b: ContradictionSide;
  confidence: number;
  topical_similarity: number;
  reason: string;
}

export interface ContradictionSide {
  cluster_id: number;
  source_index: number;
  source_url: string;
  source_title: string | null;
  chunk_id: number;
  text_preview: string;
}

const PREVIEW_CHARS = 400;
const EMBED_PREVIEW_CHARS = 700;
const ENTAILMENT_CEILING_FOR_CONTRADICTION = 0.05;

// Two chunks need to be at least *plausibly on the same topic* before we'll
// call bidirectional non-entailment a contradiction. Tuned higher than the
// clustering threshold (0.5) because real-world disagreements paraphrase the
// same claim with opposite polarity and tend to score very high cosine
// (~0.9). Floor of 0.45 separates the Paris-style "same entity, different
// aspects" noise (~0.35) from real "same claim, opposite stance" signal.
const TOPICAL_SIMILARITY_FLOOR = 0.45;

export async function detectContradictions(
  rankedClusters: CrossSourceChunk[],
  options: { topK?: number; topicalFloor?: number } = {},
): Promise<Contradiction[]> {
  const topK = options.topK ?? 6;
  const topicalFloor = options.topicalFloor ?? TOPICAL_SIMILARITY_FLOOR;
  const candidates = rankedClusters.slice(0, topK);

  // Pairs of chunks from DIFFERENT sources. We *do* allow same-cluster pairs
  // here because real-world contradictions (e.g. "coffee lowers risk" vs
  // "coffee raises risk") paraphrase the same claim with opposite polarity
  // and typically have cosine ~0.9, which puts them in the same cluster.
  // The topical-similarity prefilter below is what excludes unrelated pairs.
  const pairs: Array<{
    aIdx: number;
    bIdx: number;
    a: CrossSourceChunk;
    b: CrossSourceChunk;
  }> = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (candidates[i].source_index === candidates[j].source_index) {
        continue;
      }
      pairs.push({ aIdx: i, bIdx: j, a: candidates[i], b: candidates[j] });
    }
  }

  if (pairs.length === 0) {
    return [];
  }

  // Topical prefilter: embed every candidate once, compute cosine per pair,
  // and drop pairs below the floor before paying for NLI inference.
  const vectors = await embedTexts(
    candidates.map((chunk) => chunk.text.slice(0, EMBED_PREVIEW_CHARS)),
  );

  const survivingPairs: Array<{
    a: CrossSourceChunk;
    b: CrossSourceChunk;
    topical_similarity: number;
  }> = [];

  if (vectors && vectors.length === candidates.length) {
    for (const pair of pairs) {
      const sim = cosineSimilarity(vectors[pair.aIdx], vectors[pair.bIdx]);
      if (sim >= topicalFloor) {
        survivingPairs.push({ a: pair.a, b: pair.b, topical_similarity: sim });
      }
    }
  } else {
    // No embedding model available — fall back to running NLI on every pair
    // (v0.4.0 behaviour). Mark topical_similarity as NaN so callers can tell.
    for (const pair of pairs) {
      survivingPairs.push({ a: pair.a, b: pair.b, topical_similarity: Number.NaN });
    }
  }

  if (survivingPairs.length === 0) {
    return [];
  }

  const premises: Array<{ premise: string; hypothesis: string }> = [];
  for (const pair of survivingPairs) {
    premises.push({
      premise: pair.a.text.slice(0, PREVIEW_CHARS),
      hypothesis: pair.b.text.slice(0, PREVIEW_CHARS),
    });
    premises.push({
      premise: pair.b.text.slice(0, PREVIEW_CHARS),
      hypothesis: pair.a.text.slice(0, PREVIEW_CHARS),
    });
  }

  const nli = await classifyNli(premises);
  if (!nli) {
    return [];
  }

  const contradictions: Contradiction[] = [];
  for (let i = 0; i < survivingPairs.length; i += 1) {
    const ab = nli[i * 2];
    const ba = nli[i * 2 + 1];
    if (!ab || !ba) {
      continue;
    }
    if (
      ab.score <= ENTAILMENT_CEILING_FOR_CONTRADICTION &&
      ba.score <= ENTAILMENT_CEILING_FOR_CONTRADICTION
    ) {
      const confidence = Number(
        (1 - (ab.score + ba.score) / 2).toFixed(4),
      );
      contradictions.push({
        a: makeSide(survivingPairs[i].a),
        b: makeSide(survivingPairs[i].b),
        confidence,
        topical_similarity: Number(
          (survivingPairs[i].topical_similarity || 0).toFixed(4),
        ),
        reason: "bidirectional_non_entailment_on_topical_pair",
      });
    }
  }

  return contradictions;
}

function makeSide(chunk: CrossSourceChunk): ContradictionSide {
  return {
    cluster_id: chunk.cluster_id,
    source_index: chunk.source_index,
    source_url: chunk.source_url,
    source_title: chunk.source_title,
    chunk_id: chunk.chunk_id,
    text_preview:
      chunk.text.length <= 240
        ? chunk.text.replace(/\s+/g, " ").trim()
        : `${chunk.text.slice(0, 237).replace(/\s+/g, " ").trim()}...`,
  };
}
