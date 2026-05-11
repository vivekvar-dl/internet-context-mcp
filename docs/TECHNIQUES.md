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
- Real-site stress testing across 100 public pages with live fetch, cleanup, ranking, structured data, safety scan, and provenance metrics.
- Labeled relevance evals that check fact preservation, junk avoidance, token budget, and provenance coverage.

## Research-Inspired Roadmap

- Contextual chunking: prepend local page metadata and section titles to chunks before optional dense reranking.
- Better provenance: add stable text-fragment anchors and rendered DOM snapshots for dynamic pages.
- Late-interaction reranking: add an optional local reranker for better chunk selection.
- Lost-in-context mitigation: return a short priority capsule before longer supporting chunks.
- Corrective retrieval: flag low-confidence retrieval and suggest broader search/read calls.
- Evidence verification: add `web_verify` to check whether a claim is supported by returned chunks.

## Open-Source Boundary

The default path should stay local and read-only. Optional model-backed rerankers can be added later, but the project should remain useful without requiring an LLM API key.
