export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  return Math.ceil(text.length / 4);
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
