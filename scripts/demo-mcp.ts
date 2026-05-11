import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

interface Client {
  send(id: number, method: string, params?: unknown): void;
  call<T>(id: number, method: string, params?: unknown): Promise<T>;
  close(): void;
}

async function startMcpClient(): Promise<Client> {
  const proc = spawn("node", ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.on("data", (chunk) => {
    process.stderr.write(`[server stderr] ${chunk}`);
  });

  let buffer = "";
  const pending = new Map<number, (msg: JsonRpcMessage) => void>();

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) {
        break;
      }
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) {
        continue;
      }
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON-RPC stdout (should not happen)
      }
    }
  });

  return {
    send(id, method, params) {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    },
    async call<T>(id, method, params) {
      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout for ${method}`));
        }, 60_000);
        pending.set(id, (msg) => {
          clearTimeout(timeout);
          if (msg.error) {
            reject(new Error(JSON.stringify(msg.error)));
          } else {
            resolve(msg.result as T);
          }
        });
        proc.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    },
    close() {
      proc.kill();
    },
  };
}

const client = await startMcpClient();

console.log("--- initialize ---");
const init = await client.call<{
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
}>(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "demo-mcp", version: "0.0.1" },
});
console.log(
  `server: ${init.serverInfo.name}@${init.serverInfo.version}, protocol=${init.protocolVersion}`,
);
console.log(`capabilities: ${Object.keys(init.capabilities).join(", ")}`);

console.log("\n--- tools/list ---");
const toolList = await client.call<{
  tools: Array<{
    name: string;
    annotations?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    description?: string;
  }>;
}>(2, "tools/list");
for (const tool of toolList.tools) {
  const ann = tool.annotations ?? {};
  console.log(
    `  - ${tool.name}: readOnly=${ann.readOnlyHint} openWorld=${ann.openWorldHint} hasOutputSchema=${!!tool.outputSchema}`,
  );
}

console.log("\n--- tools/call web_context (Wikipedia / MCP) ---");
const t0 = performance.now();
const ctxResult = await client.call<{
  structuredContent?: {
    title: string | null;
    priority_capsule: { tldr: string; top_sections: string[] };
    retrieval_confidence: { level: string; score: number };
    ranking: { total_chunks: number; selected_chunks: number; selected_tokens: number };
    token_savings_estimate: {
      raw_tokens: number;
      returned_tokens: number;
      saved_tokens: number;
      savings_ratio: number;
    };
    provenance: { content_fingerprint: string; from_cache: boolean };
    evidence_chunks: Array<{ id: number; score: number; matched_terms: string[] }>;
  };
  content: Array<{ type: string; text: string }>;
}>(3, "tools/call", {
  name: "web_context",
  arguments: {
    url: "https://en.wikipedia.org/wiki/Model_Context_Protocol",
    task: "explain what Model Context Protocol is",
    max_tokens: 1200,
  },
});
const elapsed = Math.round(performance.now() - t0);
const sc = ctxResult.structuredContent!;
console.log(`elapsed: ${elapsed}ms`);
console.log(`structuredContent present: ${!!ctxResult.structuredContent}`);
console.log(`content[0] present (back-compat): ${!!ctxResult.content?.[0]?.text}`);
console.log(`title: ${sc.title}`);
console.log(
  `tokens: raw=${sc.token_savings_estimate.raw_tokens} returned=${sc.token_savings_estimate.returned_tokens} saved=${sc.token_savings_estimate.saved_tokens} ratio=${sc.token_savings_estimate.savings_ratio}`,
);
console.log(
  `chunks: total=${sc.ranking.total_chunks} selected=${sc.ranking.selected_chunks} tokens=${sc.ranking.selected_tokens}`,
);
console.log(
  `retrieval_confidence: ${sc.retrieval_confidence.level} (score=${sc.retrieval_confidence.score})`,
);
console.log(`fingerprint: ${sc.provenance.content_fingerprint}`);
console.log(`priority_capsule.top_sections: ${JSON.stringify(sc.priority_capsule.top_sections)}`);
const wikiFingerprint = sc.provenance.content_fingerprint;

console.log("\n--- resources/templates/list ---");
const tpl = await client.call<{
  resourceTemplates: Array<{ uriTemplate: string; name: string }>;
}>(4, "resources/templates/list");
for (const t of tpl.resourceTemplates) {
  console.log(`  - ${t.name}: ${t.uriTemplate}`);
}

console.log("\n--- resources/list (should include the just-fetched page) ---");
const resList = await client.call<{
  resources: Array<{ uri: string; description?: string }>;
}>(5, "resources/list");
console.log(`count: ${resList.resources.length}`);
for (const r of resList.resources.slice(0, 5)) {
  console.log(`  - ${r.uri} — ${r.description ?? ""}`);
}

console.log("\n--- resources/read internet-context://page/<fingerprint> ---");
const resRead = await client.call<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}>(6, "resources/read", {
  uri: `internet-context://page/${wikiFingerprint}`,
});
const payload = JSON.parse(resRead.contents[0].text) as {
  title: string | null;
  final_url: string;
  status: number;
  clean_text: string;
  headings: string[];
};
console.log(`title: ${payload.title}`);
console.log(`final_url: ${payload.final_url}, status: ${payload.status}`);
console.log(`headings (first 5): ${JSON.stringify(payload.headings.slice(0, 5))}`);
console.log(`clean_text length: ${payload.clean_text.length} chars`);

