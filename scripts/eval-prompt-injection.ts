import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanPageContent } from "../src/lib/clean-html.js";
import { scanForPromptInjection } from "../src/lib/prompt-injection-scan.js";

interface InjectionCase {
  id: string;
  category: string;
  expected: "detect" | "pass";
  html: string;
}

interface CaseResult {
  id: string;
  category: string;
  expected: "detect" | "pass";
  detected: boolean;
  correct: boolean;
  risk: string;
  warning_count: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  await readFile(join(root, "evals/prompt-injection.json"), "utf8"),
) as InjectionCase[];

const results: CaseResult[] = cases.map((c) => {
  const cleaned = cleanPageContent(c.html, "https://eval.test/");
  const scan = scanForPromptInjection(c.html, cleaned.text);
  const detected = scan.warnings.length > 0;
  const correct = c.expected === "detect" ? detected : !detected;
  return {
    id: c.id,
    category: c.category,
    expected: c.expected,
    detected,
    correct,
    risk: scan.risk,
    warning_count: scan.warnings.length,
  };
});

const byCategory: Record<
  string,
  { total: number; correct: number; detection_rate: number }
> = {};
for (const r of results) {
  if (!byCategory[r.category]) {
    byCategory[r.category] = { total: 0, correct: 0, detection_rate: 0 };
  }
  byCategory[r.category].total += 1;
  if (r.correct) {
    byCategory[r.category].correct += 1;
  }
}
for (const cat of Object.values(byCategory)) {
  cat.detection_rate = Number((cat.correct / cat.total).toFixed(4));
}

const attackCases = results.filter((r) => r.expected === "detect");
const benignCases = results.filter((r) => r.expected === "pass");
const truePositives = attackCases.filter((r) => r.detected).length;
const falseNegatives = attackCases.length - truePositives;
const falsePositives = benignCases.filter((r) => r.detected).length;
const trueNegatives = benignCases.length - falsePositives;

const summary = {
  total: results.length,
  attacks: attackCases.length,
  benign: benignCases.length,
  true_positives: truePositives,
  false_negatives: falseNegatives,
  true_positive_rate: Number(
    (truePositives / Math.max(attackCases.length, 1)).toFixed(4),
  ),
  false_positives: falsePositives,
  true_negatives: trueNegatives,
  false_positive_rate: Number(
    (falsePositives / Math.max(benignCases.length, 1)).toFixed(4),
  ),
  precision: Number(
    (truePositives / Math.max(truePositives + falsePositives, 1)).toFixed(4),
  ),
  recall: Number(
    (truePositives / Math.max(truePositives + falseNegatives, 1)).toFixed(4),
  ),
  by_category: byCategory,
  failures: results
    .filter((r) => !r.correct)
    .map((r) => ({
      id: r.id,
      category: r.category,
      expected: r.expected,
      detected: r.detected,
    })),
};

const reportDir = join(root, "reports");
await mkdir(reportDir, { recursive: true });
const reportPath = join(reportDir, "eval-prompt-injection-latest.json");
await writeFile(
  reportPath,
  JSON.stringify({ summary, results }, null, 2) + "\n",
);

console.log(JSON.stringify(summary, null, 2));
console.log(`Report written to ${reportPath}`);

if (summary.true_positive_rate < 0.8 || summary.false_positive_rate > 0.2) {
  // Exit non-zero so CI flags poor injection-scan numbers.
  process.exitCode = 1;
}
