import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as cheerio from "cheerio";
import { z } from "zod";
import { fetchPage } from "../lib/fetch-page.js";
import { jsonContent } from "../lib/mcp-response.js";
import { classifySource } from "../lib/source-quality.js";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source_quality: string;
}

export function registerWebSearchTool(server: McpServer): void {
  server.tool(
    "web_search",
    "Search the web and return compact, source-classified results. Uses BRAVE_SEARCH_API_KEY when available, otherwise DuckDuckGo HTML fallback.",
    {
      query: z.string().min(1).describe("Search query."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Maximum number of search results to return."),
      timeout_ms: z
        .number()
        .int()
        .min(1_000)
        .max(60_000)
        .default(15_000)
        .describe("Search timeout in milliseconds."),
    },
    async ({ query, limit, timeout_ms }) => {
      const provider = process.env.BRAVE_SEARCH_API_KEY
        ? "brave"
        : "duckduckgo_html";
      const results =
        provider === "brave"
          ? await braveSearch(query, limit, timeout_ms)
          : await duckDuckGoSearch(query, limit, timeout_ms);

      return jsonContent({
        query,
        provider,
        results,
      });
    },
  );
}

async function braveSearch(
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;

  if (!key) {
    return [];
  }

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "x-subscription-token": key,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Brave search failed: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
        }>;
      };
    };

    return (payload.web?.results ?? [])
      .filter((result) => result.title && result.url)
      .slice(0, limit)
      .map((result) => ({
        title: result.title ?? "",
        url: result.url ?? "",
        snippet: result.description ?? "",
        source_quality: classifySource(result.url ?? "", result.title ?? ""),
      }));
  } finally {
    clearTimeout(timeout);
  }
}

async function duckDuckGoSearch(
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const fetched = await fetchPage(searchUrl, {
    timeoutMs,
    userAgent:
      "Mozilla/5.0 (compatible; internet-context-mcp/0.1; +https://github.com/local/internet-context-mcp)",
  });
  const $ = cheerio.load(fetched.body);
  const results: SearchResult[] = [];

  $(".result").each((_, element) => {
    if (results.length >= limit) {
      return false;
    }

    const title = $(element).find(".result__a").first().text().trim();
    const rawUrl = $(element).find(".result__a").first().attr("href");
    const snippet = $(element).find(".result__snippet").first().text().trim();
    const url = normalizeDuckDuckGoUrl(rawUrl);

    if (!title || !url) {
      return;
    }

    results.push({
      title,
      url,
      snippet,
      source_quality: classifySource(url, title),
    });
  });

  return results;
}

function normalizeDuckDuckGoUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");

    if (redirected) {
      return redirected;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}
