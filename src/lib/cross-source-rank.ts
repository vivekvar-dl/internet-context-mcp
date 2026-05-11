// Pool ranked chunks from N sources, re-rank globally, and compute an
// agreement-by-redundancy signal that estimates how many independent
// sources support each cluster of similar evidence.

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
  agreement_count: number; // number of distinct sources whose chunks landed in this cluster
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
}

const SHINGLE_SIZE = 4;
const JACCARD_THRESHOLD = 0.18;

export function crossSourceRank(
  inputs: SourceChunkInput[],
  options: { maxOutput?: number } = {},
): CrossSourceResult {
  const maxOutput = options.maxOutput ?? 12;
  if (inputs.length === 0) {
    return {
      ranked_chunks: [],
      clusters: [],
      total_pooled: 0,
      unique_sources: 0,
    };
  }

  const shingleSets = inputs.map((entry) => shingles(entry.text));
  const clusters: CrossSourceCluster[] = [];
  const clusterShingles = new Map<number, Set<string>>();
  const memberClusterId = new Array<number>(inputs.length).fill(-1);

  for (let i = 0; i < inputs.length; i += 1) {
    let assignedCluster = -1;
    for (const cluster of clusters) {
      const repShingles = clusterShingles.get(cluster.cluster_id);
      if (!repShingles) continue;
      const similarity = jaccard(shingleSets[i], repShingles);
      if (similarity >= JACCARD_THRESHOLD) {
        assignedCluster = cluster.cluster_id;
        break;
      }
    }

    if (assignedCluster === -1) {
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
      memberClusterId[i] = newId;
    } else {
      const cluster = clusters.find((c) => c.cluster_id === assignedCluster)!;
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
      memberClusterId[i] = cluster.cluster_id;
    }
  }

  // Final combined score blends per-chunk rank with cross-source agreement.
  // Each additional supporting source adds 25% to the chunk's score, capped.
  const ranked: CrossSourceChunk[] = inputs.map((entry, i) => {
    const cluster = clusters.find((c) => c.cluster_id === memberClusterId[i])!;
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

  // Sort by combined_score desc, then by original normalized_score desc.
  ranked.sort(
    (a, b) =>
      b.combined_score - a.combined_score ||
      b.normalized_score - a.normalized_score,
  );

  // Dedupe: keep at most one chunk per cluster in the top output (the
  // representative). Surface additional clusters before duplicates.
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
  };
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
