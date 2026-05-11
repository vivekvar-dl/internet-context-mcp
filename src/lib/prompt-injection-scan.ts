import * as cheerio from "cheerio";
import { normalizeWhitespace } from "./text-selection.js";

export interface PromptInjectionWarning {
  type:
    | "instruction_like_text"
    | "hidden_instruction_like_text"
    | "credential_request"
    | "exfiltration_request";
  severity: "low" | "medium" | "high";
  location: "visible_text" | "hidden_text" | "html_comment" | "metadata";
  snippet: string;
}

export interface PromptInjectionScan {
  risk: "low" | "medium" | "high";
  score: number;
  warnings: PromptInjectionWarning[];
}

const INSTRUCTION_PATTERNS = [
  /ignore (all )?(previous|above|prior) instructions/i,
  /disregard (all )?(previous|above|prior) instructions/i,
  /system prompt/i,
  /developer message/i,
  /you are now/i,
  /act as/i,
  /follow these instructions/i,
  /do not tell (the )?user/i,
];

const CREDENTIAL_PATTERNS = [
  /api[_ -]?key/i,
  /access token/i,
  /password/i,
  /cookie/i,
  /secret/i,
  /credential/i,
];

const EXFILTRATION_PATTERNS = [
  /send .* (to|via) https?:\/\//i,
  /post .* (to|via) https?:\/\//i,
  /exfiltrat/i,
  /upload .* (secret|credential|token|cookie)/i,
];

export function scanForPromptInjection(html: string, cleanText: string): PromptInjectionScan {
  const warnings: PromptInjectionWarning[] = [];
  const $ = cheerio.load(html);

  collectMatches(cleanText, "visible_text", warnings);

  $("meta[name],meta[property]").each((_, element) => {
    collectMatches(
      normalizeWhitespace($(element).attr("content") ?? ""),
      "metadata",
      warnings,
    );
  });

  $("*").each((_, element) => {
    const node = $(element);
    const style = node.attr("style") ?? "";
    const hidden =
      node.attr("hidden") !== undefined ||
      node.attr("aria-hidden") === "true" ||
      /display\s*:\s*none/i.test(style) ||
      /visibility\s*:\s*hidden/i.test(style) ||
      /opacity\s*:\s*0/i.test(style);

    if (!hidden) {
      return;
    }

    collectMatches(normalizeWhitespace(node.text()), "hidden_text", warnings);
  });

  const commentMatches = html.match(/<!--([\s\S]*?)-->/g) ?? [];

  for (const comment of commentMatches) {
    collectMatches(comment.replace(/^<!--|-->$/g, ""), "html_comment", warnings);
  }

  const score = Math.min(
    1,
    warnings.reduce((sum, warning) => sum + severityWeight(warning.severity), 0),
  );

  return {
    risk: score >= 0.65 ? "high" : score >= 0.25 ? "medium" : "low",
    score: Number(score.toFixed(2)),
    warnings: warnings.slice(0, 20),
  };
}

function collectMatches(
  text: string,
  location: PromptInjectionWarning["location"],
  warnings: PromptInjectionWarning[],
): void {
  if (!text) {
    return;
  }

  for (const pattern of INSTRUCTION_PATTERNS) {
    if (pattern.test(text)) {
      warnings.push({
        type:
          location === "hidden_text" || location === "html_comment"
            ? "hidden_instruction_like_text"
            : "instruction_like_text",
        severity: location === "visible_text" ? "medium" : "high",
        location,
        snippet: snippetForPattern(text, pattern),
      });
    }
  }

  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      warnings.push({
        type: "credential_request",
        severity: "high",
        location,
        snippet: snippetForPattern(text, pattern),
      });
    }
  }

  for (const pattern of EXFILTRATION_PATTERNS) {
    if (pattern.test(text)) {
      warnings.push({
        type: "exfiltration_request",
        severity: "high",
        location,
        snippet: snippetForPattern(text, pattern),
      });
    }
  }
}

function snippetForPattern(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  const index = match?.index ?? 0;
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + 180);

  return normalizeWhitespace(text.slice(start, end));
}

function severityWeight(severity: PromptInjectionWarning["severity"]): number {
  if (severity === "high") {
    return 0.4;
  }

  if (severity === "medium") {
    return 0.2;
  }

  return 0.08;
}
