// Test the detector with wider search depth and queries where lexical
// disagreement is more likely to be explicit in the prose.

import * as cheerio from "cheerio";
import { buildContextCapsule } from "../src/lib/context-capsule.js";
import { clearFetchCache } from "../src/lib/fetch-cache.js";
import { detectContradictions } from "../src/lib/cross-source-contradictions.js";
import {
  crossSourceRank,
  type SourceChunkInput,
} from "../src/lib/cross-source-rank.js";
import { fetchPage } from "../src/lib/fetch-page.js";

interface Topic {
  label: string;
  query: string;
  depth: number;
  notes: string;
}

const topics: Topic[] = [
  {
    label: "stretching before exercise",
    query: "Is static stretching before exercise good or bad for performance?",
    depth: 8,
    notes: "Sports-med says it can reduce power; traditional advice says always stretch.",
  },
  {
    label: "breakfast importance",
    query: "Is eating breakfast the most important meal of the day or is skipping breakfast fine?",
    depth: 8,
    notes: "Conventional vs. intermittent-fasting camps; some explicit opposition expected.",
  },
  {
    label: "running and knees",
    query: "Does running long-term damage your knees or protect them?",
    depth: 8,
    notes: "Older 'wear-and-tear' view vs newer evidence of cartilage protection.",
  },
];

async function ddgSearch(query: string, limit: number): Promise<Array<{ url: string }>> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const fetched = await fetchPage(url, { timeoutMs: 20_000 });
  const $ = cheerio.load(fetched.body);
  const results: Array<{ url: string }> = [];
  $(".result").each((_, el) => {
    if (results.length >= limit) return false;
    const raw = $(el).find(".result__a").first().attr("href");
    if (!raw) return;
    try {
      const parsed = new URL(raw, "https://duckduckgo.com");
      const real = parsed.searchParams.get("uddg") ?? parsed.toString();
      results.push({ url: real });
    } catch {}
  });
  return results;
}

clearFetchCache();

for (const topic of topics) {
  console.log(`\n=========================================`);
  console.log(`TOPIC: ${topic.label}`);
  console.log(`QUERY: ${topic.query}`);
  console.log(`NOTES: ${topic.notes}`);
  console.log(`-----------------------------------------`);

  const t0 = performance.now();
  const hits = await ddgSearch(topic.query, topic.depth);
  console.log(`search returned ${hits.length} urls`);

  const fetched = await Promise.all(
    hits.map(async (hit, idx) => {
      try {
        const capsule = await buildContextCapsule({
          url: hit.url,
          task: topic.query,
          maxTokens: 800,
          timeoutMs: 25_000,
        });
        return { ok: true as const, idx, url: hit.url, capsule };
      } catch (err) {
        return {
          ok: false as const,
          idx,
          url: hit.url,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const okSources = fetched.filter((f) => f.ok) as Array<
    Extract<typeof fetched[number], { ok: true }>
  >;
  console.log(`fetched: ${okSources.length}/${fetched.length}`);
  for (const f of fetched) {
    if (f.ok) console.log(`  [${f.idx}] OK   ${f.url}  chunks=${f.capsule.evidence_chunks.length}`);
    else console.log(`  [${f.idx}] FAIL ${f.url}  ${f.error.slice(0, 80)}`);
  }

  if (okSources.length < 2) {
    console.log("(less than 2 sources fetched; skip)");
    continue;
  }

  const pooled: SourceChunkInput[] = [];
  for (const s of okSources) {
    for (const c of s.capsule.evidence_chunks) {
      pooled.push({
        source_index: s.idx,
        source_url: s.capsule.final_url,
        source_title: s.capsule.title,
        source_fingerprint: s.capsule.provenance.content_fingerprint,
        chunk_id: c.id,
        text: c.text,
        normalized_score: c.score,
        matched_terms: c.matched_terms,
        section: c.provenance.section,
        section_path: c.provenance.section_path,
        token_estimate: c.token_estimate,
      });
    }
  }

  const ranked = await crossSourceRank(pooled, { maxOutput: 12 });
  console.log(
    `clustering: ${ranked.clustering_method}  unique_sources=${ranked.unique_sources}  clusters=${ranked.clusters.length}  pooled=${ranked.total_pooled}`,
  );

  const contradictions = await detectContradictions(ranked.ranked_chunks, {
    topK: 10,
  });
  console.log(`contradictions detected: ${contradictions.length}`);
  for (const c of contradictions) {
    console.log(`  ---`);
    console.log(`  src=${c.a.source_index} (${c.a.source_url})`);
    console.log(`    A: ${c.a.text_preview.slice(0, 220)}`);
    console.log(`  src=${c.b.source_index} (${c.b.source_url})`);
    console.log(`    B: ${c.b.text_preview.slice(0, 220)}`);
    console.log(`    confidence=${c.confidence}  topical_similarity=${c.topical_similarity}`);
  }

  console.log(`elapsed: ${Math.round(performance.now() - t0)}ms`);
}
