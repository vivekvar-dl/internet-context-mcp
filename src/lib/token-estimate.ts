import type { Tiktoken } from "js-tiktoken/lite";

let encoder: Tiktoken | null = null;
let encoderInitPromise: Promise<void> | null = null;

async function ensureEncoder(): Promise<Tiktoken | null> {
  if (encoder) {
    return encoder;
  }

  if (!encoderInitPromise) {
    encoderInitPromise = (async () => {
      try {
        const { Tiktoken } = await import("js-tiktoken/lite");
        const { default: cl100kBase } = await import(
          "js-tiktoken/ranks/cl100k_base"
        );
        encoder = new Tiktoken(cl100kBase);
      } catch (error) {
        process.stderr.write(
          `[internet-context-mcp] tokenizer load failed, falling back to chars/4: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        encoder = null;
      }
    })();
  }

  await encoderInitPromise;
  return encoder;
}

// Synchronous fast-path: most callsites need an immediate number.
// We warm the encoder on first call asynchronously, and fall back to chars/4
// until it's ready. Once loaded, subsequent calls are exact.
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  if (encoder) {
    return encoder.encode(text).length;
  }

  void ensureEncoder();
  return Math.ceil(text.length / 4);
}

export async function estimateTokensExact(text: string): Promise<number> {
  if (!text) {
    return 0;
  }

  const enc = await ensureEncoder();
  if (!enc) {
    return Math.ceil(text.length / 4);
  }
  return enc.encode(text).length;
}

export function trimToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens * 4);

  if (text.length <= maxChars) {
    return text;
  }

  const trimmed = text.slice(0, maxChars);
  const lastParagraphBreak = trimmed.lastIndexOf("\n\n");

  if (lastParagraphBreak > maxChars * 0.6) {
    return `${trimmed.slice(0, lastParagraphBreak).trim()}\n\n[truncated]`;
  }

  const lastSentence = Math.max(
    trimmed.lastIndexOf(". "),
    trimmed.lastIndexOf("? "),
    trimmed.lastIndexOf("! "),
  );

  if (lastSentence > maxChars * 0.6) {
    return `${trimmed.slice(0, lastSentence + 1).trim()}\n\n[truncated]`;
  }

  return `${trimmed.trim()}\n\n[truncated]`;
}

export function estimateTokenSavings(rawText: string, returnedText: string) {
  const rawTokens = estimateTokens(rawText);
  const returnedTokens = estimateTokens(returnedText);
  const savedTokens = Math.max(0, rawTokens - returnedTokens);
  const savingsRatio =
    rawTokens === 0 ? 0 : Number((savedTokens / rawTokens).toFixed(4));

  return {
    raw_tokens: rawTokens,
    returned_tokens: returnedTokens,
    saved_tokens: savedTokens,
    savings_ratio: savingsRatio,
  };
}

export async function warmTokenizer(): Promise<void> {
  await ensureEncoder();
}
