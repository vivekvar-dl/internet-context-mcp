// Pool ranked chunks from N sources, cluster paraphrases via embedding cosine
// (or shingle Jaccard if the embedding model is unavailable), and emit a
// global ranking with a redundancy-based agreement signal.

import { cosineSimilarity, embedTexts } from "./embeddings.js";

export interface SourceChunkInput {
  source_index: number;
  source_url: string;
  source_title: string | null;
  source_fingerprint: string;
  chunk_id: number;
  text: string;
  normalized_score: number;
  matched_terms: string[];
  section: string | null;
  section_path: string[];
  token_estimate: number;
}

export interface CrossSourceChunk extends SourceChunkInput {
  cluster_id: number;
  agreement_count: number;
  combined_score: number;
}

export interface CrossSourceCluster {
  cluster_id: number;
  agreement_count: number;
  source_indices: number[];
  representative_chunk: CrossSourceChunk;
  member_count: number;
}

export interface CrossSourceResult {
  ranked_chunks: CrossSourceChunk[];
  clusters: CrossSourceCluster[];
  total_pooled: number;
  unique_sources: number;
  clustering_method: "embedding_cosine" | "shingle_jaccard";
}

const SHINGLE_SIZE = 4;
const SHINGLE_THRESHOLD = 0.18;
const COSINE_THRESHOLD = 0.5; // MiniLM tends to score genuine paraphrases at ~0.5; >0.7 is near-duplicate
const COSINE_PREVIEW_CHARS = 700; // embed only the first ~700 chars per chunk

export async function crossSourceRank(
  inputs: SourceChunkInput[],
  options: { maxOutput?: number; useEmbeddings?: boolean } = {},
): Promise<CrossSourceResult> {
  const maxOutput = options.maxOutput ?? 12;
  if (inputs.length === 0) {
    return {
      ranked_chunks: [],
      clusters: [],
      total_pooled: 0,
      unique_sources: 0,
      clustering_method: "shingle_jaccard",
    };
  }

  let method: CrossSourceResult["clustering_method"] = "embedding_cosine";
  let vectors: Float32Array[] | null = null;

  if (options.useEmbeddings ?? true) {
    vectors = await embedTexts(
      inputs.map((entry) => entry.text.slice(0, COSINE_PREVIEW_CHARS)),
    );
  }

  let assignments: number[];
  let clusters: CrossSourceCluster[];

  if (vectors && vectors.length === inputs.length) {
    ({ assignments, clusters } = clusterByCosine(inputs, vectors));
  } else {
    method = "shingle_jaccard";
    ({ assignments, clusters } = clusterByShingles(inputs));
  }

  const ranked: CrossSourceChunk[] = inputs.map((entry, i) => {
    const cluster = clusters.find((c) => c.cluster_id === assignments[i])!;
    const agreementMultiplier = Math.min(1.6, 1 + 0.25 * (cluster.agreement_count - 1));
    return {
      ...entry,
      cluster_id: cluster.cluster_id,
      agreement_count: cluster.agreement_count,
      combined_score: Number(
        (entry.normalized_score * agreementMultiplier).toFixed(4),
      ),
    };
  });

  ranked.sort(
    (a, b) =>
      b.combined_score - a.combined_score ||
      b.normalized_score - a.normalized_score,
  );

  const seenClusters = new Set<number>();
  const deduped: CrossSourceChunk[] = [];
  for (const chunk of ranked) {
    if (seenClusters.has(chunk.cluster_id)) {
      continue;
    }
    seenClusters.add(chunk.cluster_id);
    deduped.push(chunk);
    if (deduped.length >= maxOutput) {
      break;
    }
  }

  return {
    ranked_chunks: deduped,
    clusters,
    total_pooled: inputs.length,
    unique_sources: new Set(inputs.map((entry) => entry.source_index)).size,
    clustering_method: method,
  };
}

