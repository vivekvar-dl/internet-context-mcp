// Local NLI classifier built on Transformers.js zero-shot-classification.
// Returns a per-pair entailment probability and a 3-way label.
// First call downloads ~80MB of Xenova/nli-deberta-v3-xsmall from HF; cached.

const DEFAULT_MODEL = "Xenova/nli-deberta-v3-xsmall";

export type NliLabel = "entailment" | "neutral" | "contradiction";

export interface NliResult {
  label: NliLabel;
  score: number; // entailment probability in [0, 1]
  scores: Record<NliLabel, number>;
}

type ZscPipelineSingle = (
  text: string,
  candidateLabels: string[],
  options?: Record<string, unknown>,
) => Promise<{
  sequence: string;
  labels: string[];
  scores: number[];
}>;

let pipelinePromise: Promise<ZscPipelineSingle | null> | null = null;

async function loadPipeline(model: string): Promise<ZscPipelineSingle | null> {
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
        "zero-shot-classification",
        model,
      )) as ZscPipelineSingle;
      return pipe;
    } catch (error) {
      process.stderr.write(
        `[internet-context-mcp] NLI disabled, transformer load failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return null;
    }
  })();

  return pipelinePromise;
}

// Thresholds tuned against the smoke probe (cat/mat, wikipedia, python json).
// Strong entailment > 0.55. Strong rejection < 0.05 (softmax pushes false
// claims very low). Anything in between is treated as neutral so we don't
// invent a contradiction we can't justify.
const ENTAILMENT_THRESHOLD = 0.55;
const CONTRADICTION_THRESHOLD = 0.05;

export async function classifyNli(
  pairs: Array<{ premise: string; hypothesis: string }>,
  options: { model?: string } = {},
): Promise<NliResult[] | null> {
  if (pairs.length === 0) {
    return [];
  }

  const pipe = await loadPipeline(options.model ?? DEFAULT_MODEL);
  if (!pipe) {
    return null;
  }

  // ZSC pipeline takes one premise at a time; loop sequentially to keep
  // memory predictable. These are small inputs and the model is tiny.
  const results: NliResult[] = [];
  for (const pair of pairs) {
    try {
      const raw = await pipe(pair.premise, [pair.hypothesis]);
      const entailment = raw.scores[0] ?? 0;
      const label: NliLabel =
        entailment >= ENTAILMENT_THRESHOLD
          ? "entailment"
          : entailment <= CONTRADICTION_THRESHOLD
            ? "contradiction"
            : "neutral";
      results.push({
        label,
        score: Number(entailment.toFixed(4)),
        scores: {
          entailment: Number(entailment.toFixed(4)),
          neutral: Number((1 - entailment).toFixed(4)),
          contradiction: Number((1 - entailment).toFixed(4)),
        },
      });
    } catch (error) {
      process.stderr.write(
        `[internet-context-mcp] NLI inference error: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return null;
    }
  }

  return results;
}

export async function warmNli(model = DEFAULT_MODEL): Promise<void> {
  await loadPipeline(model);
}

export function nliEnabledByDefault(): boolean {
  return process.env.INTERNET_CONTEXT_MCP_NLI !== "0";
}
