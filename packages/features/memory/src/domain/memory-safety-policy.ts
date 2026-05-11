import {
  looksLikeCodeOrDiff,
  looksLikeSecretValue,
} from "@reviewrouter/shared";
import {
  memoryBodyMaxCharacters,
  normalizeMemoryBody,
  truncateRedactedExcerpt,
} from "./memory-body";
import type { MemoryScope } from "./memory-scope-policy";
import { isSafeUserPreferenceBody } from "./memory-scope-policy";

export type MemoryRiskLevel = "low" | "medium" | "high" | "critical";

export type MemorySafetySeverity = "safe" | "needs_review" | "blocked";

export type MemorySafetyFlag =
  | "contains_secret_like_text"
  | "contains_code_block"
  | "contains_diff_hunk"
  | "contains_large_stacktrace"
  | "contains_prompt_injection"
  | "contains_personal_data"
  | "contains_repo_specific_fact"
  | "too_long"
  | "unsafe_for_user_prefs"
  | "unsafe_for_runtime_bundle"
  | "ambiguous_intent"
  | "low_confidence_extraction";

export type MemorySafetyReport = {
  readonly severity: MemorySafetySeverity;
  readonly riskLevel: MemoryRiskLevel;
  readonly flags: readonly MemorySafetyFlag[];
  readonly blockedReason: string | null;
  readonly redactedBody: string;
  readonly redactedSourceExcerpt: string | null;
  readonly mayEmbed: boolean;
  readonly mayUseInRuntimeBundle: boolean;
};

export type MemorySafetyInput = {
  readonly body: string;
  readonly scope: MemoryScope;
  readonly redactedSourceExcerpt?: string | null;
};

const promptInjectionPattern =
  /\b(ignore|disregard|override)\s+(all\s+)?(previous|prior|system|developer)\s+(instructions|rules|messages)|\b(jailbreak|system prompt|developer message)\b/i;
const stackTracePattern =
  /\b(?:at\s+\S+\s+\(|Traceback \(most recent call last\)|Exception in thread|Caused by:)\b/;
const personalDataPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

export function evaluateMemorySafety(
  input: MemorySafetyInput,
): MemorySafetyReport {
  const body = normalizeMemoryBody(input.body);
  const flags = new Set<MemorySafetyFlag>();

  if (body.length === 0) {
    flags.add("ambiguous_intent");
  }
  if (body.length > memoryBodyMaxCharacters) {
    flags.add("too_long");
  }
  if (looksLikeSecretValue(body)) {
    flags.add("contains_secret_like_text");
  }
  if (/```/.test(input.body) || looksLikeCodeOrDiff(input.body)) {
    flags.add("contains_code_block");
  }
  if (/diff --git|@@\s+-\d+|^\+\+\+\s|^---\s/m.test(input.body)) {
    flags.add("contains_diff_hunk");
  }
  if (stackTracePattern.test(input.body)) {
    flags.add("contains_large_stacktrace");
  }
  if (promptInjectionPattern.test(body)) {
    flags.add("contains_prompt_injection");
  }
  if (personalDataPattern.test(body)) {
    flags.add("contains_personal_data");
  }
  if (input.scope === "user_prefs" && !isSafeUserPreferenceBody(body)) {
    flags.add("unsafe_for_user_prefs");
    flags.add("contains_repo_specific_fact");
  }

  const blockedReason = firstBlockingReason(flags);
  const severity: MemorySafetySeverity =
    blockedReason !== null
      ? "blocked"
      : flags.has("contains_personal_data")
        ? "needs_review"
        : "safe";

  return {
    severity,
    riskLevel: riskLevelForFlags(flags, severity),
    flags: [...flags].sort(),
    blockedReason,
    redactedBody: blockedReason ? "" : body,
    redactedSourceExcerpt: truncateRedactedExcerpt(
      input.redactedSourceExcerpt ?? null,
    ),
    mayEmbed: severity === "safe",
    mayUseInRuntimeBundle: severity === "safe",
  };
}

function firstBlockingReason(
  flags: ReadonlySet<MemorySafetyFlag>,
): string | null {
  const blocking: readonly MemorySafetyFlag[] = [
    "ambiguous_intent",
    "too_long",
    "contains_secret_like_text",
    "contains_code_block",
    "contains_diff_hunk",
    "contains_large_stacktrace",
    "contains_prompt_injection",
    "unsafe_for_user_prefs",
  ];
  for (const flag of blocking) {
    if (flags.has(flag)) return flag;
  }
  return null;
}

function riskLevelForFlags(
  flags: ReadonlySet<MemorySafetyFlag>,
  severity: MemorySafetySeverity,
): MemoryRiskLevel {
  if (severity === "blocked") return "critical";
  if (flags.has("contains_personal_data")) return "medium";
  return "low";
}