console.log("\n--- prompts/list ---");
const promptList = await client.call<{
  prompts: Array<{ name: string; description?: string }>;
}>(7, "prompts/list");
for (const p of promptList.prompts) {
  console.log(`  - ${p.name}: ${p.description}`);
}

console.log("\n--- prompts/get verify_with_sources ---");
const pg = await client.call<{
  messages: Array<{
    role: string;
    content: { type: string; text?: string };
  }>;
}>(8, "prompts/get", {
  name: "verify_with_sources",
  arguments: {
    claim: "Model Context Protocol was introduced by Anthropic in November 2024",
    sources:
      "https://en.wikipedia.org/wiki/Model_Context_Protocol, https://www.anthropic.com/news/model-context-protocol",
  },
});
console.log(`messages: ${pg.messages.length}`);
console.log(`first message excerpt:\n${pg.messages[0].content.text?.slice(0, 400)}...`);

console.log("\n--- tools/call web_verify (uses cached Wikipedia page from L1) ---");
const tv = performance.now();
const verifyResult = await client.call<{
  structuredContent?: {
    claim: string;
    verdict: string;
    confidence: number;
    reasons: string[];
    sources: Array<{
      requested_url: string;
      title?: string | null;
      from_cache?: boolean;
      verdict: string;
      confidence: number;
      supporting_chunks: Array<{ chunk_id: number; text_preview: string }>;
      refuting_chunks: Array<{ chunk_id: number; text_preview: string }>;
    }>;
  };
}>(9, "tools/call", {
  name: "web_verify",
  arguments: {
    claim: "Model Context Protocol was introduced by Anthropic in November 2024",
    sources: ["https://en.wikipedia.org/wiki/Model_Context_Protocol"],
  },
});
console.log(`elapsed: ${Math.round(performance.now() - tv)}ms`);
const vr = verifyResult.structuredContent!;
console.log(`verdict: ${vr.verdict} (confidence=${vr.confidence})`);
console.log(`reasons: ${JSON.stringify(vr.reasons)}`);
for (const src of vr.sources) {
  console.log(
    `  - ${src.requested_url}: verdict=${src.verdict} confidence=${src.confidence} from_cache=${src.from_cache}`,
  );
  if (src.supporting_chunks[0]) {
    console.log(
      `      top supporting (chunk ${src.supporting_chunks[0].chunk_id}): ${src.supporting_chunks[0].text_preview.slice(0, 200)}...`,
    );
  }
}

client.close();
