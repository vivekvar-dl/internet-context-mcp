import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildContextCapsule } from "../lib/context-capsule.js";
import { jsonContent } from "../lib/mcp-response.js";

export function registerWebContextTool(server: McpServer): void {
  server.tool(
    "web_context",
    "Fetch a URL and return the most relevant evidence chunks for an agent task using a local hybrid ranker. No LLM API key required.",
    {
      url: z.string().url().describe("The URL to fetch and compress."),
      task: z
        .string()
        .min(1)
        .describe("The agent task, such as 'find install steps and configuration details'."),
      max_tokens: z
        .number()
        .int()
        .min(200)
        .max(20_000)
        .default(1_800)
        .describe("Maximum approximate tokens to return across selected evidence chunks."),
      min_score: z
        .number()
        .min(0)
        .max(1)
        .default(0.05)
        .describe("Minimum normalized score for chunks after at least one chunk is selected."),
      timeout_ms: z
        .number()
        .int()
        .min(1_000)
        .max(60_000)
        .default(15_000)
        .describe("Fetch timeout in milliseconds."),
    },
    async ({ url, task, max_tokens, min_score, timeout_ms }) =>
      jsonContent(
        await buildContextCapsule({
          url,
          task,
          maxTokens: max_tokens,
          minScore: min_score,
          timeoutMs: timeout_ms,
        }),
      ),
  );
}
