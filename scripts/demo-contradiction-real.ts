import { clearFetchCache } from "../src/lib/fetch-cache.js";
import { detectContradictions } from "../src/lib/cross-source-contradictions.js";
import {
  crossSourceRank,
  type SourceChunkInput,
} from "../src/lib/cross-source-rank.js";
import { buildContextCapsule } from "../src/lib/context-capsule.js";
import * as cheerio from "cheerio";
import { fetchPage } from "../src/lib/fetch-page.js";

interface Query {
  label: string;
  query: string;
  expect: "real_disputes" | "well_established" | "mixed";
  notes?: string;
}

const queries: Query[] = [
  {
    label: "eggs / cholesterol",
    query: "Are eggs bad for cholesterol and heart disease?",
    expect: "mixed",
    notes: "Classic flip-flop topic: 1980s-2010s mainstream said bad, recent studies say fine for most people.",
  },
  {
    label: "intermittent fasting weight loss",
    query: "Does intermittent fasting lead to more weight loss than regular calorie restriction?",
    expect: "real_disputes",
    notes: "Active research dispute; meta-analyses are split.",
  },
  {
    label: "coffee and heart",
    query: "Does coffee consumption increase or decrease cardiovascular risk?",
    expect: "real_disputes",
    notes: "Real-world version of my synthetic test.",
  },
  {
    label: "control: speed of light",
    query: "What is the speed of light in a vacuum?",
    expect: "well_established",
    notes: "No real dispute. Should produce zero or near-zero contradictions.",
  },
  {
    label: "control: capital of france",
    query: "What is the capital of France?",
    expect: "well_established",
    notes: "No dispute. Sanity check on false-positive rate.",
  },
];

async function ddgSearch(query: string, limit: number): Promise<Array<{ title: string; url: string }>> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const fetched = await fetchPage(url, { timeoutMs: 20_000 });
  const $ = cheerio.load(fetched.body);
  const results: Array<{ title: string; url: string }> = [];
  $(".result").each((_, el) => {
    if (results.length >= limit) return false;
    const title = $(el).find(".result__a").first().text().trim();
    const raw = $(el).find(".result__a").first().attr("href");
    if (!raw || !title) return;
    try {
      const parsed = new URL(raw, "https://duckduckgo.com");
      const redirected = parsed.searchParams.get("uddg");
      const realUrl = redirected ?? parsed.toString();
      results.push({ title, url: realUrl });
    } catch {}
  });
  return results;
}

clearFetchCache();

for (const q of queries) {
  console.log(`\n========================================`);
  console.log(`LABEL: ${q.label}`);
  console.log(`QUERY: ${q.query}`);
  console.log(`EXPECT: ${q.expect}`);
  if (q.notes) console.log(`NOTES: ${q.notes}`);
  console.log(`----------------------------------------`);

  const t0 = performance.now();
  const hits = await ddgSearch(q.query, 4);
  console.log(`top sources from DDG:`);
  for (const h of hits) console.log(`  - ${h.url}`);

  const sources = await Promise.all(
    hits.map(async (hit, idx) => {
      try {
        const capsule = await buildContextCapsule({
          url: hit.url,
          task: q.query,
          maxTokens: 800,
          timeoutMs: 25_000,
        });
        return { ok: true as const, idx, hit, capsule };
      } catch (e) {
        return {
          ok: false as const,
          idx,
          hit,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );

  const okSources = sources.filter((s) => s.ok) as Array<
    Extract<typeof sources[number], { ok: true }>
  >;
  console.log(`\nfetched: ${okSources.length}/${sources.length} sources`);
  for (const s of sources) {
    if (s.ok) {
      console.log(
        `  [${s.idx}] ${s.hit.url}: chunks=${s.capsule.evidence_chunks.length} conf=${s.capsule.retrieval_confidence.level}`,
      );
    } else {
      console.log(`  [${s.idx}] ${s.hit.url}: FAILED ${s.error}`);
    }
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

  const ranked = await crossSourceRank(pooled, { maxOutput: 8 });
  console.log(
    `\nclustering: method=${ranked.clustering_method} unique_sources=${ranked.unique_sources} clusters=${ranked.clusters.length} pooled=${ranked.total_pooled}`,
  );
  for (const e of ranked.ranked_chunks) {
    console.log(
      `  cluster=${e.cluster_id} agreement=${e.agreement_count} score=${e.normalized_score} combined=${e.combined_score} src=${e.source_index}`,
    );
  }

  const contradictions = await detectContradictions(ranked.ranked_chunks, { topK: 6 });
  console.log(`\ncontradictions detected: ${contradictions.length}`);
  for (const c of contradictions) {
    console.log(`  ---`);
    console.log(`  src=${c.a.source_index} (${c.a.source_url})`);
    console.log(`    A: ${c.a.text_preview.slice(0, 200)}...`);
    console.log(`  src=${c.b.source_index} (${c.b.source_url})`);
    console.log(`    B: ${c.b.text_preview.slice(0, 200)}...`);
    console.log(`    confidence: ${c.confidence}  topical_similarity: ${c.topical_similarity}`);
  }

  console.log(`\nelapsed: ${Math.round(performance.now() - t0)}ms`);
}
