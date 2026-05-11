# internet-context-mcp

Clean, compact web context capsules for AI agents.

This MCP server gives agents read-only internet tools without dumping raw HTML into the model context. The main idea is simple: fetch a page, remove noise, rank the useful chunks for the current task, and return a context capsule the host agent can reason over.

A context capsule includes:

- a short priority capsule (TL;DR) before the long evidence
- ranked evidence chunks
- a retrieval confidence signal so the agent can ask for more sources when needed
- structured data from the page, when present
- page metadata and content fingerprints
- prompt-injection risk warnings
- token savings estimates

Every tool ships with proper MCP metadata so hosts can use it cleanly:

- `readOnlyHint: true` + `openWorldHint: true` annotations — Claude Desktop / Claude Code can skip permission prompts for these tools.
- `outputSchema` on every tool — hosts get typed JSON (`structuredContent`) instead of re-parsing free-form text.
- `internet-context://page/<fingerprint>` MCP resources — the host can re-reference fetched pages by URI without re-calling a tool.
- `verify_with_sources` and `summarize_from_context` MCP prompts — slash-command surface for hosts that expose prompt templates.
- Two-tier fetch cache: in-memory + a persistent SQLite layer at `~/.cache/internet-context-mcp/cache.sqlite`. Survives across host restarts.
- Real tokenizer via `js-tiktoken` (cl100k_base). No more `chars / 4` approximations.
- Optional Playwright rendering for JS-heavy pages, gated behind `render: "browser"` and shipped only as an `optionalDependency`.
- Local cross-encoder reranker (`Xenova/ms-marco-MiniLM-L-6-v2`) via Transformers.js — **on by default** as of v0.3.0, lazy-loaded at server start. Pass `rerank: false` per call or set `INTERNET_CONTEXT_MCP_RERANK=0` to disable.
- Local NLI classifier (`Xenova/nli-deberta-v3-xsmall`, zero-shot-classification) backs `web_verify` — on by default with a regex fallback if the model fails to load. Disable with `INTERNET_CONTEXT_MCP_NLI=0`.

## Tools

### `web_research`

One-shot research tool: search the web, fetch the top N results in parallel, rank chunks within each source (with the local reranker by default), then cross-rank globally and return a unified evidence pack with per-chunk source citations and a redundancy-based agreement signal.

Use this when you'd otherwise be calling `web_search` and then `web_context` several times in a row.

Input:

```json
{
  "query": "What is the Model Context Protocol and who built it?",
  "depth": 4,
  "max_tokens_total": 3000
}
```

Output shape (abbreviated):

```json
{
  "query": "...",
  "provider": "duckduckgo_html",
  "depth": 4,
  "unique_sources": 3,
  "sources": [
    {
      "index": 0,
      "requested_url": "https://en.wikipedia.org/wiki/Model_Context_Protocol",
      "ok": true,
      "title": "Model Context Protocol - Wikipedia",
      "retrieval_confidence": { "level": "high", "score": 0.79 },
      "selected_chunks": 1
    }
  ],
  "ranked_evidence": [
    {
      "source_index": 1,
      "source_url": "https://www.anthropic.com/news/model-context-protocol",
      "source_title": "Introducing the Model Context Protocol",
      "chunk_id": 2,
      "cluster_id": 2,
      "agreement_count": 1,
      "score": 1.0,
      "combined_score": 1.0,
      "section": null,
      "matched_terms": ["model", "context", "protocol"],
      "text": "Today, we're open-sourcing the Model Context Protocol..."
    }
  ],
  "agreement_score": 0.0,
  "verdict_reasons": ["sources_did_not_overlap"],
  "token_budget": { "max_tokens_total": 3000, "used_tokens": 1949 }
}
```

