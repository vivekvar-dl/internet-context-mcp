# Techniques

This project is aimed at context engineering for AI agents, not general web scraping.

## Context Capsule

`web_context` returns a context capsule:

- source metadata and fingerprints
- structured data discovered in the page
- local prompt-injection risk scan
- ranked evidence chunks for the agent task
- token savings estimates

The host agent should treat webpage text as untrusted data and reason only from the returned evidence chunks.

## Current Techniques

- Main-content extraction with Readability-style cleanup.
- Local BM25-style chunk ranking for no-API-key token reduction.
- JSON-LD, metadata, and simple microdata extraction.
- Hidden/visible instruction-like text detection for prompt-injection risk.
- Short SHA-256 fingerprints for provenance and cache keys.
- Hybrid local ranking with BM25, phrase, heading, metadata, structured-data, and position signals.
- Chunk provenance with character offsets, section hints, DOM paths, and approximate source line ranges.
- Lost-in-context mitigation: a short priority capsule (TL;DR + top sections + highlight chunk ids) ships before the longer evidence list.
- Corrective retrieval signal: `retrieval_confidence` flags low-confidence results and suggests a wider budget or broader search.
- Evidence verification: `web_verify` checks claim support across one or more URLs, with simple negation detection near matched terms.
- Two-tier fetch cache: short-lived in-memory L1 + persistent SQLite L2 at `~/.cache/internet-context-mcp/`, survives across host restarts.
- Real tokenizer (`js-tiktoken` / cl100k_base) so `selected_tokens` and `savings_ratio` reflect what the host LLM will actually see.
- Optional local cross-encoder reranker (Xenova/ms-marco-MiniLM-L-6-v2 via `@huggingface/transformers`). Lazy-loaded on first opt-in call.
- Optional Playwright rendering for JS-heavy pages, declared as an `optionalDependency` so the default install stays small.
- MCP-native hygiene: `readOnlyHint`/`openWorldHint` annotations, `outputSchema` for typed structuredContent, `internet-context://page/<fingerprint>` resource template, and `verify_with_sources` / `summarize_from_context` prompt templates.
- Real-site stress testing across 100 public pages with live fetch, cleanup, ranking, structured data, safety scan, and provenance metrics.
- Labeled relevance evals that check fact preservation, junk avoidance, token budget, and provenance coverage.

## Research-Inspired Roadmap

- Contextual chunking: prepend local page metadata and section titles to chunks before optional dense reranking.
- Better provenance: add stable text-fragment anchors (`#:~:text=...`) and rendered DOM snapshots for dynamic pages.
- Late-interaction reranking: add an optional local cross-encoder reranker for better chunk selection.
- Persistent cache: extend the current in-memory cache with an optional on-disk layer.
- Multi-sentence claim decomposition: split compound claims inside `web_verify` and verify each piece independently.

## Open-Source Boundary

The default path should stay local and read-only. Optional model-backed rerankers can be added later, but the project should remain useful without requiring an LLM API key.
