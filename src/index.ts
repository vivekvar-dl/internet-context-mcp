#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { warmTokenizer } from "./lib/token-estimate.js";
import { registerPrompts } from "./prompts/index.js";
import { registerCachedPageResource } from "./resources/cached-page.js";
import { registerWebContextTool } from "./tools/web-context.js";
import { registerWebExtractTool } from "./tools/web-extract.js";
import { registerWebReadTool } from "./tools/web-read.js";
import { registerWebSearchTool } from "./tools/web-search.js";
import { registerWebVerifyTool } from "./tools/web-verify.js";

const server = new McpServer({
  name: "internet-context-mcp",
  version: "0.2.0",
});

registerWebReadTool(server);
registerWebContextTool(server);
registerWebExtractTool(server);
registerWebSearchTool(server);
registerWebVerifyTool(server);
registerCachedPageResource(server);
registerPrompts(server);

void warmTokenizer();

const transport = new StdioServerTransport();
await server.connect(transport);
