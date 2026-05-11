import { rankChunksForTask } from "../src/lib/chunk-ranking.js";
import {
  combineVerdicts,
  verifyClaimAgainst,
} from "../src/lib/claim-verification.js";
import { cleanPageContent } from "../src/lib/clean-html.js";
import {
  metadataText,
  structuredDataText,
} from "../src/lib/context-capsule.js";
import { fetchPage } from "../src/lib/fetch-page.js";
import { shortFingerprint } from "../src/lib/fingerprint.js";
import { scanForPromptInjection } from "../src/lib/prompt-injection-scan.js";
import { extractStructuredData } from "../src/lib/structured-data.js";

interface Case {
  claim: string;
  sources: string[];
}

const cases: Case[] = [
  {
    claim:
      "Model Context Protocol was developed by Anthropic and introduced in November 2024",
    sources: [
      "https://en.wikipedia.org/wiki/Model_Context_Protocol",
      "https://www.anthropic.com/news/model-context-protocol",
    ],
  },
  {
    claim: "The Python json module is part of the standard library",
    sources: ["https://docs.python.org/3/library/json.html"],
  },
  {
    claim: "Wikipedia requires payment to read articles",
    sources: ["https://en.wikipedia.org/wiki/Main_Page"],
  },
];

for (const testCase of cases) {
  console.log(`\n=== claim ===`);
  console.log(testCase.claim);

  const perSource = await Promise.all(
    testCase.sources.map(async (url) => {
      try {
        const fetched = await fetchPage(url, {
          timeoutMs: 20_000,
          retries: 1,
          maxBytes: 3_000_000,
          onMaxBytes: "truncate",
        });
        const cleaned = cleanPageContent(fetched.body, fetched.final_url);
        const structuredData = extractStructuredData(
          fetched.body,
          fetched.final_url,
        );
        const safety = scanForPromptInjection(fetched.body, cleaned.text);
        const ranked = rankChunksForTask(cleaned.text, testCase.claim, {
          headings: cleaned.headings,
          metadataText: metadataText(structuredData),
          structuredDataText: structuredDataText(structuredData),
        });
        const result = verifyClaimAgainst(testCase.claim, ranked.slice(0, 8));
        return {
          url,
          ok: true,
          title: cleaned.title,
          fingerprint: shortFingerprint(fetched.body),
          from_cache: fetched.from_cache ?? false,
          safety_risk: safety.risk,
          result,
        };
      } catch (error) {
        return {
          url,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          result: {
            verdict: "unclear" as const,
            confidence: 0,
            reasons: ["fetch_failed"],
            supporting_chunks: [],
            refuting_chunks: [],
          },
        };
      }
    }),
  );

  const combined = combineVerdicts(perSource);
  console.log(
    `combined: verdict=${combined.verdict} confidence=${combined.confidence} reasons=${JSON.stringify(combined.reasons)}`,
  );

  for (const entry of perSource) {
    console.log(
      `  - ${entry.url} ok=${entry.ok}` +
        ("title" in entry ? ` title=${truncate(entry.title ?? "", 60)}` : ""),
    );
    console.log(
      `      verdict=${entry.result.verdict} confidence=${entry.result.confidence} reasons=${JSON.stringify(entry.result.reasons)}`,
    );
    if (entry.result.supporting_chunks.length > 0) {
      const top = entry.result.supporting_chunks[0];
      console.log(
        `      top supporting: chunk_id=${top.chunk_id} score=${top.score} matched=${JSON.stringify(top.matched_terms.slice(0, 6))}`,
      );
      console.log(`      preview: ${truncate(top.text_preview, 220)}`);
    }
    if (entry.result.refuting_chunks.length > 0) {
      const top = entry.result.refuting_chunks[0];
      console.log(
        `      top refuting: chunk_id=${top.chunk_id} score=${top.score} matched=${JSON.stringify(top.matched_terms.slice(0, 6))}`,
      );
      console.log(`      preview: ${truncate(top.text_preview, 220)}`);
    }
  }
}

function truncate(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) {
    return flat;
  }
  return `${flat.slice(0, limit - 3)}...`;
}
