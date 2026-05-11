export interface FetchedPage {
  requested_url: string;
  final_url: string;
  status: number;
  content_type: string;
  body: string;
  truncated: boolean;
  timed_out: boolean;
  bytes_read: number;
  max_bytes: number;
}

export interface FetchPageOptions {
  timeoutMs?: number;
  userAgent?: string;
  maxBytes?: number;
  onMaxBytes?: "truncate" | "error";
  retries?: number;
  retryDelayMs?: number;
}

const DEFAULT_USER_AGENT =
  "internet-context-mcp/0.1 (+https://github.com/local/internet-context-mcp)";

export async function fetchPage(
  url: string,
  options: FetchPageOptions = {},
): Promise<FetchedPage> {
  const retries = options.retries ?? 0;
  const retryDelayMs = options.retryDelayMs ?? 750;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchPageOnce(url, options);
    } catch (error) {
      lastError = error;

      if (attempt >= retries || !isRetriableFetchError(error)) {
        throw error;
      }

      await delay(retryDelayMs * (attempt + 1));
    }
  }

  throw lastError;
}

async function fetchPageOnce(
  url: string,
  options: FetchPageOptions = {},
): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 5_000_000;
  const onMaxBytes = options.onMaxBytes ?? "truncate";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
        accept:
          "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.5",
      },
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body = await readBodyWithLimit(
      response,
      maxBytes,
      onMaxBytes,
      controller.signal,
    );

    if (!response.ok) {
      throw new Error(
        `Fetch failed for ${url}: HTTP ${response.status} ${response.statusText}`,
      );
    }

    return {
      requested_url: url,
      final_url: response.url,
      status: response.status,
      content_type: contentType,
      body: body.text,
      truncated: body.truncated,
      timed_out: body.timedOut,
      bytes_read: body.bytesRead,
      max_bytes: maxBytes,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isRetriableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "AbortError" ||
    /aborted/i.test(error.message) ||
    /fetch failed/i.test(error.message) ||
    /network/i.test(error.message) ||
    /terminated/i.test(error.message)
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  onMaxBytes: "truncate" | "error",
  signal: AbortSignal,
): Promise<{
  text: string;
  truncated: boolean;
  timedOut: boolean;
  bytesRead: number;
}> {
  if (!response.body) {
    const text = await response.text();

    if (text.length > maxBytes && onMaxBytes === "error") {
      throw new Error(`Response exceeded ${maxBytes} bytes`);
    }

    return {
      text: text.slice(0, maxBytes),
      truncated: text.length > maxBytes,
      timedOut: false,
      bytesRead: Math.min(text.length, maxBytes),
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    let readResult: ReadableStreamReadResult<Uint8Array>;

    try {
      readResult = await reader.read();
    } catch (error) {
      if (signal.aborted && received > 0 && onMaxBytes === "truncate") {
        return {
          text: decodeChunks(chunks, received),
          truncated: true,
          timedOut: true,
          bytesRead: received,
        };
      }

      throw error;
    }

    const { done, value } = readResult;

    if (done) {
      break;
    }

    if (received + value.byteLength > maxBytes) {
      if (onMaxBytes === "error") {
        throw new Error(`Response exceeded ${maxBytes} bytes`);
      }

      const remaining = Math.max(0, maxBytes - received);

      if (remaining > 0) {
        chunks.push(value.slice(0, remaining));
        received += remaining;
      }

      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors; the partial body is enough for callers.
      }

      return {
        text: decodeChunks(chunks, received),
        truncated: true,
        timedOut: false,
        bytesRead: received,
      };
    }

    received += value.byteLength;
    chunks.push(value);
  }

  return {
    text: decodeChunks(chunks, received),
    truncated: false,
    timedOut: false,
    bytesRead: received,
  };
}

function decodeChunks(chunks: Uint8Array[], received: number): string {
  const merged = new Uint8Array(received);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}
