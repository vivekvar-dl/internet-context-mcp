// Local sentence embeddings via Transformers.js feature-extraction.
// Lazy-loads ~22MB of Xenova/all-MiniLM-L6-v2 on first call (cached after).
// Used by cross-source-rank.ts to detect paraphrased agreement.

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

type FeatureExtractionPipeline = (
  input: string | string[],
  options?: Record<string, unknown>,
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let pipelinePromise: Promise<FeatureExtractionPipeline | null> | null = null;

async function loadPipeline(model: string): Promise<FeatureExtractionPipeline | null> {
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
      const pipe = (await mod.pipeline(
        "feature-extraction",
        model,
      )) as FeatureExtractionPipeline;
      return pipe;
    } catch (error) {
      process.stderr.write(
        `[internet-context-mcp] embeddings disabled, transformer load failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return null;
    }
  })();

  return pipelinePromise;
}

export async function embedTexts(
  texts: string[],
  options: { model?: string } = {},
): Promise<Float32Array[] | null> {
  if (texts.length === 0) {
    return [];
  }

  const pipe = await loadPipeline(options.model ?? DEFAULT_MODEL);
  if (!pipe) {
    return null;
  }

  try {
    const result = await pipe(texts, { pooling: "mean", normalize: true });
    const dims = result.dims;
    if (dims.length < 2) {
      return null;
    }
    const batchSize = dims[0];
    const hidden = dims[dims.length - 1];
    const raw =
      result.data instanceof Float32Array
        ? result.data
        : new Float32Array(result.data as ArrayLike<number>);

    const vectors: Float32Array[] = [];
    for (let i = 0; i < batchSize; i += 1) {
      vectors.push(raw.slice(i * hidden, (i + 1) * hidden));
    }
    return vectors;
  } catch (error) {
    process.stderr.write(
      `[internet-context-mcp] embeddings inference error: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return null;
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function warmEmbeddings(model = DEFAULT_MODEL): Promise<void> {
  await loadPipeline(model);
}

export function embeddingsEnabledByDefault(): boolean {
  return process.env.INTERNET_CONTEXT_MCP_EMBEDDINGS !== "0";
}
