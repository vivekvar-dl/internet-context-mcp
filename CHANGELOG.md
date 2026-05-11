# Changelog

All notable changes to this project are tracked here.

## [0.4.2] — 2026-05-11

### Changed

- README now ships an evaluated, narrow truthful claim about the contradiction detector. Adds a measured eval table across three batches (3 curated URL pairs + 5 live queries + 3 depth=8 sweeps; ~30 sources fetched). Zero contradictions detected, zero false positives. The synthetic positive test (`coffee lowers risk` vs `coffee raises risk`) still fires at confidence 0.9999.
- Spells out the three structural reasons the detector almost never fires on the indexed web (search-engine homogenization, hedged prose, primary-source 403s) and the cost of each direction you could push from here.

No behaviour change vs 0.4.1.

## [0.4.1] — 2026-05-11

### Fixed

- Contradiction detector produced 3 false positives on the "What is the capital of France?" control query in v0.4.0 (chunks about Versailles, jazz cafés, and city history flagged as contradicting each other). Root cause: bidirectional low NLI entailment is also produced by *unrelated* chunks, not just contradictory ones.

### Changed

- Two-stage detector: embedding-cosine prefilter (≥ 0.45) before NLI. Pairs below the topical floor are dropped. Real-world false-positive pair scored 0.36; synthetic positive scored 0.97 — clean separation.
- Dropped the same-cluster skip. Paraphrased contradictions ("coffee lowers risk" vs "coffee raises risk") cluster together at cosine ~0.9, so excluding same-cluster pairs would miss the contradictions we most want to surface. Topical prefilter is what now protects against spurious matches.
- Each contradiction now reports `topical_similarity` (cosine) alongside `confidence` (NLI signal).

Verified: five live queries that previously produced 3 false positives now produce 0; synthetic positive still fires.

## [0.4.0] — 2026-05-11

### Added

- **Semantic cross-source agreement.** `src/lib/embeddings.ts` using `Xenova/all-MiniLM-L6-v2` (~22 MB, mean-pooled, normalized, lazy-loaded). `cross-source-rank.ts` now clusters chunks by cosine similarity (threshold 0.5) by default; falls back to 4-gram shingle Jaccard if the embedding model fails to load. `clustering_method` field on every `web_research` response shows which path ran. On the MCP query, agreement score went from 0.0 (shingle) → 0.5 (semantic), reasons flipped from `sources_did_not_overlap` → `multiple_sources_corroborated`.
- **Cross-source contradiction detection.** `src/lib/cross-source-contradictions.ts` runs NLI both directions between cluster representatives from different sources for the top-K clusters, flags only when both directions show entailment ≤ 0.05. Synthetic validation: opposing coffee chunks → flagged at confidence 0.9999; no false positive against unrelated coffee-history chunk in the same batch.
- **Adversarial prompt-injection eval.** `evals/prompt-injection.json` (54 hand-curated cases across 6 categories: visible override, hidden text, HTML comment, credential request, exfiltration, benign controls). `scripts/eval-prompt-injection.ts` reports per-category detection rate, precision/recall, FPR. Reported numbers: **recall 0.925, precision 1.00, false-positive rate 0** on benign pages. Three honest misses documented in the roadmap.
- `npm run eval:injection` script and `reports/eval-prompt-injection-latest.json`.

### Changed

- Bumped server version to 0.4.0 in `package.json` and `serverInfo`.

## [0.3.0] — 2026-05-11

### Added

- **`web_research` tool.** One call: search → fetch top N in parallel → per-source ranking → cross-source clustering → unified evidence pack with per-chunk source citations, agreement-by-redundancy signal, and budget enforcement. Plus a `research_a_topic` MCP prompt template.
- **NLI-backed `web_verify`.** `src/lib/nli-classifier.ts` using `Xenova/nli-deberta-v3-xsmall` via Transformers.js zero-shot-classification (~80 MB, lazy-loaded). Replaces regex negation with real entailment/contradiction signal; regex path retained as labelled fallback when model load fails. `method` field surfaced on per-source verdicts. Fixes both v0.2 failure cases — "Python json is part of the stdlib" no longer falsely refuted; "Wikipedia requires payment" no longer falsely supported.
- **Cross-encoder reranker on by default** for `web_context` (`Xenova/ms-marco-MiniLM-L-6-v2`). Lazy-warmed at server start; `rerank: false` per call or `INTERNET_CONTEXT_MCP_RERANK=0` global escape hatch.

Eval: 20/20 relevance cases still pass under default-on reranker.

## [0.2.0] — 2026-05-11

### Added

- **`web_verify` tool.** Claim-vs-sources verification with per-source supporting/refuting chunks and negation-near-matched-terms detection.
- **Priority capsule** (TL;DR + top sections + highlight chunk ids) ahead of evidence chunks in every `web_context` response.
- **Retrieval confidence signal** with `level` / `score` / `reasons` / `suggestion` fields so the host LLM knows when to ask for more sources.
- **Two-tier fetch cache.** In-memory L1 + persistent SQLite L2 at `~/.cache/internet-context-mcp/`. Survives across host restarts. Lazy, best-effort (server continues if native SQLite binding fails).
- **Optional Playwright rendering** via `render: "browser"`. Declared as `optionalDependency` so default install stays small.
- **Optional local cross-encoder reranker** (later made default in 0.3.0).
- **MCP hygiene pass.** Every tool migrated from `server.tool` to `server.registerTool` with `readOnlyHint: true` + `openWorldHint: true` annotations. `outputSchema` on every tool (responses ship `structuredContent` alongside back-compat `text`). `internet-context://page/{fingerprint}` resource template backed by the L1+L2 cache. `verify_with_sources` and `summarize_from_context` MCP prompt templates. Tool descriptions tuned with "Use when:" hints so the host LLM disambiguates between `web_read` / `web_context` / `web_search` / `web_extract` / `web_verify`.

### Changed

- **Real tokenizer.** `js-tiktoken` cl100k_base replaces `chars / 4`. Lazy-loaded with chars/4 as fallback until ready.
- **`web_read` `mode: "full"`** now honours an upper token bound instead of silently dumping up to 5 MB of body.
- **Example config** at `examples/claude-desktop-config.example.json` no longer hard-codes a Windows user path.

### Fixed

- **SPA extraction.** Pages with no `<main>`/`<article>` or `<p>`/`<h*>` tags (`docs.anthropic.com`, similar bespoke React docs) used to return zero chunks. Now falls back to `document.body.textContent` after noise removal when both Readability and the section-tag extractor return < 200 chars. Measured: `docs.anthropic.com/.../prompt-caching` went from 0 → 28 chunks (static), 0 → 48 (browser), 99.7% token savings either way.

## [0.1.0]

Initial release. `web_read`, `web_context`, `web_extract`, `web_search` over MCP stdio. BM25-lite ranking, structured-data extraction, prompt-injection regex scan, source provenance with DOM paths.
