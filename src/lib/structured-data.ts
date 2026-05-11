import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { normalizeWhitespace } from "./text-selection.js";

export interface StructuredDataSummary {
  metadata: Record<string, string>;
  json_ld: unknown[];
  microdata: Array<{
    type: string | null;
    id: string | null;
    properties: Record<string, string[]>;
  }>;
}

export function extractStructuredData(
  html: string,
  baseUrl: string,
): StructuredDataSummary {
  const $ = cheerio.load(html);

  return {
    metadata: extractMetadata($),
    json_ld: extractJsonLd($),
    microdata: extractMicrodata($, baseUrl),
  };
}

function extractMetadata($: cheerio.CheerioAPI): Record<string, string> {
  const metadata: Record<string, string> = {};

  $("title,meta[name],meta[property]").each((_, element) => {
    const tagName = element.tagName.toLowerCase();

    if (tagName === "title") {
      const title = normalizeWhitespace($(element).text());

      if (title) {
        metadata.title = title;
      }

      return;
    }

    const key = $(element).attr("name") ?? $(element).attr("property");
    const value = $(element).attr("content");

    if (key && value) {
      metadata[key] = normalizeWhitespace(value);
    }
  });

  return metadata;
}

function extractJsonLd($: cheerio.CheerioAPI): unknown[] {
  const values: unknown[] = [];

  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).contents().text().trim();

    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;

      if (Array.isArray(parsed)) {
        values.push(...parsed.slice(0, 20));
      } else {
        values.push(parsed);
      }
    } catch {
      values.push({
        parse_error: true,
        text_preview: raw.slice(0, 240),
      });
    }
  });

  return values.slice(0, 20);
}

function extractMicrodata(
  $: cheerio.CheerioAPI,
  baseUrl: string,
): StructuredDataSummary["microdata"] {
  const items: StructuredDataSummary["microdata"] = [];

  $("[itemscope]").each((_, element) => {
    if (items.length >= 20) {
      return false;
    }

    const root = $(element);
    const properties: Record<string, string[]> = {};

    root.find("[itemprop]").each((__, propertyElement) => {
      const propertyName = $(propertyElement).attr("itemprop");

      if (!propertyName) {
        return;
      }

      const value = readItemPropValue($, propertyElement, baseUrl);

      if (!value) {
        return;
      }

      properties[propertyName] = properties[propertyName] ?? [];
      properties[propertyName].push(value);
    });

    items.push({
      type: root.attr("itemtype") ?? null,
      id: root.attr("itemid") ?? null,
      properties,
    });
  });

  return items;
}

function readItemPropValue(
  $: cheerio.CheerioAPI,
  element: Element,
  baseUrl: string,
): string | null {
  const node = $(element);
  const tagName = element.tagName.toLowerCase();
  const raw =
    node.attr("content") ??
    node.attr("datetime") ??
    node.attr("href") ??
    node.attr("src") ??
    node.text();

  if (!raw) {
    return null;
  }

  const normalized = normalizeWhitespace(raw);

  if (!normalized) {
    return null;
  }

  if ((tagName === "a" || tagName === "link") && node.attr("href")) {
    try {
      return new URL(normalized, baseUrl).toString();
    } catch {
      return normalized;
    }
  }

  return normalized;
}