`agreement_count` and `agreement_score` use **semantic similarity** (all-MiniLM-L6-v2 cosine, ~22MB, lazy-loaded) by default in v0.4.0+. Paraphrased agreement now counts: three sources independently saying the same fact in different words will cluster together. The clustering falls back to 4-gram shingle Jaccard when the embedding model fails to load; the `clustering_method` field on every response shows which one ran.

`contradictions` lists cases where chunks from different sources are on the same topic but neither entails the other in either direction. The detector runs in two stages: an **embedding-cosine prefilter** (≥0.45) that requires the two chunks be discussing the same claim, and then an **NLI bidirectional non-entailment** check (≤0.05 entailment both directions) on the survivors. Both must hold.

Each contradiction includes `topical_similarity` (the actual cosine) and `confidence` (the NLI signal).

The prefilter intentionally allows same-cluster pairs through: in the wild, two sources making *opposing* claims about the same fact paraphrase each other with very high cosine (~0.9), so they cluster together. Excluding same-cluster pairs would mean missing the contradictions we most want to surface.

#### Detector evaluation — measured, not aspirational

This is what we have measured the detector to actually do. Eval scripts are in `scripts/demo-contradiction-*.ts` so the numbers are reproducible.

| Eval set | Sources fetched | Contradictions detected | What it means |
|---|---:|---:|---|
| Synthetic positive ("coffee lowers cardio risk" vs "coffee raises cardio risk") | n/a | **1** (conf 0.9999, topical 0.91) | Detector fires on hand-crafted unambiguous disagreement |
| 5 live queries (eggs, intermittent fasting, coffee/heart, speed of light, capital of France) | 18 | **0** | Zero false positives. v0.4.0 produced 3 false positives on this exact set; v0.4.1 cleared them all. |
| 3 curated URL pairs picked precisely *because* the sources should disagree (aspirin primary prevention, vitamin D, saturated fat) | 5 of 8 — NEJM/BMJ returned 403 to static fetch | **0** | The sources that fetched gave nuanced caution; primary sources where the dispute is direct were paywalled. |
| 3 depth=8 search sweeps on topics with known popular-vs-evidence splits (stretching, breakfast, running and knees) | 23 of 24 | **0** | Search engines return the current consensus; the dispute lives elsewhere. |

**Across ~30 real sources fetched, the detector fired exactly zero times. It also produced zero false positives.**

The truthful claim about v0.4.x: the detector has **near-zero false-positive rate on real-world web** and fires reliably on **lexically explicit opposing claims**. It does not, in our testing, detect disputes that are real but expressed with hedged or qualified prose — which is most of how the indexed web talks about disagreement. Three reasons:

1. Search engines (DDG, Google) return homogenized mainstream content; the dispute lives in academic papers or contrarian sources that don't rank well.
2. Mainstream web prose qualifies its disagreement ("some studies suggest", "for certain populations", "recent research has shown"). NLI's bidirectional non-entailment does not fire on hedged contrast.
3. Many primary sources where the dispute *is* direct (NEJM, BMJ, ScienceDirect, Britannica) block static fetches with HTTP 403.

If you want the detector to catch hedged disagreement, you'd need to loosen the entailment ceiling and accept some false positives. If you want broader source access, you'd need browser rendering and (for paywalled journals) credentials. v0.4.x does neither; it stays read-only, local, and honest about what it sees.

