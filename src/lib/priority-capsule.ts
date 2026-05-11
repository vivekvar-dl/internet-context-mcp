import type { RankedChunk } from "./chunk-ranking.js";

export interface PriorityCapsule {
  tldr: string;
  top_sections: string[];
  highlight_chunk_ids: number[];
}

export function buildPriorityCapsule(
  selectedChunks: RankedChunk[],
  maxSentences = 3,
): PriorityCapsule {
  if (selectedChunks.length === 0) {
    return { tldr: "", top_sections: [], highlight_chunk_ids: [] };
  }

  const ranked = [...selectedChunks].sort(
    (a, b) => b.normalized_score - a.normalized_score || a.id - b.id,
  );
  const sentences: string[] = [];
  const sectionsSeen = new Set<string>();
  const topSections: string[] = [];
  const highlightIds: number[] = [];

  for (const chunk of ranked) {
    if (highlightIds.length < maxSentences) {
      highlightIds.push(chunk.id);
    }

    const section = chunk.section ?? null;

    if (section && !sectionsSeen.has(section)) {
      sectionsSeen.add(section);
      topSections.push(section);
    }

    for (const sentence of extractSentences(chunk.text)) {
      if (sentences.length >= maxSentences) {
        break;
      }

      if (!sentences.includes(sentence)) {
        sentences.push(sentence);
      }
    }

    if (sentences.length >= maxSentences) {
      break;
    }
  }

  return {
    tldr: sentences.join(" "),
    top_sections: topSections.slice(0, 5),
    highlight_chunk_ids: highlightIds,
  };
}

function extractSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 30 && sentence.length <= 280);
}
