import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FetchedPage } from "./fetch-page.js";

interface PersistentCacheStats {
  enabled: boolean;
  path: string | null;
  hits: number;
  writes: number;
  errors: number;
}

type SqliteDb = {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  exec(sql: string): void;
  close(): void;
};

let db: SqliteDb | null = null;
let initTried = false;
let disabled = false;
let dbPath: string | null = null;
let hits = 0;
let writes = 0;
let errors = 0;
const TABLE_NAME = "fetched_pages";

export function persistentCacheStats(): PersistentCacheStats {
  return { enabled: !!db, path: dbPath, hits, writes, errors };
}

export function configurePersistentCache(options: { disabled?: boolean }): void {
  if (typeof options.disabled === "boolean") {
    disabled = options.disabled;
  }
}

function getDb(): SqliteDb | null {
  if (disabled) {
    return null;
  }

  if (db || initTried) {
    return db;
  }

  initTried = true;

  try {
    // require is cheaper than dynamic ESM import for a native add-on,
    // and we want to fail fast and silently if the build is unusable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = createSqliteFactory();
    const cacheRoot =
      process.env.INTERNET_CONTEXT_MCP_CACHE_DIR ??
      join(homedir(), ".cache", "internet-context-mcp");
    mkdirSync(cacheRoot, { recursive: true });
    dbPath = join(cacheRoot, "cache.sqlite");
    db = new Database(dbPath) as SqliteDb;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        key TEXT PRIMARY KEY,
        requested_url TEXT NOT NULL,
        final_url TEXT NOT NULL,
        status INTEGER NOT NULL,
        content_type TEXT,
        body TEXT NOT NULL,
        truncated INTEGER NOT NULL,
        bytes_read INTEGER NOT NULL,
        max_bytes INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        stored_at INTEGER NOT NULL,
        ttl_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_fingerprint
        ON ${TABLE_NAME}(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_stored_at
        ON ${TABLE_NAME}(stored_at);`,
    );
  } catch (error) {
    db = null;
    errors += 1;
    process.stderr.write(
      `[internet-context-mcp] persistent cache disabled: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }

  return db;
}

function createSqliteFactory(): new (path: string) => SqliteDb {
  const req = createRequire(import.meta.url);
  return req("better-sqlite3") as unknown as new (path: string) => SqliteDb;
}

export function getPersistent(
  key: string,
  now = Date.now(),
): { page: FetchedPage; fingerprint: string } | null {
  const conn = getDb();
  if (!conn) {
    return null;
  }

  try {
    const row = conn
      .prepare(
        `SELECT requested_url, final_url, status, content_type, body, truncated, bytes_read, max_bytes, fingerprint, stored_at, ttl_ms FROM ${TABLE_NAME} WHERE key = ?`,
      )
      .get(key) as
      | {
          requested_url: string;
          final_url: string;
          status: number;
          content_type: string;
          body: string;
          truncated: number;
          bytes_read: number;
          max_bytes: number;
          fingerprint: string;
          stored_at: number;
          ttl_ms: number;
        }
      | undefined;

    if (!row) {
      return null;
    }

    if (now - row.stored_at > row.ttl_ms) {
      conn.prepare(`DELETE FROM ${TABLE_NAME} WHERE key = ?`).run(key);
      return null;
    }

    hits += 1;
    const page: FetchedPage = {
      requested_url: row.requested_url,
      final_url: row.final_url,
      status: row.status,
      content_type: row.content_type ?? "",
      body: row.body,
      truncated: !!row.truncated,
      timed_out: false,
      bytes_read: row.bytes_read,
      max_bytes: row.max_bytes,
    };
    return { page, fingerprint: row.fingerprint };
  } catch (error) {
    errors += 1;
    process.stderr.write(
      `[internet-context-mcp] persistent cache read error: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return null;
  }
}

export function setPersistent(
  key: string,
  page: FetchedPage,
  fingerprint: string,
  ttlMs: number,
  now = Date.now(),
): void {
  const conn = getDb();
  if (!conn) {
    return;
  }

  try {
    conn
      .prepare(
        `INSERT OR REPLACE INTO ${TABLE_NAME}
          (key, requested_url, final_url, status, content_type, body, truncated, bytes_read, max_bytes, fingerprint, stored_at, ttl_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        page.requested_url,
        page.final_url,
        page.status,
        page.content_type,
        page.body,
        page.truncated ? 1 : 0,
        page.bytes_read,
        page.max_bytes,
        fingerprint,
        now,
        ttlMs,
      );
    writes += 1;
  } catch (error) {
    errors += 1;
    process.stderr.write(
      `[internet-context-mcp] persistent cache write error: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

export function getPersistentByFingerprint(
  fingerprint: string,
  now = Date.now(),
): { page: FetchedPage; key: string } | null {
  const conn = getDb();
  if (!conn) {
    return null;
  }

  try {
    const row = conn
      .prepare(
        `SELECT key, requested_url, final_url, status, content_type, body, truncated, bytes_read, max_bytes, stored_at, ttl_ms FROM ${TABLE_NAME} WHERE fingerprint = ? ORDER BY stored_at DESC LIMIT 1`,
      )
      .get(fingerprint) as
      | {
          key: string;
          requested_url: string;
          final_url: string;
          status: number;
          content_type: string;
          body: string;
          truncated: number;
          bytes_read: number;
          max_bytes: number;
          stored_at: number;
          ttl_ms: number;
        }
      | undefined;

    if (!row) {
      return null;
    }
    if (now - row.stored_at > row.ttl_ms) {
      return null;
    }

    return {
      key: row.key,
      page: {
        requested_url: row.requested_url,
        final_url: row.final_url,
        status: row.status,
        content_type: row.content_type ?? "",
        body: row.body,
        truncated: !!row.truncated,
        timed_out: false,
        bytes_read: row.bytes_read,
        max_bytes: row.max_bytes,
      },
    };
  } catch (error) {
    errors += 1;
    return null;
  }
}
