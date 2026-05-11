// Hand-picked URL pairs from sources known to disagree on a specific claim.
// Goal: validate the contradiction detector against real prose, not synthetics.

import { buildContextCapsule } from "../src/lib/context-capsule.js";
import { clearFetchCache } from "../src/lib/fetch-cache.js";
import { detectContradictions } from "../src/lib/cross-source-contradictions.js";
import {
  crossSourceRank,
  type SourceChunkInput,
} from "../src/lib/cross-source-rank.js";

interface CuratedCase {
  label: string;
  claim_axis: string;
  urls: Array<{ url: string; expected_stance: string }>;
}

const cases: CuratedCase[] = [
  {
    label: "daily aspirin for primary prevention",
    claim_axis: "should healthy adults take daily aspirin to prevent heart attacks",
    urls: [
      {
        url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/aspirin-to-prevent-cardiovascular-disease-preventive-medication",
        expected_stance: "against (USPSTF 2022 recommends against primary prevention for most)",
      },
      {
        url: "https://www.heart.org/en/health-topics/heart-attack/treatment-of-a-heart-attack/aspirin-and-heart-disease",
        expected_stance: "limited use (only after a prior event; AHA distinguishes secondary from primary)",
      },
      {
        url: "https://www.mayoclinic.org/diseases-conditions/heart-disease/in-depth/daily-aspirin-therapy/art-20046797",
        expected_stance: "conditional / cautious",
      },
    ],
  },
  {
    label: "vitamin D supplementation",
    claim_axis: "do vitamin D supplements meaningfully reduce disease risk in healthy adults",
    urls: [
      {
        url: "https://www.nejm.org/doi/full/10.1056/NEJMoa1809944",
        expected_stance: "skeptical (VITAL trial: no significant cardiovascular or cancer benefit)",
      },
      {
        url: "https://www.health.harvard.edu/staying-healthy/vitamin-d-and-your-health-breaking-old-rules-raising-new-hopes",
        expected_stance: "mixed-to-positive (older Harvard piece advocating supplementation)",
      },
      {
        url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/vitamin-d-deficiency-screening",
        expected_stance: "insufficient evidence to screen / supplement broadly",
      },
    ],
  },
  {
    label: "saturated fat and heart disease",
    claim_axis: "does saturated fat consumption raise heart disease risk",
    urls: [
      {
        url: "https://www.heart.org/en/healthy-living/healthy-eating/eat-smart/fats/saturated-fats",
        expected_stance: "yes (AHA: limit saturated fat)",
      },
      {
        url: "https://www.bmj.com/content/351/bmj.h3978",
        expected_stance: "no clear link (2015 BMJ systematic review)",
      },
    ],
  },
];

clearFetchCache();

for (const testCase of cases) {
  console.log(`\n=========================================`);
  console.log(`CASE: ${testCase.label}`);
  console.log(`CLAIM AXIS: ${testCase.claim_axis}`);
  for (const u of testCase.urls) {
    console.log(`  [stance: ${u.expected_stance}]`);
    console.log(`    ${u.url}`);
  }
  console.log(`-----------------------------------------`);

  const t0 = performance.now();
  const fetched = await Promise.all(
    testCase.urls.map(async (entry, idx) => {
      try {
        const capsule = await buildContextCapsule({
          url: entry.url,
          task: testCase.claim_axis,
          maxTokens: 1200,
          timeoutMs: 30_000,
        });
        return { ok: true as const, idx, url: entry.url, capsule };
      } catch (err) {
        return {
          ok: false as const,
          idx,
          url: entry.url,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  for (const f of fetched) {
    if (f.ok) {
      console.log(
        `  [${f.idx}] ${f.url}: chunks=${f.capsule.evidence_chunks.length} conf=${f.capsule.retrieval_confidence.level}`,
      );
    } else {
      console.log(`  [${f.idx}] ${f.url}: FAILED ${f.error}`);
    }
  }

  const okSources = fetched.filter((f) => f.ok) as Array<
    Extract<typeof fetched[number], { ok: true }>
  >;
  if (okSources.length < 2) {
    console.log("  (less than 2 sources fetched; skipping pipeline)");
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
    `\nclustering: method=${ranked.clustering_method} unique_sources=${ranked.unique_sources} clusters=${ranked.clusters.length} pooled=${ranked.total_pooled}`,
  );

  const contradictions = await detectContradictions(ranked.ranked_chunks, {
    topK: 10,
  });
  console.log(`\ncontradictions detected: ${contradictions.length}`);
  for (const c of contradictions) {
    console.log(`  ---`);
    console.log(
      `  src=${c.a.source_index} (${c.a.source_url})`,
    );
    console.log(`    A: ${c.a.text_preview}`);
    console.log(
      `  src=${c.b.source_index} (${c.b.source_url})`,
    );
    console.log(`    B: ${c.b.text_preview}`);
    console.log(
      `    confidence=${c.confidence}  topical_similarity=${c.topical_similarity}`,
    );
  }

  console.log(`\nelapsed: ${Math.round(performance.now() - t0)}ms`);
}
