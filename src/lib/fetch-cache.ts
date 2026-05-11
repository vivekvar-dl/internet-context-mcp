import { shortFingerprint } from "./fingerprint.js";
import type { FetchedPage } from "./fetch-page.js";
import {
  getPersistent,
  getPersistentByFingerprint,
  setPersistent,
} from "./persistent-cache.js";

interface CacheEntry {
  page: FetchedPage;
  storedAt: number;
  hits: number;
  fingerprint: string;
}

export interface FetchCacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 128;

const store = new Map<string, CacheEntry>();
const fingerprintIndex = new Map<string, string>();
let ttlMs = DEFAULT_TTL_MS;
let maxEntries = DEFAULT_MAX_ENTRIES;
let hits = 0;
let misses = 0;
let evictions = 0;

export function cacheKey(url: string, userAgent: string | undefined): string {
  return `${userAgent ?? ""}\n${url}`;
}

export function getCached(key: string, now = Date.now()): FetchedPage | null {
  const entry = store.get(key);

  if (entry) {
    if (now - entry.storedAt > ttlMs) {
      store.delete(key);
      fingerprintIndex.delete(entry.fingerprint);
      misses += 1;
      evictions += 1;
    } else {
      store.delete(key);
      store.set(key, entry);
      entry.hits += 1;
      hits += 1;
      return entry.page;
    }
  } else {
    misses += 1;
  }

  // L2: SQLite. On hit, promote into L1 so subsequent calls are zero-cost.
  const persisted = getPersistent(key, now);
  if (persisted) {
    store.set(key, {
      page: persisted.page,
      storedAt: now,
      hits: 1,
      fingerprint: persisted.fingerprint,
    });
    fingerprintIndex.set(persisted.fingerprint, key);
    hits += 1;
    return persisted.page;
  }

  return null;
}

export function setCached(key: string, page: FetchedPage, now = Date.now()): void {
  const existing = store.get(key);
  if (existing) {
    fingerprintIndex.delete(existing.fingerprint);
    store.delete(key);
  }

  const fingerprint = shortFingerprint(page.body);
  store.set(key, { page, storedAt: now, hits: 0, fingerprint });
  fingerprintIndex.set(fingerprint, key);
  setPersistent(key, page, fingerprint, ttlMs, now);

  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;

    if (oldest === undefined) {
      break;
    }

    const evicted = store.get(oldest);
    if (evicted) {
      fingerprintIndex.delete(evicted.fingerprint);
    }
    store.delete(oldest);
    evictions += 1;
  }
}

export function getByFingerprint(
  fingerprint: string,
  now = Date.now(),
): FetchedPage | null {
  const key = fingerprintIndex.get(fingerprint);
  if (key) {
    return getCached(key, now);
  }

  const persisted = getPersistentByFingerprint(fingerprint, now);
  if (persisted) {
    store.set(persisted.key, {
      page: persisted.page,
      storedAt: now,
      hits: 1,
      fingerprint,
    });
    fingerprintIndex.set(fingerprint, persisted.key);
    return persisted.page;
  }

  return null;
}

export function listCachedFingerprints(): Array<{
  fingerprint: string;
  url: string;
  final_url: string;
  title?: string;
  status: number;
  stored_at: number;
}> {
  const items: Array<{
    fingerprint: string;
    url: string;
    final_url: string;
    title?: string;
    status: number;
    stored_at: number;
  }> = [];

  for (const entry of store.values()) {
    items.push({
      fingerprint: entry.fingerprint,
      url: entry.page.requested_url,
      final_url: entry.page.final_url,
      status: entry.page.status,
      stored_at: entry.storedAt,
    });
  }

  return items;
}

export function configureFetchCache(options: {
  ttlMs?: number;
  maxEntries?: number;
}): void {
  if (typeof options.ttlMs === "number" && options.ttlMs >= 0) {
    ttlMs = options.ttlMs;
  }

  if (typeof options.maxEntries === "number" && options.maxEntries > 0) {
    maxEntries = options.maxEntries;
  }
}

export function clearFetchCache(): void {
  store.clear();
  fingerprintIndex.clear();
  hits = 0;
  misses = 0;
  evictions = 0;
}

export function fetchCacheStats(): FetchCacheStats {
  return { size: store.size, hits, misses, evictions };
}
