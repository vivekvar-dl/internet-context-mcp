import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cleanPageContent } from "../lib/clean-html.js";
import { fetchPage } from "../lib/fetch-page.js";
import { structuredJsonContent } from "../lib/mcp-response.js";
import { estimateTokenSavings } from "../lib/token-estimate.js";
import { normalizeWhitespace, selectRelevantText } from "../lib/text-selection.js";
import { READ_ONLY_ANNOTATIONS, webExtractOutputShape } from "./schemas.js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface Evidence {
  field: string;
  url: string;
  text: string;
  confidence: number;
}

interface FieldSpec {
  path: string;
  kind: "string" | "number" | "boolean" | "array" | "object" | "unknown";
}

export function registerWebExtractTool(server: McpServer): void {
  server.registerTool(
    "web_extract",
    {
      title: "Web extract (deterministic)",
      description: [
        "Fetch a URL and return a best-effort field extraction against a caller-supplied schema.",
        "Use when: the calling agent cannot reason over evidence chunks itself and needs a flat record.",
        "Prefer web_context when the host LLM can read evidence and produce the structured output.",
      ].join(" "),
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Web extract" },
      inputSchema: {
        url: z.string().url().describe("The URL to fetch and extract from."),
        schema: z
          .record(z.string(), z.unknown())
          .describe(
            "A JSON-like schema object. Leaf values can be string, number, boolean, arrays, or example objects.",
          ),
        query: z
          .string()
          .optional()
          .describe("Optional focus query to reduce the page before extraction."),
        max_context_tokens: z
          .number()
          .int()
          .min(500)
          .max(30_000)
          .default(8_000)
          .describe("Approximate token budget for extraction context."),
        timeout_ms: z
          .number()
          .int()
          .min(1_000)
          .max(60_000)
          .default(15_000)
          .describe("Fetch timeout in milliseconds."),
      },
      outputSchema: webExtractOutputShape,
    },
    async ({ url, schema, query, max_context_tokens, timeout_ms }) => {
      const fetched = await fetchPage(url, {
        timeoutMs: timeout_ms,
        retries: 1,
      });
      const cleaned = cleanPageContent(fetched.body, fetched.final_url);
      const context = selectRelevantText(
        cleaned.text,
        query ?? inferQueryFromSchema(schema),
        max_context_tokens,
      );
      const extraction = extractFromText(schema, context, fetched.final_url);

      return structuredJsonContent({
        requested_url: fetched.requested_url,
        final_url: fetched.final_url,
        title: cleaned.title,
        data: extraction.data,
        evidence: extraction.evidence,
        unfilled_fields: extraction.unfilledFields,
        confidence: extraction.confidence,
        notes: [
          "This is generic deterministic extraction. For higher accuracy, call web_context and let the host agent reason over the returned evidence chunks.",
        ],
        token_savings_estimate: estimateTokenSavings(fetched.body, context),
      });
    },
  );
}

function extractFromText(schema: Record<string, unknown>, text: string, url: string) {
  const data = makeEmptyShape(schema) as Record<string, JsonValue>;
  const fieldSpecs = flattenSchema(schema);
  const evidence: Evidence[] = [];
  const unfilledFields: string[] = [];
  const lines = text
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0 && line.length < 600);

  for (const field of fieldSpecs) {
    if (field.kind === "object" || field.kind === "array") {
      continue;
    }

    const match = findFieldEvidence(field, lines);

    if (!match) {
      unfilledFields.push(field.path);
      continue;
    }

    const value = inferValue(field.kind, match);

    if (value === null) {
      unfilledFields.push(field.path);
      continue;
    }

    setPath(data, field.path, value);
    evidence.push({
      field: field.path,
      url,
      text: match,
      confidence: confidenceForField(field, match),
    });
  }

  const fillableFields = fieldSpecs.filter(
    (field) => field.kind !== "object" && field.kind !== "array",
  );
  const filledCount = fillableFields.length - unfilledFields.length;
  const evidenceScore =
    evidence.length === 0 ? 0 : average(evidence.map((item) => item.confidence));
  const fillScore = fillableFields.length === 0 ? 0 : filledCount / fillableFields.length;
  const confidence = Number(Math.min(0.9, fillScore * evidenceScore).toFixed(2));

  return {
    data,
    evidence,
    unfilledFields,
    confidence,
  };
}

function makeEmptyShape(value: unknown): JsonValue {
  if (Array.isArray(value)) {
    return [];
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, makeEmptyShape(child)]),
    );
  }

  return null;
}

