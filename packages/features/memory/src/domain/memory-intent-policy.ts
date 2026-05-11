import { normalizeMemoryBody } from "./memory-body";
import type { MemoryScope } from "./memory-scope-policy";

export type MemoryIntentKind =
  | "explicit_command"
  | "explicit_natural_language"
  | "model_suggested_candidate"
  | "ambiguous_discussion"
  | "no_memory_intent";

export type MemoryParsedIntent = {
  readonly kind: MemoryIntentKind;
  readonly requestedScope: MemoryScope | null;
  readonly candidateBody: string | null;
};

const commandPattern =
  /^\/rr\s+remember\s+(repo|repository|workspace|user|prefs|user_prefs)\s+(.+)$/is;
const naturalLanguagePatterns: readonly RegExp[] = [
  /^(?:запомни|сохрани)\s+(?:для\s+проекта|для\s+репозитория|для\s+repo)\s*:?\s*(.+)$/is,
  /^(?:запомни|сохрани)\s+(?:для\s+команды|для\s+workspace)\s*:?\s*(.+)$/is,
  /^(?:remember|save)\s+(?:for\s+this\s+repo|for\s+this\s+repository)\s*:?\s*(.+)$/is,
  /^(?:remember|save)\s+(?:as\s+workspace\s+memory|for\s+this\s+team)\s*:?\s*(.+)$/is,
  /^(?:remember|save)\s+(?:as\s+user\s+preference|as\s+my\s+preference)\s*:?\s*(.+)$/is,
];
const ambiguousReferencePattern =
  /\b(?:это|выше|наш\s+разговор|обсуждение|this|that|above|our\s+discussion|the\s+thread)\b/i;

export function parseMemoryIntent(text: string): MemoryParsedIntent {
  const trimmed = text.trim();
  const command = commandPattern.exec(trimmed);
  if (command) {
    return {
      kind: "explicit_command",
      requestedScope: scopeFromCommand(command[1] ?? ""),
      candidateBody: normalizeMemoryBody(command[2] ?? ""),
    };
  }

  for (const pattern of naturalLanguagePatterns) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    return {
      kind: "explicit_natural_language",
      requestedScope: scopeFromNaturalLanguagePattern(pattern),
      candidateBody: normalizeMemoryBody(match[1] ?? ""),
    };
  }

  if (
    /\b(?:запомни|сохрани|remember|save)\b/i.test(trimmed) &&
    ambiguousReferencePattern.test(trimmed)
  ) {
    return {
      kind: "ambiguous_discussion",
      requestedScope: null,
      candidateBody: null,
    };
  }

  return {
    kind: "no_memory_intent",
    requestedScope: null,
    candidateBody: null,
  };
}

function scopeFromCommand(value: string): MemoryScope {
  if (value === "workspace") return "workspace";
  if (value === "user" || value === "prefs" || value === "user_prefs") {
    return "user_prefs";
  }
  return "repository";
}

function scopeFromNaturalLanguagePattern(pattern: RegExp): MemoryScope {
  const source = pattern.source;
  if (source.includes("workspace") || source.includes("команды")) {
    return "workspace";
  }
  if (source.includes("preference")) {
    return "user_prefs";
  }
  return "repository";
}
