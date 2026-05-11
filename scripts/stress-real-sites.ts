import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextCapsule } from "../src/lib/context-capsule.js";

interface StressSite {
  id: string;
  category: string;
  url: string;
  task: string;
}

interface StressResult {
  id: string;
  category: string;
  url: string;
  final_url?: string;
  ok: boolean;
  error?: string;
  duration_ms: number;
  status?: number;
  content_type?: string;
  title?: string | null;
  raw_tokens?: number;
  selected_tokens?: number;
  token_savings_ratio?: number;
  clean_text_tokens?: number;
  total_chunks?: number;
  selected_chunks?: number;
  provenance_coverage?: number;
  structured_data_count?: number;
  metadata_count?: number;
  safety_risk?: string;
  safety_warning_count?: number;
  content_fingerprint?: string;
  capsule_usable?: boolean;
  truncated?: boolean;
  timed_out?: boolean;
  bytes_read?: number;
  max_bytes?: number;
  first_chunk?: {
    id: number;
    score: number;
    section: string | null;
    matched_terms: string[];
    source_blocks: number;
  };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const limit = numberArg(args.limit, 100);
const concurrency = numberArg(args.concurrency, 4);
const timeoutMs = numberArg(args.timeout, 15_000);
const maxTokens = numberArg(args.maxTokens, 1_500);
const maxBytes = numberArg(args.maxBytes, 3_000_000);
const sites = JSON.parse(
  await readFile(join(root, "data/real-sites.json"), "utf8"),
) as StressSite[];
const selectedSites = sites.slice(0, limit);
const startedAt = new Date();

console.log(
  `Running real-site stress test: ${selectedSites.length} URLs, concurrency=${concurrency}, timeout=${timeoutMs}ms`,
);

const results = await runPool(selectedSites, concurrency, (site, index) =>
  stressSite(site, index + 1),
);
const summary = summarize(results, startedAt);
const report = {
  summary,
  results,
};
const reportDir = join(root, "reports");
const reportPath = join(reportDir, "stress-real-sites-latest.json");

await mkdir(reportDir, { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify(summary, null, 2));
console.log(`Report written to ${reportPath}`);

if (summary.success_rate < 0.7) {
  process.exitCode = 1;
}

async function stressSite(site: StressSite, index: number): Promise<StressResult> {
  const started = performance.now();

  try {
    const capsule = await buildContextCapsule({
      url: site.url,
      task: site.task,
      timeoutMs,
      maxBytes,
      maxTokens,
      userAgent:
        "internet-context-mcp-stress/0.1 (+https://github.com/local/internet-context-mcp)",
    });
    const selectedWithProvenance = capsule.evidence_chunks.filter(
      (chunk) => chunk.provenance.source_blocks.length > 0,
    ).length;
    const provenanceCoverage =
      capsule.evidence_chunks.length === 0
        ? 0
        : selectedWithProvenance / capsule.evidence_chunks.length;
    const firstChunk = capsule.evidence_chunks[0];

    console.log(
      `[${index}/${selectedSites.length}] ok ${site.id} chunks=${capsule.evidence_chunks.length} savings=${capsule.token_savings_estimate.savings_ratio}`,
    );

    return {
      id: site.id,
      category: site.category,
      url: site.url,
      final_url: capsule.final_url,
      ok: true,
      duration_ms: Math.round(performance.now() - started),
      status: capsule.provenance.status,
      content_type: capsule.provenance.content_type,
      title: capsule.title,
      raw_tokens: capsule.token_savings_estimate.raw_tokens,
      selected_tokens: capsule.token_savings_estimate.returned_tokens,
      token_savings_ratio: capsule.token_savings_estimate.savings_ratio,
      clean_text_tokens: capsule.ranking.selected_tokens,
      total_chunks: capsule.ranking.total_chunks,
      selected_chunks: capsule.evidence_chunks.length,
      capsule_usable: capsule.evidence_chunks.length > 0,
      provenance_coverage: Number(provenanceCoverage.toFixed(4)),
      structured_data_count:
        capsule.structured_data.json_ld.length + capsule.structured_data.microdata.length,
      metadata_count: Object.keys(capsule.structured_data.metadata).length,
      safety_risk: capsule.safety.risk,
      safety_warning_count: capsule.safety.warnings.length,
      content_fingerprint: capsule.provenance.content_fingerprint,
      truncated: capsule.provenance.truncated,
      timed_out: capsule.provenance.timed_out,
      bytes_read: capsule.provenance.bytes_read,
      max_bytes: capsule.provenance.max_bytes,
      first_chunk: firstChunk
        ? {
            id: firstChunk.id,
            score: firstChunk.score,
            section: firstChunk.provenance.section,
            matched_terms: firstChunk.matched_terms.slice(0, 12),
            source_blocks: firstChunk.provenance.source_blocks.length,
          }
        : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.log(`[${index}/${selectedSites.length}] fail ${site.id}: ${message}`);

    return {
      id: site.id,
      category: site.category,
      url: site.url,
      ok: false,
      error: message,
      duration_ms: Math.round(performance.now() - started),
    };
  }
}

async function runPool<T, R>(
  items: T[],
  workerCount: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(workerCount, items.length) }, () => runWorker()),
  );

