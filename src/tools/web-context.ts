import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildContextCapsule } from "../lib/context-capsule.js";
import { structuredJsonContent } from "../lib/mcp-response.js";
import { READ_ONLY_ANNOTATIONS, webContextOutputShape } from "./schemas.js";

export function registerWebContextTool(server: McpServer): void {
  server.registerTool(
    "web_context",
    {
      title: "Web context capsule",
      description: [
        "Fetch one URL and return the most task-relevant evidence chunks plus a short TL;DR.",
        "Use when: you already have a specific URL and want compact, ranked context for a specific task.",
        "Prefer over web_read when the calling agent will reason from the returned chunks.",
        "Local hybrid BM25 ranker, no LLM API key required.",
      ].join(" "),
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Web context capsule" },
      inputSchema: {
        url: z.string().url().describe("The URL to fetch and compress."),
        task: z
          .string()
          .min(1)
          .describe(
            "The agent task, written as one short sentence (e.g. 'find install steps and configuration details').",
          ),
        max_tokens: z
          .number()
          .int()
          .min(200)
          .max(20_000)
          .default(1_800)
          .describe(
            "Maximum approximate tokens to return across selected evidence chunks.",
          ),
        min_score: z
          .number()
          .min(0)
          .max(1)
          .default(0.05)
          .describe(
            "Minimum normalized score for chunks after at least one chunk is selected.",
          ),
        timeout_ms: z
          .number()
          .int()
          .min(1_000)
          .max(60_000)
          .default(15_000)
          .describe("Fetch timeout in milliseconds."),
        render: z
          .enum(["static", "browser"])
          .default("static")
          .describe(
            "static fetches HTML directly. browser renders with Playwright if installed (optional dep) and is required for JS-rendered SPAs.",
          ),
        rerank: z
          .boolean()
          .optional()
          .describe(
            "Apply the local cross-encoder reranker (Xenova/ms-marco-MiniLM-L-6-v2). On by default. Pass false for pure BM25-only ranking. Disable globally with INTERNET_CONTEXT_MCP_RERANK=0.",
          ),
      },
      outputSchema: webContextOutputShape,
    },
    async ({ url, task, max_tokens, min_score, timeout_ms, render, rerank }) =>
      structuredJsonContent(
        await buildContextCapsule({
          url,
          task,
          maxTokens: max_tokens,
          minScore: min_score,
          timeoutMs: timeout_ms,
          render,
          rerank,
        }),
      ),
  );
}