**Honest caveat about the agreement signal**: when `agreement_count=N` across N sources, that means N sources from the search results corroborated each other — not that the claim is true. Search engines tend to return the current mainstream view, which can hide genuine disputes (the eggs/cholesterol query returned 4 modern sources all agreeing the modern consensus, even though the topic was contested for decades).

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
  "priority_capsule": {
    "tldr": "Install with npm install example. Configure via the MCP client config file.",
    "top_sections": ["Installation", "Configuration"],
    "highlight_chunk_ids": [2, 3]
  },
  "retrieval_confidence": {
    "level": "high",
    "score": 0.78,
    "reasons": [],
    "suggestion": null
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

### `web_verify`

Checks whether a claim is supported, refuted, or unclear from one or more source URLs. Fetches each source, ranks chunks against the claim, and looks for explicit support or contradiction (with simple negation detection near matched terms). Returns a combined verdict plus per-source supporting and refuting evidence chunks.

Input:

```json
{
  "claim": "the server is read-only",
  "sources": [
    "https://example.com/docs",
    "https://example.com/safety"
  ],
  "max_tokens_per_source": 1400
}
```

Output shape:

```json
{
  "claim": "the server is read-only",
  "verdict": "supported",
  "confidence": 0.82,
  "reasons": ["2_sources_support"],
  "sources": [
    {
      "requested_url": "https://example.com/docs",
      "final_url": "https://example.com/docs",
      "title": "Documentation",
      "verdict": "supported",
      "confidence": 0.74,
      "supporting_chunks": [
        {
          "chunk_id": 3,
          "section": "Safety",
          "score": 0.91,
          "matched_terms": ["server", "read", "only"],
          "contains_negation": false,
          "text_preview": "The default tools are read-only and never submit forms or modify remote data."
        }
      ],
      "refuting_chunks": []
    }
  ]
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

## Prompt-Injection Eval

The repo includes a 54-case adversarial set in `evals/prompt-injection.json` covering visible instruction-override, hidden-text (display:none / visibility:hidden / opacity:0 / aria-hidden / off-screen), HTML-comment injection, credential requests, exfiltration prompts, and benign-control pages.

```bash
npm run eval:injection
```

Reported numbers for v0.4.0 (regex scanner, no LLM):

```json
{
  "true_positive_rate": 0.925,
  "false_positive_rate": 0,
  "precision": 1,
  "recall": 0.925,
  "by_category": {
    "instruction_override_visible": 0.80,
    "hidden_text": 0.90,
    "html_comment": 1.00,
    "credential_request": 1.00,
    "exfiltration": 1.00,
    "benign_control": 1.00
  }
}
```

Known misses: "disregard *the* prior instructions" (intervening article), "no longer valid" framing, off-screen positioning via `position:absolute;left:-9999px`. Real failures, intentionally surfaced rather than papered over.

## Relevance Eval

The repo includes a labeled relevance set in `evals/relevance.json`. It checks whether compressed capsules preserve required facts, avoid junk terms, stay under the evidence token budget, and include source provenance.

```bash
npm run eval:relevance
```

The latest 20-case run on v0.3.0 (reranker on by default, real tokenizer) passed all cases:

```json
{
  "all_pass_rate": 1,
  "included_pass_rate": 1,
  "excluded_pass_rate": 1,
  "provenance_pass_rate": 1,
  "token_budget_pass_rate": 1,
  "average_token_savings_ratio": 0.9192
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

## Configuration

Environment variables:

- `BRAVE_SEARCH_API_KEY` — if set, `web_search` uses Brave Search instead of the DuckDuckGo HTML fallback.
- `INTERNET_CONTEXT_MCP_RERANK=1` — enable the local cross-encoder reranker globally. Off by default.
- `INTERNET_CONTEXT_MCP_CACHE_DIR` — override the SQLite cache location. Defaults to `~/.cache/internet-context-mcp`.

To enable browser rendering (only needed for JS-rendered SPAs):

```bash
npm install playwright
npx playwright install chromium
```

Then call any tool with `render: "browser"`.

## Next Milestones

1. Multi-sentence claim decomposition in `web_verify` so compound claims return per-clause verdicts.
2. Stable text-fragment anchors (`#:~:text=...`) in chunk provenance for deep-linking back to the page.
3. PDF support for the fetch + clean pipeline.
4. `robots.txt` + crawl-delay awareness for responsible read-only fetching.
5. Expand the prompt-injection eval beyond the hand-curated 54 cases — integrate publicly-available adversarial datasets.
6. Close the regex gaps the injection eval surfaced (intervening articles, "no longer valid", off-screen positioning).