function clusterByCosine(
  inputs: SourceChunkInput[],
  vectors: Float32Array[],
): { assignments: number[]; clusters: CrossSourceCluster[] } {
  const clusters: CrossSourceCluster[] = [];
  const clusterVectors = new Map<number, Float32Array>();
  const assignments = new Array<number>(inputs.length).fill(-1);

  for (let i = 0; i < inputs.length; i += 1) {
    let best = { cluster: -1, sim: 0 };
    for (const cluster of clusters) {
      const rep = clusterVectors.get(cluster.cluster_id);
      if (!rep) continue;
      const sim = cosineSimilarity(vectors[i], rep);
      if (sim > best.sim) {
        best = { cluster: cluster.cluster_id, sim };
      }
    }

    if (best.cluster !== -1 && best.sim >= COSINE_THRESHOLD) {
      const cluster = clusters.find((c) => c.cluster_id === best.cluster)!;
      cluster.member_count += 1;
      if (!cluster.source_indices.includes(inputs[i].source_index)) {
        cluster.source_indices.push(inputs[i].source_index);
        cluster.agreement_count = cluster.source_indices.length;
      }
      if (
        inputs[i].normalized_score >
        cluster.representative_chunk.normalized_score
      ) {
        cluster.representative_chunk = {
          ...inputs[i],
          cluster_id: cluster.cluster_id,
          agreement_count: cluster.agreement_count,
          combined_score: inputs[i].normalized_score,
        };
        clusterVectors.set(cluster.cluster_id, vectors[i]);
      }
      cluster.representative_chunk.agreement_count = cluster.agreement_count;
      assignments[i] = cluster.cluster_id;
    } else {
      const newId = clusters.length + 1;
      clusters.push({
        cluster_id: newId,
        agreement_count: 1,
        source_indices: [inputs[i].source_index],
        representative_chunk: {
          ...inputs[i],
          cluster_id: newId,
          agreement_count: 1,
          combined_score: inputs[i].normalized_score,
        },
        member_count: 1,
      });
      clusterVectors.set(newId, vectors[i]);
      assignments[i] = newId;
    }
  }

  return { assignments, clusters };
}

function clusterByShingles(inputs: SourceChunkInput[]): {
  assignments: number[];
  clusters: CrossSourceCluster[];
} {
  const shingleSets = inputs.map((entry) => shingles(entry.text));
  const clusters: CrossSourceCluster[] = [];
  const clusterShingles = new Map<number, Set<string>>();
  const assignments = new Array<number>(inputs.length).fill(-1);

  for (let i = 0; i < inputs.length; i += 1) {
    let assigned = -1;
    for (const cluster of clusters) {
      const rep = clusterShingles.get(cluster.cluster_id);
      if (!rep) continue;
      const sim = jaccard(shingleSets[i], rep);
      if (sim >= SHINGLE_THRESHOLD) {
        assigned = cluster.cluster_id;
        break;
      }
    }
    if (assigned === -1) {
      const newId = clusters.length + 1;
      clusters.push({
        cluster_id: newId,
        agreement_count: 1,
        source_indices: [inputs[i].source_index],
        representative_chunk: {
          ...inputs[i],
          cluster_id: newId,
          agreement_count: 1,
          combined_score: inputs[i].normalized_score,
        },
        member_count: 1,
      });
      clusterShingles.set(newId, shingleSets[i]);
      assignments[i] = newId;
    } else {
      const cluster = clusters.find((c) => c.cluster_id === assigned)!;
      cluster.member_count += 1;
      if (!cluster.source_indices.includes(inputs[i].source_index)) {
        cluster.source_indices.push(inputs[i].source_index);
        cluster.agreement_count = cluster.source_indices.length;
      }
      if (
        inputs[i].normalized_score >
        cluster.representative_chunk.normalized_score
      ) {
        cluster.representative_chunk = {
          ...inputs[i],
          cluster_id: cluster.cluster_id,
          agreement_count: cluster.agreement_count,
          combined_score: inputs[i].normalized_score,
        };
        clusterShingles.set(cluster.cluster_id, shingleSets[i]);
      }
      cluster.representative_chunk.agreement_count = cluster.agreement_count;
      assignments[i] = cluster.cluster_id;
    }
  }

  return { assignments, clusters };
}

function shingles(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const set = new Set<string>();
  for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i += 1) {
    set.add(tokens.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersect = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersect += 1;
    }
  }
  return intersect / (a.size + b.size - intersect);
}
