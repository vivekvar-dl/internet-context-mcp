import type { RankedChunk } from "./chunk-ranking.js";

const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

type CrossEncoderPipeline = (
  inputs: { text: string; text_pair: string }[],
  options?: Record<string, unknown>,
) => Promise<Array<{ score: number; label?: string }>>;

let pipelinePromise: Promise<CrossEncoderPipeline | null> | null = null;

async function loadPipeline(model: string): Promise<CrossEncoderPipeline | null> {
  if (pipelinePromise) {
    return pipelinePromise;
  }

  pipelinePromise = (async () => {
    try {
      const mod = (await import("@huggingface/transformers")) as {
        pipeline: (
          task: string,
          model: string,
          options?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      const pipe = (await mod.pipeline("text-classification", model, {
        quantized: true,
      })) as CrossEncoderPipeline;
      return pipe;
    } catch (error) {
      process.stderr.write(
        `[internet-context-mcp] reranker disabled, transformer load failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return null;
    }
  })();

  return pipelinePromise;
}

export interface RerankOptions {
  model?: string;
  topN?: number;
  weight?: number;
}

export async function rerankChunks(
  query: string,
  chunks: RankedChunk[],
  options: RerankOptions = {},
): Promise<RankedChunk[]> {
  const topN = options.topN ?? 12;
  const weight = options.weight ?? 1.0;
  const model = options.model ?? DEFAULT_MODEL;

  if (chunks.length === 0) {
    return chunks;
  }

  const pipe = await loadPipeline(model);
  if (!pipe) {
    return chunks;
  }

  const candidates = chunks.slice(0, topN);
  const inputs = candidates.map((chunk) => ({
    text: query,
    text_pair: chunk.text,
  }));

  let scores: number[];
  try {
    const results = await pipe(inputs);
    scores = results.map((r) => r.score);
  } catch (error) {
    process.stderr.write(
      `[internet-context-mcp] reranker inference error: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return chunks;
  }

  const maxScore = Math.max(...scores, 1e-9);
  const reranked = candidates.map((chunk, idx) => {
    const rerankNormalized = scores[idx] / maxScore;
    const blended = chunk.normalized_score + weight * rerankNormalized;
    return {
      ...chunk,
      normalized_score: Number((blended / (1 + weight)).toFixed(4)),
      score: Number(blended.toFixed(4)),
    };
  });

  reranked.sort((a, b) => b.normalized_score - a.normalized_score || a.id - b.id);

  const rest = chunks.slice(topN);
  return [...reranked, ...rest];
}

export function rerankerEnabled(): boolean {
  return process.env.INTERNET_CONTEXT_MCP_RERANK === "1";
}
