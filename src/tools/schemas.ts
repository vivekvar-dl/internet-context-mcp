import { z } from "zod";

const tokenSavingsSchema = z.object({
  raw_tokens: z.number(),
  returned_tokens: z.number(),
  saved_tokens: z.number(),
  savings_ratio: z.number(),
});

const sourceBlockSchema = z.object({
  block_id: z.number(),
  tag: z.string(),
  dom_path: z.string(),
  line_start: z.number().nullable(),
  line_end: z.number().nullable(),
  section: z.string().nullable(),
  section_path: z.array(z.string()),
  overlap_score: z.number(),
  text_preview: z.string(),
});

const evidenceChunkSchema = z.object({
  id: z.number(),
  score: z.number(),
  raw_score: z.number(),
  score_breakdown: z.object({
    bm25: z.number(),
    phrase: z.number(),
    heading: z.number(),
    metadata: z.number(),
    structured_data: z.number(),
    position: z.number(),
  }),
  token_estimate: z.number(),
  provenance: z.object({
    char_start: z.number(),
    char_end: z.number(),
    section: z.string().nullable(),
    section_path: z.array(z.string()),
    source_blocks: z.array(sourceBlockSchema),
  }),
  matched_terms: z.array(z.string()),
  text: z.string(),
});

const structuredDataSchema = z.object({
  metadata: z.record(z.string(), z.string()),
  json_ld: z.array(z.unknown()),
  microdata: z.array(
    z.object({
      type: z.string().nullable(),
      id: z.string().nullable(),
      properties: z.record(z.string(), z.array(z.string())),
    }),
  ),
});

const safetySchema = z.object({
  risk: z.enum(["low", "medium", "high"]),
  score: z.number(),
  warnings: z.array(
    z.object({
      type: z.string(),
      severity: z.enum(["low", "medium", "high"]),
      location: z.string(),
      snippet: z.string(),
    }),
  ),
});

export const webContextOutputShape = {
  task: z.string(),
  requested_url: z.string(),
  final_url: z.string(),
  retrieved_at: z.string(),
  title: z.string().nullable(),
  excerpt: z.string().nullable(),
  provenance: z.object({
    content_fingerprint: z.string(),
    clean_text_fingerprint: z.string(),
    status: z.number(),
    content_type: z.string(),
    truncated: z.boolean(),
    timed_out: z.boolean(),
    bytes_read: z.number(),
    max_bytes: z.number(),
    from_cache: z.boolean(),
  }),
  structured_data: structuredDataSchema,
  safety: safetySchema,
  priority_capsule: z.object({
    tldr: z.string(),
    top_sections: z.array(z.string()),
    highlight_chunk_ids: z.array(z.number()),
  }),
  retrieval_confidence: z.object({
    level: z.enum(["high", "medium", "low"]),
    score: z.number(),
    reasons: z.array(z.string()),
    suggestion: z.string().nullable(),
  }),
  context: z.string(),
  evidence_chunks: z.array(evidenceChunkSchema),
  ranking: z.object({
    algorithm: z.string(),
    signals: z.array(z.string()),
    total_chunks: z.number(),
    selected_chunks: z.number(),
    selected_tokens: z.number(),
  }),
  instructions: z.array(z.string()),
  token_savings_estimate: tokenSavingsSchema,
};

export const webReadOutputShape = {
  requested_url: z.string(),
  final_url: z.string(),
  retrieved_at: z.string(),
  status: z.number(),
  content_type: z.string(),
  provenance: z.object({
    content_fingerprint: z.string(),
    clean_text_fingerprint: z.string(),
    truncated: z.boolean(),
    timed_out: z.boolean(),
    bytes_read: z.number(),
    max_bytes: z.number(),
  }),
  title: z.string().nullable(),
  byline: z.string().nullable(),
  excerpt: z.string().nullable(),
  site_name: z.string().nullable(),
  headings: z.array(z.string()),
  structured_data: structuredDataSchema,
  safety: safetySchema,
  clean_text: z.string(),
  token_savings_estimate: tokenSavingsSchema,
};