  return results;
}

function summarize(results: StressResult[], startedAt: Date) {
  const ok = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const durations = ok.map((result) => result.duration_ms).sort((a, b) => a - b);
  const savings = ok
    .map((result) => result.token_savings_ratio ?? 0)
    .sort((a, b) => a - b);
  const provenance = ok.map((result) => result.provenance_coverage ?? 0);
  const selectedChunks = ok.map((result) => result.selected_chunks ?? 0);
  const truncatedPages = ok.filter((result) => result.truncated);
  const timeoutPartialPages = ok.filter((result) => result.timed_out);
  const usable = ok.filter((result) => result.capsule_usable);
  const zeroChunkPages = ok.filter((result) => (result.selected_chunks ?? 0) === 0);
  const lowSavingsPages = ok.filter(
    (result) => (result.token_savings_ratio ?? 0) < 0.2,
  );
  const categories = Array.from(new Set(results.map((result) => result.category)));

  return {
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    total: results.length,
    success: ok.length,
    failed: failed.length,
    success_rate: ratio(ok.length, results.length),
    usable: usable.length,
    usable_rate: ratio(usable.length, results.length),
    zero_chunk_pages: zeroChunkPages.map((result) => result.id),
    low_savings_pages: lowSavingsPages.map((result) => result.id),
    truncated_pages: truncatedPages.map((result) => result.id),
    timeout_partial_pages: timeoutPartialPages.map((result) => result.id),
    average_token_savings_ratio: average(savings),
    median_token_savings_ratio: percentile(savings, 0.5),
    p90_token_savings_ratio: percentile(savings, 0.9),
    average_selected_chunks: average(selectedChunks),
    provenance_coverage_average: average(provenance),
    structured_data_pages: ok.filter(
      (result) => (result.structured_data_count ?? 0) > 0,
    ).length,
    metadata_pages: ok.filter((result) => (result.metadata_count ?? 0) > 0).length,
    safety_warning_pages: ok.filter(
      (result) => (result.safety_warning_count ?? 0) > 0,
    ).length,
    duration_ms: {
      p50: percentile(durations, 0.5),
      p90: percentile(durations, 0.9),
      max: durations.at(-1) ?? 0,
    },
    by_category: Object.fromEntries(
      categories.map((category) => {
        const categoryResults = results.filter((result) => result.category === category);
        const categoryOk = categoryResults.filter((result) => result.ok);

        return [
          category,
          {
            total: categoryResults.length,
            success: categoryOk.length,
            success_rate: ratio(categoryOk.length, categoryResults.length),
            usable: categoryOk.filter((result) => result.capsule_usable).length,
            usable_rate: ratio(
              categoryOk.filter((result) => result.capsule_usable).length,
              categoryResults.length,
            ),
            average_token_savings_ratio: average(
              categoryOk.map((result) => result.token_savings_ratio ?? 0),
            ),
          },
        ];
      }),
    ),
    failures: failed.slice(0, 30).map((result) => ({
      id: result.id,
      category: result.category,
      url: result.url,
      error: result.error,
    })),
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.+)$/);

    if (match) {
      parsed[match[1]] = match[2];
    }
  }

  return parsed;
}

function numberArg(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return Number(
    (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4),
  );
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * percentileValue) - 1),
  );

  return Number(values[index].toFixed(4));
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }

  return Number((numerator / denominator).toFixed(4));
}
