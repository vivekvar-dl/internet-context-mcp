#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  embeddingsEnabledByDefault,
  warmEmbeddings,
} from "./lib/embeddings.js";
import { nliEnabledByDefault, warmNli } from "./lib/nli-classifier.js";
import { warmReranker } from "./lib/reranker.js";
import { rerankerEnabledByDefault } from "./lib/reranker.js";
import { warmTokenizer } from "./lib/token-estimate.js";
import { registerPrompts } from "./prompts/index.js";
import { registerCachedPageResource } from "./resources/cached-page.js";
import { registerWebContextTool } from "./tools/web-context.js";
import { registerWebExtractTool } from "./tools/web-extract.js";
import { registerWebReadTool } from "./tools/web-read.js";
import { registerWebResearchTool } from "./tools/web-research.js";
import { registerWebSearchTool } from "./tools/web-search.js";
import { registerWebVerifyTool } from "./tools/web-verify.js";

const server = new McpServer({
  name: "internet-context-mcp",
  version: "0.4.0",
});

registerWebReadTool(server);
registerWebContextTool(server);
registerWebExtractTool(server);
registerWebSearchTool(server);
registerWebVerifyTool(server);
registerWebResearchTool(server);
registerCachedPageResource(server);
registerPrompts(server);

void warmTokenizer();
if (rerankerEnabledByDefault()) {
  void warmReranker();
}
if (nliEnabledByDefault()) {
  void warmNli();
}
if (embeddingsEnabledByDefault()) {
  void warmEmbeddings();
}

const transport = new StdioServerTransport();
await server.connect(transport);
