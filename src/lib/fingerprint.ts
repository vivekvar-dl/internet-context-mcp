import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortFingerprint(input: string): string {
  return sha256Hex(input).slice(0, 16);
}