export const webSearchOutputShape = {
  query: z.string(),
  provider: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
      source_quality: z.string(),
    }),
  ),
};

export const webExtractOutputShape = {
  requested_url: z.string(),
  final_url: z.string(),
  title: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  evidence: z.array(
    z.object({
      field: z.string(),
      url: z.string(),
      text: z.string(),
      confidence: z.number(),
    }),
  ),
  unfilled_fields: z.array(z.string()),
  confidence: z.number(),
  notes: z.array(z.string()),
  token_savings_estimate: tokenSavingsSchema,
};

const chunkClaimMatchSchema = z.object({
  chunk_id: z.number(),
  section: z.string().nullable(),
  score: z.number(),
  matched_terms: z.array(z.string()),
  contains_negation: z.boolean(),
  text_preview: z.string(),
  nli_label: z
    .enum(["entailment", "neutral", "contradiction"])
    .optional(),
  nli_score: z.number().optional(),
});

export const webVerifyOutputShape = {
  claim: z.string(),
  verdict: z.enum(["supported", "refuted", "unclear"]),
  confidence: z.number(),
  reasons: z.array(z.string()),
  instructions: z.array(z.string()),
  sources: z.array(
    z.object({
      requested_url: z.string(),
      final_url: z.string().optional(),
      status: z.number().optional(),
      title: z.string().nullable().optional(),
      from_cache: z.boolean().optional(),
      content_fingerprint: z.string().optional(),
      safety_risk: z.string().optional(),
      ok: z.boolean(),
      error: z.string().optional(),
      verdict: z.enum(["supported", "refuted", "unclear"]),
      confidence: z.number(),
      reasons: z.array(z.string()),
      method: z.enum(["nli", "regex_fallback"]).optional(),
      supporting_chunks: z.array(chunkClaimMatchSchema),
      refuting_chunks: z.array(chunkClaimMatchSchema),
    }),
  ),
};

export const webResearchOutputShape = {
  query: z.string(),
  provider: z.string(),
  depth: z.number(),
  retrieved_at: z.string(),
  elapsed_ms: z.number(),
  unique_sources: z.number(),
  sources: z.array(
    z.object({
      index: z.number(),
      requested_url: z.string(),
      final_url: z.string().optional(),
      title: z.string().nullable(),
      source_quality: z.string(),
      content_fingerprint: z.string().optional(),
      from_cache: z.boolean().optional(),
      status: z.number().optional(),
      ok: z.boolean(),
      error: z.string().optional(),
      retrieval_confidence: z
        .object({
          level: z.enum(["high", "medium", "low"]),
          score: z.number(),
          reasons: z.array(z.string()),
          suggestion: z.string().nullable(),
        })
        .optional(),
      selected_chunks: z.number().optional(),
    }),
  ),
  ranked_evidence: z.array(
    z.object({
      source_index: z.number(),
      source_url: z.string(),
      source_title: z.string().nullable(),
      chunk_id: z.number(),
      cluster_id: z.number(),
      agreement_count: z.number(),
      score: z.number(),
      combined_score: z.number(),
      section: z.string().nullable(),
      section_path: z.array(z.string()),
      matched_terms: z.array(z.string()),
      token_estimate: z.number(),
      text: z.string(),
    }),
  ),
  agreement_score: z.number(),
  clustering_method: z.enum(["embedding_cosine", "shingle_jaccard"]),
  contradictions: z.array(
    z.object({
      a: z.object({
        cluster_id: z.number(),
        source_index: z.number(),
        source_url: z.string(),
        source_title: z.string().nullable(),
        chunk_id: z.number(),
        text_preview: z.string(),
      }),
      b: z.object({
        cluster_id: z.number(),
        source_index: z.number(),
        source_url: z.string(),
        source_title: z.string().nullable(),
        chunk_id: z.number(),
        text_preview: z.string(),
      }),
      confidence: z.number(),
      topical_similarity: z.number(),
      reason: z.string(),
    }),
  ),
  verdict_reasons: z.array(z.string()),
  instructions: z.array(z.string()),
  token_budget: z.object({
    max_tokens_total: z.number(),
    used_tokens: z.number(),
  }),
};

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;
