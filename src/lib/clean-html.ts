import { Readability } from "@mozilla/readability";
import * as cheerio from "cheerio";
import { htmlToText } from "html-to-text";
import { JSDOM, VirtualConsole } from "jsdom";
import { normalizeWhitespace } from "./text-selection.js";

export interface CleanPage {
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  site_name: string | null;
  text: string;
  headings: string[];
  blocks: CleanBlock[];
  links: Array<{
    text: string;
    href: string;
  }>;
}

export interface CleanBlock {
  id: number;
  tag: string;
  text: string;
  dom_path: string;
  line_start: number | null;
  line_end: number | null;
  section: string | null;
  section_path: string[];
}

export function cleanPageContent(html: string, url: string): CleanPage {
  if (!looksLikeHtml(html)) {
    return {
      title: null,
      byline: null,
      excerpt: null,
      site_name: null,
      text: normalizeWhitespace(html),
      headings: [],
      blocks: [
        {
          id: 1,
          tag: "text",
          text: normalizeWhitespace(html),
          dom_path: "text",
          line_start: null,
          line_end: null,
          section: null,
          section_path: [],
        },
      ],
      links: [],
    };
  }

  const dom = new JSDOM(html, {
    url,
    includeNodeLocations: true,
    virtualConsole: new VirtualConsole(),
  });
  removeNoisyElements(dom.window.document);
  const blocks = extractBlocks(dom);
  const blockText = textFromBlocks(blocks);

  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  const contentHtml = article?.content ?? dom.window.document.body.innerHTML;
  const $ = cheerio.load(contentHtml);

  let text = normalizeWhitespace(
    htmlToText(contentHtml, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "script", format: "skip" },
        { selector: "style", format: "skip" },
        {
          selector: "a",
          options: {
            ignoreHref: true,
          },
        },
      ],
    }),
  );

  if (text.length < 80 && blockText.length > text.length + 40) {
    text = blockText;
  }

  return {
    title: article?.title?.trim() || extractTitle(html),
    byline: article?.byline?.trim() || null,
    excerpt: article?.excerpt?.trim() || null,
    site_name: article?.siteName?.trim() || null,
    text,
    headings: extractHeadings($),
    blocks,
    links: extractLinks($, url),
  };
}

function textFromBlocks(blocks: CleanBlock[]): string {
  return normalizeWhitespace(blocks.map((block) => block.text).join("\n\n"));
}

function looksLikeHtml(input: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(input);
}

function removeNoisyElements(document: Document): void {
  const selectors = [
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "iframe",
    "form",
    "nav",
    "footer",
    "[role='navigation']",
    "[aria-label*='cookie' i]",
    "[class*='cookie' i]",
    "[id*='cookie' i]",
    "[class*='newsletter' i]",
    "[class*='subscribe' i]",
    "[class*='advert' i]",
    "[id*='advert' i]",
  ];

  for (const element of document.querySelectorAll(selectors.join(","))) {
    element.remove();
  }
}

function extractTitle(html: string): string | null {
  const $ = cheerio.load(html);
  const title =
    $("meta[property='og:title']").attr("content") ??
    $("meta[name='twitter:title']").attr("content") ??
    $("title").text();

  return title.trim() || null;
}

function extractHeadings($: cheerio.CheerioAPI): string[] {
  const headings = $("h1,h2,h3")
    .map((_, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter(Boolean);

  return Array.from(new Set(headings)).slice(0, 24);
}

function extractBlocks(dom: JSDOM): CleanBlock[] {
  const document = dom.window.document;
  const root =
    document.querySelector("main") ??
    document.querySelector("article") ??
    document.querySelector("[role='main']") ??
    document.body;
  const selectors = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "pre",
    "blockquote",
    "figcaption",
    "summary",
  ];
  const blocks: CleanBlock[] = [];
  const sectionStack: Array<{ level: number; text: string }> = [];

  root.querySelectorAll(selectors.join(",")).forEach((element) => {
    const tag = element.tagName.toLowerCase();
    const text = normalizeWhitespace(element.textContent ?? "");

    if (!text || text.length < 2) {
      return;
    }

    const headingLevel = headingLevelForTag(tag);

    if (headingLevel !== null) {
      while (
        sectionStack.length > 0 &&
        sectionStack[sectionStack.length - 1].level >= headingLevel
      ) {
        sectionStack.pop();
      }

      sectionStack.push({
        level: headingLevel,
        text,
      });
    }

    const location = dom.nodeLocation(element);
    const sectionPath = sectionStack.map((section) => section.text);

    blocks.push({
      id: blocks.length + 1,
      tag,
      text,
      dom_path: domPathForElement(element),
      line_start: location?.startLine ?? null,
      line_end: location?.endLine ?? null,
      section: sectionPath.at(-1) ?? null,
      section_path: sectionPath,
    });
  });

  return blocks.slice(0, 500);
}

function headingLevelForTag(tag: string): number | null {
  const match = tag.match(/^h([1-6])$/);

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function domPathForElement(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current.tagName.toLowerCase() !== "html") {
    parts.unshift(elementSelector(current));
    current = current.parentElement;
  }

  return parts.join(" > ");
}

function elementSelector(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute("id");

  if (id) {
    return `${tag}#${safeCssIdentifier(id)}`;
  }

  const className = element.getAttribute("class");
  const classPart = className
    ? className
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((name) => `.${safeCssIdentifier(name)}`)
        .join("")
    : "";
  const index = nthOfType(element);

  return `${tag}${classPart}:nth-of-type(${index})`;
}

function nthOfType(element: Element): number {
  let index = 1;
  let sibling = element.previousElementSibling;
  const tag = element.tagName;

  while (sibling) {
    if (sibling.tagName === tag) {
      index += 1;
    }

    sibling = sibling.previousElementSibling;
  }

  return index;
}

function safeCssIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function extractLinks(
  $: cheerio.CheerioAPI,
  baseUrl: string,
): Array<{ text: string; href: string }> {
  const links = $("a[href]")
    .map((_, element) => {
      const href = $(element).attr("href");
      const text = normalizeWhitespace($(element).text());

      if (!href || !text) {
        return null;
      }

      try {
        return {
          text,
          href: new URL(href, baseUrl).toString(),
        };
      } catch {
        return null;
      }
    })
    .get()
    .filter((link): link is { text: string; href: string } => Boolean(link));

  return links.slice(0, 50);
}
