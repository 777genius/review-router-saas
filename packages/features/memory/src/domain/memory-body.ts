import { createHash } from "node:crypto";

export const memoryBodyMaxCharacters = 1_000;
export const memoryRedactedExcerptMaxCharacters = 500;

export function normalizeMemoryBody(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
}

export function createMemoryBodyHash(value: string): string {
  return createHash("sha256")
    .update(normalizeMemoryBody(value), "utf8")
    .digest("hex");
}

export function truncateRedactedExcerpt(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeMemoryBody(value);
  if (normalized.length <= memoryRedactedExcerptMaxCharacters) {
    return normalized;
  }
  return normalized.slice(0, memoryRedactedExcerptMaxCharacters);
}
