#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWebContextTool } from "./tools/web-context.js";
import { registerWebExtractTool } from "./tools/web-extract.js";
import { registerWebReadTool } from "./tools/web-read.js";
import { registerWebSearchTool } from "./tools/web-search.js";

const server = new McpServer({
  name: "internet-context-mcp",
  version: "0.1.0",
});

registerWebReadTool(server);
registerWebContextTool(server);
registerWebExtractTool(server);
registerWebSearchTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);