function flattenSchema(
  value: unknown,
  prefix = "",
  fields: FieldSpec[] = [],
): FieldSpec[] {
  if (Array.isArray(value)) {
    fields.push({ path: prefix, kind: "array" });
    const first = value[0];

    if (first && typeof first === "object" && !Array.isArray(first)) {
      for (const [key, child] of Object.entries(first)) {
        flattenSchema(child, `${prefix}[].${key}`, fields);
      }
    }

    return fields;
  }

  if (value && typeof value === "object") {
    if (prefix) {
      fields.push({ path: prefix, kind: "object" });
    }

    for (const [key, child] of Object.entries(value)) {
      flattenSchema(child, prefix ? `${prefix}.${key}` : key, fields);
    }

    return fields;
  }

  fields.push({ path: prefix, kind: inferKind(value) });
  return fields;
}

function inferKind(value: unknown): FieldSpec["kind"] {
  if (value === "string" || typeof value === "string") {
    return "string";
  }

  if (value === "number" || typeof value === "number") {
    return "number";
  }

  if (value === "boolean" || typeof value === "boolean") {
    return "boolean";
  }

  return "unknown";
}

function findFieldEvidence(field: FieldSpec, lines: string[]): string | null {
  const terms = termsForField(field.path);
  const scored = lines
    .map((line) => ({
      line,
      score: scoreLine(line, terms, field.kind),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.line ?? null;
}

function termsForField(path: string): string[] {
  const fieldName = path.split(".").at(-1)?.replace(/\[\]/g, "") ?? path;
  const baseTerms = fieldName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter((term) => term.length > 1)
    .map((term) => term.toLowerCase());
  const synonyms: Record<string, string[]> = {
    command: ["command", "terminal", "shell", "cli", "run"],
    config: ["config", "configuration", "settings", "json"],
    configuration: ["config", "configuration", "settings", "json"],
    description: ["description", "summary", "overview"],
    email: ["email", "e-mail", "contact"],
    install: ["install", "installation", "setup"],
    installation: ["install", "installation", "setup"],
    location: ["location", "address", "city"],
    purpose: ["purpose", "used", "use", "overview"],
    title: ["title", "heading", "name"],
    updated: ["updated", "modified", "changed"],
  };

  return Array.from(
    new Set(baseTerms.flatMap((term) => synonyms[term] ?? [term])),
  );
}

function scoreLine(
  line: string,
  terms: string[],
  kind: FieldSpec["kind"],
): number {
  const lower = line.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (lower.includes(term)) {
      score += term.includes(" ") ? 3 : 1;
    }
  }

  if (kind === "number" && /\d/.test(line)) {
    score += 2;
  }

  if (kind === "boolean" && /\b(yes|no|available|included|enabled|disabled|not|without)\b/i.test(line)) {
    score += 1;
  }

  if (kind === "string" && line.length < 220) {
    score += 1;
  }

  return score;
}

function inferValue(kind: FieldSpec["kind"], line: string): JsonValue {
  if (kind === "boolean") {
    if (/\b(no|not|without|unavailable|disabled)\b/i.test(line)) {
      return false;
    }

    return true;
  }

  if (kind === "number") {
    const match = line.match(/-?\d+(?:[,.]\d+)?/);

    if (!match) {
      return null;
    }

    return Number(match[0].replace(",", ""));
  }

  if (kind === "string" || kind === "unknown") {
    return line;
  }

  return null;
}

function setPath(target: Record<string, JsonValue>, rawPath: string, value: JsonValue): void {
  if (rawPath.includes("[]")) {
    return;
  }

  const parts = rawPath.split(".");
  let cursor: Record<string, JsonValue> = target;

  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const child = cursor[part];

    if (!child || typeof child !== "object" || Array.isArray(child)) {
      cursor[part] = {};
    }

    cursor = cursor[part] as Record<string, JsonValue>;
  }

  cursor[parts.at(-1) ?? rawPath] = value;
}

function confidenceForField(field: FieldSpec, line: string): number {
  const terms = termsForField(field.path);
  const lineScore = scoreLine(line, terms, field.kind);

  return Number(Math.min(0.85, 0.35 + lineScore * 0.08).toFixed(2));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function inferQueryFromSchema(schema: Record<string, unknown>): string {
  return flattenSchema(schema)
    .map((field) => field.path.replace(/\[\]/g, ""))
    .join(" ");
}
