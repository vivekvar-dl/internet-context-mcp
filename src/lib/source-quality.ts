export type SourceQuality =
  | "official"
  | "documentation"
  | "government"
  | "academic"
  | "research"
  | "news"
  | "forum"
  | "blog"
  | "marketplace"
  | "unknown";

export function classifySource(url: string, title = ""): SourceQuality {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const haystack = `${host} ${path} ${title.toLowerCase()}`;

  if (host.endsWith(".gov") || host.endsWith(".mil")) {
    return "government";
  }

  if (host.endsWith(".edu")) {
    return "academic";
  }

  if (
    host.includes("arxiv.org") ||
    host.includes("doi.org") ||
    host.includes("pubmed.ncbi.nlm.nih.gov") ||
    host.includes("semanticscholar.org")
  ) {
    return "research";
  }

  if (
    path.includes("/docs") ||
    path.includes("/documentation") ||
    path.includes("/api") ||
    haystack.includes("developer") ||
    haystack.includes("reference")
  ) {
    return "documentation";
  }

  if (
    host.includes("reddit.com") ||
    host.includes("stackoverflow.com") ||
    host.includes("stackexchange.com") ||
    host.includes("news.ycombinator.com") ||
    host.includes("community.")
  ) {
    return "forum";
  }

  if (
    host.includes("github.com") ||
    host.includes("npmjs.com") ||
    host.includes("pypi.org") ||
    host.includes("crates.io")
  ) {
    return "marketplace";
  }

  if (
    host.includes("reuters.com") ||
    host.includes("apnews.com") ||
    host.includes("bbc.") ||
    host.includes("nytimes.com") ||
    host.includes("theverge.com") ||
    host.includes("techcrunch.com")
  ) {
    return "news";
  }

  if (
    host.includes("medium.com") ||
    host.includes("substack.com") ||
    path.includes("/blog") ||
    path.includes("/posts")
  ) {
    return "blog";
  }

  if (isLikelyOfficialHomepage(parsed)) {
    return "official";
  }

  return "unknown";
}

function isLikelyOfficialHomepage(url: URL): boolean {
  const path = url.pathname.replace(/\/+$/, "");

  return path === "" || path === "/about" || path === "/docs";
}
