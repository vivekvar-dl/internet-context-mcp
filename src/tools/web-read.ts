import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cleanPageContent } from "../lib/clean-html.js";
import { fetchPage } from "../lib/fetch-page.js";
import { shortFingerprint } from "../lib/fingerprint.js";
import { jsonContent } from "../lib/mcp-response.js";
import { scanForPromptInjection } from "../lib/prompt-injection-scan.js";
import { extractStructuredData } from "../lib/structured-data.js";
import { estimateTokenSavings } from "../lib/token-estimate.js";
import { selectRelevantText } from "../lib/text-selection.js";

export function registerWebReadTool(server: McpServer): void {
  server.tool(
    "web_read",
    "Fetch a URL and return clean, compact page text with token savings metadata. Read-only.",
    {
      url: z.string().url().describe("The URL to fetch and clean."),
      query: z
        .string()
        .optional()
        .describe("Optional focus query. If supplied, only the most relevant chunks are returned."),
      mode: z
        .enum(["compact", "full"])
        .default("compact")
        .describe("compact returns a token-limited body; full returns the cleaned body."),
      max_tokens: z
        .number()
        .int()
        .min(200)
        .max(20_000)
        .default(4_000)
        .describe("Maximum approximate tokens to return in compact mode."),
      timeout_ms: z
        .number()
        .int()
        .min(1_000)
        .max(60_000)
        .default(15_000)
        .describe("Fetch timeout in milliseconds."),
    },
    async ({ url, query, mode, max_tokens, timeout_ms }) => {
      const fetched = await fetchPage(url, {
        timeoutMs: timeout_ms,
        retries: 1,
      });
      const cleaned = cleanPageContent(fetched.body, fetched.final_url);
      const structuredData = extractStructuredData(fetched.body, fetched.final_url);
      const safety = scanForPromptInjection(fetched.body, cleaned.text);
      const cleanText =
        mode === "full"
          ? cleaned.text
          : selectRelevantText(cleaned.text, query, max_tokens);

      return jsonContent({
        requested_url: fetched.requested_url,
        final_url: fetched.final_url,
        retrieved_at: new Date().toISOString(),
        status: fetched.status,
        content_type: fetched.content_type,
        provenance: {
          content_fingerprint: shortFingerprint(fetched.body),
          clean_text_fingerprint: shortFingerprint(cleaned.text),
          truncated: fetched.truncated,
          timed_out: fetched.timed_out,
          bytes_read: fetched.bytes_read,
          max_bytes: fetched.max_bytes,
        },
        title: cleaned.title,
        byline: cleaned.byline,
        excerpt: cleaned.excerpt,
        site_name: cleaned.site_name,
        headings: cleaned.headings,
        structured_data: structuredData,
        safety,
        clean_text: cleanText,
        token_savings_estimate: estimateTokenSavings(fetched.body, cleanText),
      });
    },
  );
}
