import type { FetchedPage } from "./fetch-page.js";

interface RenderOptions {
  timeoutMs: number;
  userAgent: string;
  maxBytes: number;
}

interface PlaywrightChromium {
  launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
}

interface PlaywrightBrowser {
  newContext(options: { userAgent: string }): Promise<PlaywrightBrowserContext>;
  close(): Promise<void>;
}

interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
}

interface PlaywrightResponse {
  status(): number;
  headerValue(name: string): Promise<string | null>;
}

interface PlaywrightPage {
  goto(
    url: string,
    options: { timeout: number; waitUntil: "domcontentloaded" },
  ): Promise<PlaywrightResponse | null>;
  waitForLoadState(state: "networkidle", options: { timeout: number }): Promise<void>;
  content(): Promise<string>;
  url(): string;
}

export async function renderWithBrowser(
  url: string,
  options: RenderOptions,
): Promise<FetchedPage> {
  let chromium: PlaywrightChromium;
  try {
    const mod = (await import(/* @vite-ignore */ "playwright" as string)) as {
      chromium: PlaywrightChromium;
    };
    chromium = mod.chromium;
  } catch {
    throw new Error(
      "render=browser requires the optional 'playwright' package. Install with: npm install playwright && npx playwright install chromium",
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: options.userAgent });
    const page = await context.newPage();
    const response = await page.goto(url, {
      timeout: options.timeoutMs,
      waitUntil: "domcontentloaded",
    });

    if (!response) {
      throw new Error(`Browser navigation returned no response for ${url}`);
    }

    await page
      .waitForLoadState("networkidle", { timeout: Math.min(options.timeoutMs, 8_000) })
      .catch(() => {
        /* tolerate sites that never idle */
      });

    const body = await page.content();
    const truncated = body.length > options.maxBytes;
    const finalBody = truncated ? body.slice(0, options.maxBytes) : body;
    const resolvedContentType =
      (await response.headerValue("content-type").catch(() => null)) ?? "text/html";

    return {
      requested_url: url,
      final_url: page.url(),
      status: response.status(),
      content_type: resolvedContentType,
      body: finalBody,
      truncated,
      timed_out: false,
      bytes_read: finalBody.length,
      max_bytes: options.maxBytes,
    };
  } finally {
    await browser.close().catch(() => {
      /* best-effort cleanup */
    });
  }
}
