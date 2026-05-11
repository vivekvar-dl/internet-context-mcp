import { buildContextCapsule } from "../src/lib/context-capsule.js";
import { clearFetchCache } from "../src/lib/fetch-cache.js";

function summarize(label: string, capsule: Awaited<ReturnType<typeof buildContextCapsule>>, elapsedMs: number) {
  console.log(`\n=== ${label} ===`);
  console.log(`elapsed: ${elapsedMs}ms`);
  console.log(`status: HTTP ${capsule.provenance.status}`);
  console.log(`title: ${capsule.title}`);
  console.log(
    `tokens: raw=${capsule.token_savings_estimate.raw_tokens} returned=${capsule.token_savings_estimate.returned_tokens} saved=${capsule.token_savings_estimate.saved_tokens} ratio=${capsule.token_savings_estimate.savings_ratio}`,
  );
  console.log(
    `chunks: total=${capsule.ranking.total_chunks} selected=${capsule.ranking.selected_chunks} tokens=${capsule.ranking.selected_tokens}`,
  );
  console.log(
    `retrieval_confidence: ${capsule.retrieval_confidence.level} (score=${capsule.retrieval_confidence.score})`,
  );
  console.log(`from_cache: ${capsule.provenance.from_cache}`);
  console.log(
    `priority_capsule.top_sections: ${JSON.stringify(capsule.priority_capsule.top_sections)}`,
  );
  console.log(
    `priority_capsule.tldr: ${truncate(capsule.priority_capsule.tldr, 280)}`,
  );

  console.log(`top 3 chunks (id, score, matched terms, section):`);
  for (const chunk of capsule.evidence_chunks.slice(0, 3)) {
    console.log(
      `  - id=${chunk.id} score=${chunk.score} section=${JSON.stringify(chunk.provenance.section)} matched=${JSON.stringify(chunk.matched_terms.slice(0, 6))}`,
    );
    console.log(`      ${truncate(chunk.text, 200)}`);
  }
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`;
}

clearFetchCache();

// ---- 1: Anthropic prompt-caching docs, static (the SPA that failed before) ----
{
  const t = performance.now();
  const cap = await buildContextCapsule({
    url: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching",
    task: "find what prompt caching does and how cache TTL works",
    maxTokens: 1500,
    timeoutMs: 25_000,
    render: "static",
  });
  summarize(
    "Anthropic / prompt-caching — render: static (current SPA failure mode)",
    cap,
    Math.round(performance.now() - t),
  );
}

clearFetchCache();

// ---- 2: Same URL, render: browser (Playwright) ----
{
  const t = performance.now();
  const cap = await buildContextCapsule({
    url: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching",
    task: "find what prompt caching does and how cache TTL works",
    maxTokens: 1500,
    timeoutMs: 45_000,
    render: "browser",
  });
  summarize(
    "Anthropic / prompt-caching — render: browser (Playwright)",
    cap,
    Math.round(performance.now() - t),
  );
}

clearFetchCache();

// ---- 3: MDN fetch, rerank: false (BM25 only) ----
{
  const t = performance.now();
  const cap = await buildContextCapsule({
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch",
    task: "what does the fetch method return and when does its promise reject",
    maxTokens: 1500,
    timeoutMs: 25_000,
    rerank: false,
  });
  summarize("MDN / fetch — BM25 only (no reranker)", cap, Math.round(performance.now() - t));
}

// ---- 4: Same MDN URL, rerank: true (cross-encoder downloads model on first call) ----
{
  process.stderr.write("\n[demo] enabling local reranker; first call will download Xenova/ms-marco-MiniLM-L-6-v2 (~25MB)...\n");
  const t = performance.now();
  const cap = await buildContextCapsule({
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch",
    task: "what does the fetch method return and when does its promise reject",
    maxTokens: 1500,
    timeoutMs: 60_000,
    rerank: true,
  });
  summarize(
    "MDN / fetch — BM25 + local cross-encoder reranker",
    cap,
    Math.round(performance.now() - t),
  );
}
