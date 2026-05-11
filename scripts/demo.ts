import { buildContextCapsule } from "../src/lib/context-capsule.js";
import {
  cacheKey,
  clearFetchCache,
  fetchCacheStats,
  getCached,
} from "../src/lib/fetch-cache.js";

interface DemoTarget {
  label: string;
  url: string;
  task: string;
}

const targets: DemoTarget[] = [
  {
    label: "Wikipedia / Model Context Protocol",
    url: "https://en.wikipedia.org/wiki/Model_Context_Protocol",
    task: "explain what Model Context Protocol is and what it standardizes",
  },
  {
    label: "MDN / fetch()",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch",
    task: "find what the fetch method does and what it returns",
  },
  {
    label: "Anthropic docs / prompt caching",
    url: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching",
    task: "find what prompt caching does and how cache TTL works",
  },
  {
    label: "Python docs / json module",
    url: "https://docs.python.org/3/library/json.html",
    task: "find what json.dumps and json.loads do and what their main arguments are",
  },
];

clearFetchCache();

for (const target of targets) {
  console.log(`\n=== ${target.label} ===`);
  console.log(`url: ${target.url}`);
  console.log(`task: ${target.task}`);

  const t0 = performance.now();
  const capsule = await buildContextCapsule({
    url: target.url,
    task: target.task,
    maxTokens: 1_500,
    timeoutMs: 20_000,
  });
  const elapsed = Math.round(performance.now() - t0);

  console.log(`status: HTTP ${capsule.provenance.status}`);
  console.log(`title: ${capsule.title}`);
  console.log(`fetch_ms: ${elapsed}`);
  console.log(
    `tokens: raw=${capsule.token_savings_estimate.raw_tokens} returned=${capsule.token_savings_estimate.returned_tokens} saved=${capsule.token_savings_estimate.saved_tokens} ratio=${capsule.token_savings_estimate.savings_ratio}`,
  );
  console.log(
    `chunks: total=${capsule.ranking.total_chunks} selected=${capsule.ranking.selected_chunks} budget_used_tokens=${capsule.ranking.selected_tokens}`,
  );
  console.log(
    `retrieval_confidence: ${capsule.retrieval_confidence.level} (score=${capsule.retrieval_confidence.score})`,
  );
  console.log(`safety: ${capsule.safety.risk} (${capsule.safety.warnings.length} warnings)`);

  const sd = capsule.structured_data;
  const jsonLdTypes = sd.json_ld
    .map((entry: unknown) => {
      if (entry && typeof entry === "object" && "@type" in entry) {
        const value = (entry as Record<string, unknown>)["@type"];
        return typeof value === "string" ? value : JSON.stringify(value);
      }
      return null;
    })
    .filter(Boolean);
  console.log(
    `structured_data: json_ld=${sd.json_ld.length} types=${JSON.stringify(jsonLdTypes)} metadata_keys=${Object.keys(sd.metadata).length} microdata=${sd.microdata.length}`,
  );
  if (sd.metadata.description) {
    console.log(`og/description: ${truncate(sd.metadata.description, 160)}`);
  }
  if (sd.metadata["og:site_name"]) {
    console.log(`og:site_name: ${sd.metadata["og:site_name"]}`);
  }

  console.log(`priority_capsule.tldr: ${truncate(capsule.priority_capsule.tldr, 280)}`);
  console.log(
    `priority_capsule.top_sections: ${JSON.stringify(capsule.priority_capsule.top_sections)}`,
  );

  const top = capsule.evidence_chunks[0];
  if (top) {
    console.log(
      `top_chunk: id=${top.id} score=${top.score} section=${JSON.stringify(top.provenance.section)} matched=${JSON.stringify(top.matched_terms.slice(0, 8))}`,
    );
    console.log(`top_chunk.preview: ${truncate(top.text, 320)}`);
  }
}

console.log("\n--- cache replay ---");
const target = targets[0];
const before = fetchCacheStats();
const t0 = performance.now();
const replay = await buildContextCapsule({
  url: target.url,
  task: target.task,
  maxTokens: 1_500,
  timeoutMs: 20_000,
});
const after = fetchCacheStats();
console.log(
  `replayed first URL in ${Math.round(performance.now() - t0)}ms, from_cache=${replay.provenance.from_cache}, cache_hits ${before.hits} -> ${after.hits}, size=${after.size}`,
);
console.log(
  "cached entry resolves directly: ",
  getCached(cacheKey(target.url, undefined)) !== null,
);

function truncate(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) {
    return flat;
  }
  return `${flat.slice(0, limit - 3)}...`;
}
