import type { CleanBlock } from "./clean-html.js";

export interface SourceBlockMatch {
  block_id: number;
  tag: string;
  dom_path: string;
  line_start: number | null;
  line_end: number | null;
  section: string | null;
  section_path: string[];
  overlap_score: number;
  text_preview: string;
}

export function mapChunkToSourceBlocks(
  chunkText: string,
  blocks: CleanBlock[],
  limit = 5,
): SourceBlockMatch[] {
  const normalizedChunk = normalizeForMatch(chunkText);
  const chunkTerms = significantTerms(normalizedChunk);

  if (!normalizedChunk || chunkTerms.size === 0) {
    return [];
  }

  return blocks
    .map((block) => {
      const normalizedBlock = normalizeForMatch(block.text);
      const lexicalScore = overlapScore(chunkTerms, significantTerms(normalizedBlock));
      const containmentScore = containmentBonus(normalizedChunk, normalizedBlock);
      const overlap = Math.min(1, lexicalScore + containmentScore);

      return {
        block,
        overlap,
      };
    })
    .filter((item) => item.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.block.id - b.block.id)
    .slice(0, limit)
    .map(({ block, overlap }) => ({
      block_id: block.id,
      tag: block.tag,
      dom_path: block.dom_path,
      line_start: block.line_start,
      line_end: block.line_end,
      section: block.section,
      section_path: block.section_path,
      overlap_score: Number(overlap.toFixed(4)),
      text_preview: preview(block.text),
    }));
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function significantTerms(value: string): Set<string> {
  const stopWords = new Set([
    "and",
    "are",
    "but",
    "for",
    "from",
    "into",
    "that",
    "the",
    "this",
    "with",
    "your",
  ]);

  return new Set(
    value
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 2 && !stopWords.has(term)),
  );
}

function overlapScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const term of left) {
    if (right.has(term)) {
      shared += 1;
    }
  }

  return shared / Math.max(left.size, 1);
}

function containmentBonus(chunk: string, block: string): number {
  if (!chunk || !block) {
    return 0;
  }

  if (chunk.includes(block)) {
    return 0.45;
  }

  if (block.includes(chunk)) {
    return 0.65;
  }

  return 0;
}

function preview(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();

  if (trimmed.length <= 220) {
    return trimmed;
  }

  return `${trimmed.slice(0, 217)}...`;
}
