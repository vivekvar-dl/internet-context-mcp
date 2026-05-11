import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { cleanPageContent } from "../lib/clean-html.js";
import {
  getByFingerprint,
  listCachedFingerprints,
} from "../lib/fetch-cache.js";
import { extractStructuredData } from "../lib/structured-data.js";

export function registerCachedPageResource(server: McpServer): void {
  server.registerResource(
    "cached_page",
    new ResourceTemplate("internet-context://page/{fingerprint}", {
      list: async () => ({
        resources: listCachedFingerprints().map((entry) => ({
          uri: `internet-context://page/${entry.fingerprint}`,
          name: `cached:${entry.fingerprint}`,
          description: `Cached fetch of ${entry.url}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Cached fetched page",
      description:
        "Read a previously fetched page from the in-memory cache by its content fingerprint. Returns cleaned text + metadata.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const fingerprintValue = variables.fingerprint;
      const fingerprint = Array.isArray(fingerprintValue)
        ? fingerprintValue[0]
        : fingerprintValue;
      const page = fingerprint ? getByFingerprint(fingerprint) : null;

      if (!page) {
        throw new Error(`No cached page for fingerprint ${fingerprint}`);
      }

      const cleaned = cleanPageContent(page.body, page.final_url);
      const structuredData = extractStructuredData(page.body, page.final_url);
      const payload = {
        fingerprint,
        requested_url: page.requested_url,
        final_url: page.final_url,
        status: page.status,
        content_type: page.content_type,
        title: cleaned.title,
        excerpt: cleaned.excerpt,
        clean_text: cleaned.text,
        headings: cleaned.headings,
        structured_data: structuredData,
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );
}
