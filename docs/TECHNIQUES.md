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
- Local cross-encoder reranker (Xenova/ms-marco-MiniLM-L-6-v2 via `@huggingface/transformers`) is on by default as of v0.3.0; lazy-loaded at server start.
- Local zero-shot NLI classifier (Xenova/nli-deberta-v3-xsmall) backs `web_verify` for real entailment/contradiction signals, with a regex fallback if the model fails to load.
- `web_research` orchestrates search → parallel fetch → per-source ranking → cross-source semantic clustering → unified evidence pack with per-chunk citations, an agreement signal that catches paraphrased corroboration, and a `contradictions` array surfaced when NLI detects bidirectional non-entailment between cluster representatives from different sources.
- Local sentence embeddings via Xenova/all-MiniLM-L6-v2 (~22MB, lazy-loaded) power the semantic clustering. Falls back to 4-gram shingle Jaccard if the model fails to load; the `clustering_method` field reports which path ran.
- Adversarial prompt-injection eval (54 hand-curated cases across 6 categories) in `evals/prompt-injection.json`; v0.4.0 reports 92.5% recall and 0% false-positive rate on benign control pages — published in the README so the safety claim is evidence-backed rather than aspirational.
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
