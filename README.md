# internet-context-mcp

Clean, compact web context capsules for AI agents.

This MCP server gives agents read-only internet tools without dumping raw HTML into the model context. The main idea is simple: fetch a page, remove noise, rank the useful chunks for the current task, and return a context capsule the host agent can reason over.

A context capsule includes:

- ranked evidence chunks
- structured data from the page, when present
- page metadata and content fingerprints
- prompt-injection risk warnings
- token savings estimates

## Tools

### `web_context`

Fetches a URL, cleans it, splits it into chunks, ranks chunks against an agent task with a local BM25-style algorithm, and returns only the best evidence budget. This is the main token-reduction tool.

Input:

```json
{
  "url": "https://example.com/docs",
  "task": "find installation steps and configuration details",
  "max_tokens": 1800
}
```

Output shape:

```json
{
  "task": "find installation steps and configuration details",
  "title": "Documentation",
  "context": "[chunk 2 | score 1]\\nInstall the package with npm install example...",
  "evidence_chunks": [
    {
      "id": 2,
      "score": 1,
      "score_breakdown": {
        "bm25": 2.4,
        "phrase": 0,
        "heading": 0.5,
        "metadata": 0.35,
        "structured_data": 0,
        "position": 0
      },
      "provenance": {
        "char_start": 182,
        "char_end": 348,
        "section": "Installation",
        "section_path": ["Installation"],
        "source_blocks": [
          {
            "block_id": 4,
            "tag": "p",
            "dom_path": "body:nth-of-type(1) > main:nth-of-type(1) > section:nth-of-type(1) > p:nth-of-type(1)",
            "line_start": 22,
            "line_end": 22,
            "overlap_score": 1,
            "text_preview": "Install the package with npm install example."
          }
        ]
      },
      "matched_terms": ["install", "config"],
      "text": "Install the package with npm install example..."
    }
  ],
  "structured_data": {
    "metadata": {
      "description": "..."
    },
    "json_ld": [],
    "microdata": []
  },
  "safety": {
    "risk": "low",
    "score": 0,
    "warnings": []
  },
  "provenance": {
    "content_fingerprint": "9f2a1c6e7b0d3a11",
    "clean_text_fingerprint": "3d41e2f0780a5c19"
  },
  "ranking": {
    "algorithm": "hybrid-bm25-lite",
    "signals": ["bm25", "phrase", "heading", "metadata", "structured_data", "position"],
    "total_chunks": 12,
    "selected_chunks": 3,
    "selected_tokens": 940
  },
  "token_savings_estimate": {
    "raw_tokens": 42000,
    "returned_tokens": 1100,
    "saved_tokens": 40900,
    "savings_ratio": 0.9738
  }
}
```

### `web_read`

Fetches a URL, removes noisy page chrome, extracts the main content, and returns clean text plus token savings metadata.

Input:

```json
{
  "url": "https://example.com/docs",
  "query": "installation configuration",
  "mode": "compact",
  "max_tokens": 4000
}
```

### `web_search`

Searches the web and returns compact, source-classified results.

If `BRAVE_SEARCH_API_KEY` is set, it uses Brave Search. Otherwise it falls back to DuckDuckGo HTML search.

Input:

```json
{
  "query": "Model Context Protocol TypeScript SDK docs",
  "limit": 5
}
```

### `web_extract`

Best-effort generic field extraction from clean page text. This is intentionally secondary to `web_context`; in many agents, the better flow is to call `web_context` and let the host model reason over the returned evidence chunks.

Input:

```json
{
  "url": "https://example.com/docs",
  "schema": {
    "title": "string",
    "install_command": "string",
    "configuration_file": "string"
  },
  "query": "installation command configuration file"
}
```

## Install

```bash
npm install
npm run build
npm test
```

## Real-Site Stress Test

The repo includes a 100-URL real-data stress set in `data/real-sites.json`. It exercises the full pipeline against live pages:

```bash
npm run stress:real
```

Useful options:

```bash
npm run stress:real -- --limit=20 --concurrency=3 --timeout=15000 --maxTokens=1500
```

The script writes a compact report to:

```text
reports/stress-real-sites-latest.json
```

It measures live fetch success, token savings, selected chunks, structured-data detection, safety warnings, and source provenance coverage.

## Relevance Eval

The repo includes a labeled relevance set in `evals/relevance.json`. It checks whether compressed capsules preserve required facts, avoid junk terms, stay under the evidence token budget, and include source provenance.

```bash
npm run eval:relevance
```

The latest 20-case run passed all cases:

```json
{
  "all_pass_rate": 1,
  "included_pass_rate": 1,
  "excluded_pass_rate": 1,
  "provenance_pass_rate": 1,
  "token_budget_pass_rate": 1,
  "average_token_savings_ratio": 0.9158
}
```

The report is written to:

```text
reports/eval-relevance-latest.json
```

## Run

```bash
npm run dev
```

For built usage:

```bash
npm run build
node dist/index.js
```

## MCP Client Config

For clients that accept JSON MCP server config:

```json
{
  "mcpServers": {
    "internet-context": {
      "command": "node",
      "args": ["C:/Users/domai/internet-context-mcp/dist/index.js"],
      "env": {
        "BRAVE_SEARCH_API_KEY": ""
      }
    }
  }
}
```

## Design Constraints

- Read-only first: no clicking, login, purchases, form submissions, or state-changing actions.
- Compact output first: agents should get useful context, not page dumps.
- Local ranking first: reduce tokens without requiring a second LLM API key.
- Evidence first: returned context should include the text used to support claims.
- Untrusted web content first: pages are scanned for instruction-like text before the agent reasons over them.
- Honest limits: weak extraction should be marked as weak instead of pretending to be reliable.

## Current Status

This is an early open-source prototype. The strongest part is `web_context`: local cleanup, chunking, ranking, structured-data discovery, safety scanning, and token reduction. The weakest part is generic structured extraction without an LLM, so that tool should stay secondary until it has real eval coverage.

## Next Milestones

1. Add more neutral eval fixtures for docs, articles, search pages, and reference pages.
2. Improve chunk provenance with line/offset ranges and DOM hints.
3. Add hybrid ranking: BM25 + metadata boost + optional embedding/cross-encoder reranker.
4. Add cache support to avoid repeated fetches.
5. Add `web_verify(claim, sources)` for evidence checking.
