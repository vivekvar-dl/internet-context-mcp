import type { CrossSourceChunk } from "./cross-source-rank.js";
import { classifyNli } from "./nli-classifier.js";

export interface Contradiction {
  a: ContradictionSide;
  b: ContradictionSide;
  confidence: number; // average of bidirectional non-entailment
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
const ENTAILMENT_CEILING_FOR_CONTRADICTION = 0.05;

export async function detectContradictions(
  rankedClusters: CrossSourceChunk[],
  options: { topK?: number } = {},
): Promise<Contradiction[]> {
  const topK = options.topK ?? 6;
  const candidates = rankedClusters.slice(0, topK);

  // Pairs of clusters from DIFFERENT sources only.
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
      if (candidates[i].cluster_id === candidates[j].cluster_id) {
        continue;
      }
      pairs.push({ aIdx: i, bIdx: j, a: candidates[i], b: candidates[j] });
    }
  }

  if (pairs.length === 0) {
    return [];
  }

  const premises: Array<{ premise: string; hypothesis: string }> = [];
  for (const pair of pairs) {
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
  for (let i = 0; i < pairs.length; i += 1) {
    const ab = nli[i * 2];
    const ba = nli[i * 2 + 1];
    if (!ab || !ba) {
      continue;
    }
    // Both directions need to show LOW entailment for us to call it a real
    // contradiction. High entailment one-way + neutral other way = not a
    // contradiction, just one source being more specific.
    if (
      ab.score <= ENTAILMENT_CEILING_FOR_CONTRADICTION &&
      ba.score <= ENTAILMENT_CEILING_FOR_CONTRADICTION
    ) {
      const confidence = Number(
        (1 - (ab.score + ba.score) / 2).toFixed(4),
      );
      contradictions.push({
        a: makeSide(pairs[i].a),
        b: makeSide(pairs[i].b),
        confidence,
        reason: "bidirectional_non_entailment",
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
