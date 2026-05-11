import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextCapsule } from "../src/lib/context-capsule.js";

interface RelevanceCase {
  id: string;
  url: string;
  task: string;
  must_include: string[];
  must_not_include: string[];
  max_tokens: number;
}

interface RelevanceResult {
  id: string;
  url: string;
  ok: boolean;
  error?: string;
  included_pass: boolean;
  excluded_pass: boolean;
  provenance_pass: boolean;
  token_budget_pass: boolean;
  all_pass: boolean;
  missing_terms: string[];
  forbidden_terms_found: string[];
  selected_tokens: number;
  token_savings_ratio: number;
  evidence_chunks: number;
  source_blocks: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const limit = numberArg(args.limit, Number.POSITIVE_INFINITY);
const timeoutMs = numberArg(args.timeout, 15_000);
const maxBytes = numberArg(args.maxBytes, 3_000_000);
const cases = (
  JSON.parse(await readFile(join(root, "evals/relevance.json"), "utf8")) as RelevanceCase[]
).slice(0, limit);

console.log(`Running relevance eval: ${cases.length} cases`);

const results: RelevanceResult[] = [];

for (const [index, testCase] of cases.entries()) {
  const result = await runCase(testCase);
  results.push(result);
  console.log(
    `[${index + 1}/${cases.length}] ${result.all_pass ? "pass" : "fail"} ${testCase.id}`,
  );
}

const summary = summarize(results);
const report = {
  summary,
  results,
};
const reportDir = join(root, "reports");
const reportPath = join(reportDir, "eval-relevance-latest.json");

await mkdir(reportDir, { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify(summary, null, 2));
console.log(`Report written to ${reportPath}`);

if (summary.all_pass_rate < 0.85) {
  process.exitCode = 1;
}

async function runCase(testCase: RelevanceCase): Promise<RelevanceResult> {
  try {
    const capsule = await buildContextCapsule({
      url: testCase.url,
      task: testCase.task,
      maxTokens: testCase.max_tokens,
      timeoutMs,
      maxBytes,
      userAgent:
        "internet-context-mcp-relevance-eval/0.1 (+https://github.com/local/internet-context-mcp)",
    });
    const context = normalize(capsule.context);
    const missingTerms = testCase.must_include.filter(
      (term) => !context.includes(normalize(term)),
    );
    const forbiddenTermsFound = testCase.must_not_include.filter((term) =>
      context.includes(normalize(term)),
    );
    const sourceBlocks = capsule.evidence_chunks.reduce(
      (sum, chunk) => sum + chunk.provenance.source_blocks.length,
      0,
    );
    const includedPass = missingTerms.length === 0;
    const excludedPass = forbiddenTermsFound.length === 0;
    const provenancePass =
      capsule.evidence_chunks.length > 0 && sourceBlocks >= capsule.evidence_chunks.length;
    const tokenBudgetPass = capsule.ranking.selected_tokens <= testCase.max_tokens;
    const allPass = includedPass && excludedPass && provenancePass && tokenBudgetPass;

    return {
      id: testCase.id,
      url: testCase.url,
      ok: true,
      included_pass: includedPass,
      excluded_pass: excludedPass,
      provenance_pass: provenancePass,
      token_budget_pass: tokenBudgetPass,
      all_pass: allPass,
      missing_terms: missingTerms,
      forbidden_terms_found: forbiddenTermsFound,
      selected_tokens: capsule.ranking.selected_tokens,
      token_savings_ratio: capsule.token_savings_estimate.savings_ratio,
      evidence_chunks: capsule.evidence_chunks.length,
      source_blocks: sourceBlocks,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      id: testCase.id,
      url: testCase.url,
      ok: false,
      error: message,
      included_pass: false,
      excluded_pass: false,
      provenance_pass: false,
      token_budget_pass: false,
      all_pass: false,
      missing_terms: testCase.must_include,
      forbidden_terms_found: [],
      selected_tokens: 0,
      token_savings_ratio: 0,
      evidence_chunks: 0,
      source_blocks: 0,
    };
  }
}

function summarize(results: RelevanceResult[]) {
  const total = results.length;
  const ok = results.filter((result) => result.ok);
  const allPass = results.filter((result) => result.all_pass);

  return {
    total,
    fetched: ok.length,
    fetch_rate: ratio(ok.length, total),
    all_pass: allPass.length,
    all_pass_rate: ratio(allPass.length, total),
    included_pass_rate: ratio(
      results.filter((result) => result.included_pass).length,
      total,
    ),
    excluded_pass_rate: ratio(
      results.filter((result) => result.excluded_pass).length,
      total,
    ),
    provenance_pass_rate: ratio(
      results.filter((result) => result.provenance_pass).length,
      total,
    ),
    token_budget_pass_rate: ratio(
      results.filter((result) => result.token_budget_pass).length,
      total,
    ),
    average_token_savings_ratio: average(
      ok.map((result) => result.token_savings_ratio),
    ),
    failures: results
      .filter((result) => !result.all_pass)
      .map((result) => ({
        id: result.id,
        error: result.error,
        missing_terms: result.missing_terms,
        forbidden_terms_found: result.forbidden_terms_found,
        selected_tokens: result.selected_tokens,
        evidence_chunks: result.evidence_chunks,
        source_blocks: result.source_blocks,
      })),
  };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
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

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }

  return Number((numerator / denominator).toFixed(4));
}
