import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rankChunksForTask, selectRankedChunks } from "../src/lib/chunk-ranking.js";
import { cleanPageContent } from "../src/lib/clean-html.js";
import { scanForPromptInjection } from "../src/lib/prompt-injection-scan.js";
import { mapChunkToSourceBlocks } from "../src/lib/source-provenance.js";
import { extractStructuredData } from "../src/lib/structured-data.js";
import { estimateTokenSavings } from "../src/lib/token-estimate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(join(root, "fixtures/docs-page.html"), "utf8");
const cleaned = cleanPageContent(html, "https://example.test/docs");
const structuredData = extractStructuredData(html, "https://example.test/docs");
const ranked = rankChunksForTask(
  cleaned.text,
  "find installation command, MCP client configuration, and read-only behavior",
  {
    headings: cleaned.headings,
    metadataText: Object.entries(structuredData.metadata)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
    structuredDataText: JSON.stringify(structuredData.json_ld),
  },
);
const selected = selectRankedChunks(ranked, 500, 0.05);
const context = selected.map((chunk) => chunk.text).join("\n\n---\n\n");
const selectedSourceBlocks = selected.flatMap((chunk) =>
  mapChunkToSourceBlocks(chunk.text, cleaned.blocks),
);
const safety = scanForPromptInjection(html, cleaned.text);
const checks = [
  {
    name: "install command",
    pattern: /npm install context-bridge/i,
  },
  {
    name: "client configuration",
    pattern: /MCP client config file/i,
  },
  {
    name: "read-only behavior",
    pattern: /read-only tools/i,
  },
  {
    name: "json-ld headline",
    pattern: /Context Bridge Docs/i,
    target: JSON.stringify(structuredData.json_ld),
  },
  {
    name: "hidden prompt-injection warning",
    pattern: /hidden_instruction_like_text/i,
    target: JSON.stringify(safety.warnings),
  },
  {
    name: "chunk provenance offsets",
    pattern: /true/i,
    target: String(
      selected.every(
        (chunk) =>
          Number.isInteger(chunk.char_start) &&
          Number.isInteger(chunk.char_end) &&
          chunk.char_end > chunk.char_start,
      ),
    ),
  },
  {
    name: "score breakdown",
    pattern: /true/i,
    target: String(
      selected.every(
        (chunk) =>
          typeof chunk.score_breakdown.bm25 === "number" &&
          typeof chunk.score_breakdown.metadata === "number" &&
          typeof chunk.score_breakdown.structured_data === "number",
      ),
    ),
  },
  {
    name: "source block provenance",
    pattern: /true/i,
    target: String(
      selectedSourceBlocks.some(
        (block) =>
          block.dom_path.includes("main") &&
          Number.isInteger(block.line_start) &&
          Number.isInteger(block.line_end),
      ),
    ),
  },
];
const failures = checks
  .filter((check) => !check.pattern.test(check.target ?? context))
  .map((check) => check.name);

console.log(
  JSON.stringify(
    {
      eval: "ranking-docs-fixture",
      passed: failures.length === 0,
      failures,
      selected_chunk_ids: selected.map((chunk) => chunk.id),
      selected_provenance: selected.map((chunk) => ({
        id: chunk.id,
        char_start: chunk.char_start,
        char_end: chunk.char_end,
        section: chunk.section,
        source_blocks: mapChunkToSourceBlocks(chunk.text, cleaned.blocks).map(
          (block) => ({
            block_id: block.block_id,
            tag: block.tag,
            dom_path: block.dom_path,
            line_start: block.line_start,
            line_end: block.line_end,
          }),
        ),
      })),
      top_score_breakdown: ranked[0]?.score_breakdown,
      selected_tokens: selected.reduce((sum, chunk) => sum + chunk.token_estimate, 0),
      structured_data: {
        metadata_keys: Object.keys(structuredData.metadata),
        json_ld_count: structuredData.json_ld.length,
      },
      safety: {
        risk: safety.risk,
        warning_count: safety.warnings.length,
      },
      token_savings_estimate: estimateTokenSavings(html, context),
    },
    null,
    2,
  ),
);

if (failures.length > 0) {
  process.exitCode = 1;
}
