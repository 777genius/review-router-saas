import {
  createMemoryBodyHash,
  normalizeMemoryBody,
} from "../../domain/memory-body";
import {
  parseMemoryIntent,
  type MemoryIntentKind,
} from "../../domain/memory-intent-policy";
import type { MemoryScope } from "../../domain/memory-scope-policy";

export const memoryInteractionCommandMaxCount = 5;
export const memoryInteractionRawCommandMaxCharacters = 2_000;

export type MemoryInteractionInstruction =
  | {
      readonly kind: "candidate";
      readonly intent: Extract<
        MemoryIntentKind,
        "explicit_command" | "explicit_natural_language"
      >;
      readonly requestedScope: MemoryScope;
      readonly candidateBody: string;
      readonly candidateBodyHash: string;
      readonly extractionMethod: Extract<
        MemoryIntentKind,
        "explicit_command" | "explicit_natural_language"
      >;
      readonly rawCommand: string | null;
    }
  | {
      readonly kind: "confirm_suggestion";
      readonly suggestionId: string;
      readonly rawCommand: string;
    }
  | {
      readonly kind: "reject_suggestion";
      readonly suggestionId: string;
      readonly reason: string | null;
      readonly rawCommand: string;
    }
  | {
      readonly kind: "forget_memory";
      readonly memoryItemId: string;
      readonly rawCommand: string;
    }
  | {
      readonly kind: "disable_memory";
      readonly memoryItemId: string;
      readonly rawCommand: string;
    }
  | {
      readonly kind: "list_memory";
      readonly view: "active" | "pending";
      readonly rawCommand: string;
    }
  | {
      readonly kind: "invalid";
      readonly reason:
        | "empty_command"
        | "empty_memory_body"
        | "memory_body_too_long"
        | "unsupported_command"
        | "unsupported_scope"
        | "unsafe_scope_alias"
        | "invalid_suggestion_id"
        | "invalid_memory_item_id"
        | "too_many_commands";
      readonly rawCommand: string;
    }
  | {
      readonly kind: "ignored";
      readonly reason: "ambiguous_discussion" | "no_memory_intent";
    };

export function parseMemoryInteractionInstructions(
  markdown: string,
): readonly MemoryInteractionInstruction[] {
  const topLevelText = stripIgnoredMarkdown(markdown);
  const commandLines = topLevelText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => isReviewRouterCommandLine(line));

  if (commandLines.length > 0) {
    return parseCommandLines(commandLines);
  }

  const intent = parseMemoryIntent(topLevelText);
  if (
    intent.kind === "explicit_natural_language" &&
    intent.requestedScope &&
    intent.candidateBody
  ) {
    return [
      candidateInstruction({
        intent: "explicit_natural_language",
        requestedScope: intent.requestedScope,
        candidateBody: intent.candidateBody,
        rawCommand: null,
      }),
    ];
  }
  if (intent.kind === "ambiguous_discussion") {
    return [{ kind: "ignored", reason: "ambiguous_discussion" }];
  }
  return [{ kind: "ignored", reason: "no_memory_intent" }];
}

export function stripIgnoredMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let inFence = false;
  let fenceMarker: "```" | "~~~" | null = null;
  let inHtmlComment = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inHtmlComment) {
      if (trimmed.includes("-->")) {
        inHtmlComment = false;
      }
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) {
        inHtmlComment = true;
      }
      continue;
    }
    const fence = markdownFenceMarker(trimmed);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence;
      } else if (fence === fenceMarker) {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }
    if (inFence) continue;
    if (trimmed.startsWith(">")) continue;
    if (isMarkdownTableLine(trimmed)) continue;
    kept.push(line);
  }

  return kept.join("\n").trim();
}

function parseCommandLines(
  commandLines: readonly string[],
): readonly MemoryInteractionInstruction[] {
  const limited = commandLines.slice(0, memoryInteractionCommandMaxCount);
  const instructions = limited.map(parseReviewRouterCommandLine);
  if (commandLines.length <= memoryInteractionCommandMaxCount) {
    return instructions;
  }
  return [
    ...instructions,
    {
      kind: "invalid",
      reason: "too_many_commands",
      rawCommand: commandLines[memoryInteractionCommandMaxCount] ?? "/rr",
    },
  ];
}

function parseReviewRouterCommandLine(
  rawCommand: string,
): MemoryInteractionInstruction {
  const match = /^\/rr(?:\s+(.+))?$/is.exec(rawCommand);
  const command = match?.[1]?.normalize("NFKC").trim() ?? "";
  if (!command) return invalidInstruction("empty_command", rawCommand);

  const remember = /^remember(?:\s+(.+))?$/is.exec(command);
  if (remember) {
    return parseRememberCommand(remember[1]?.trim() ?? "", rawCommand);
  }

  const reject = /^reject-memory\s+(\S+)(?:\s+(.+))?$/is.exec(command);
  if (reject) {
    const suggestionId = reject[1] ?? "";
    if (!isMemorySuggestionId(suggestionId)) {
      return invalidInstruction("invalid_suggestion_id", rawCommand);
    }
    return {
      kind: "reject_suggestion",
      suggestionId,
      reason: normalizeOptionalReason(reject[2] ?? null),
      rawCommand,
    };
  }

  const forget = /^(?:forget|forget-memory)\s+(\S+)$/is.exec(command);
  if (forget) {
    const memoryItemId = forget[1] ?? "";
    if (!isMemoryItemId(memoryItemId)) {
      return invalidInstruction("invalid_memory_item_id", rawCommand);
    }
    return { kind: "forget_memory", memoryItemId, rawCommand };
  }

  const disable = /^disable-memory\s+(\S+)$/is.exec(command);
  if (disable) {
    const memoryItemId = disable[1] ?? "";
    if (!isMemoryItemId(memoryItemId)) {
      return invalidInstruction("invalid_memory_item_id", rawCommand);
    }
    return { kind: "disable_memory", memoryItemId, rawCommand };
  }

  const list = /^memory(?:\s+(pending))?$/is.exec(command);
  if (list) {
    return {
      kind: "list_memory",
      view: list[1] ? "pending" : "active",
      rawCommand,
    };
  }

  return invalidInstruction("unsupported_command", rawCommand);
}

function parseRememberCommand(
  rest: string,
  rawCommand: string,
): MemoryInteractionInstruction {
  if (!rest) return invalidInstruction("empty_memory_body", rawCommand);
  if (isMemorySuggestionId(rest)) {
    return { kind: "confirm_suggestion", suggestionId: rest, rawCommand };
  }

  const [scopeToken, ...bodyParts] = rest.split(/\s+/);
  const requestedScope = scopeFromRememberToken(scopeToken ?? "");
  if (!requestedScope) {
    return invalidInstruction(
      isUnsafeScopeAlias(scopeToken ?? "")
        ? "unsafe_scope_alias"
        : "unsupported_scope",
      rawCommand,
    );
  }

  const candidateBody = normalizeMemoryBody(bodyParts.join(" "));
  if (!candidateBody) {
    return invalidInstruction("empty_memory_body", rawCommand);
  }
  if (candidateBody.length > memoryInteractionRawCommandMaxCharacters) {
    return invalidInstruction("memory_body_too_long", rawCommand);
  }

  return candidateInstruction({
    intent: "explicit_command",
    requestedScope,
    candidateBody,
    rawCommand,
  });
}

function candidateInstruction(input: {
  readonly intent: Extract<
    MemoryIntentKind,
    "explicit_command" | "explicit_natural_language"
  >;
  readonly requestedScope: MemoryScope;
  readonly candidateBody: string;
  readonly rawCommand: string | null;
}): MemoryInteractionInstruction {
  return {
    kind: "candidate",
    intent: input.intent,
    requestedScope: input.requestedScope,
    candidateBody: input.candidateBody,
    candidateBodyHash: createMemoryBodyHash(input.candidateBody),
    extractionMethod: input.intent,
    rawCommand: input.rawCommand,
  };
}

function invalidInstruction(
  reason: Extract<
    MemoryInteractionInstruction,
    { readonly kind: "invalid" }
  >["reason"],
  rawCommand: string,
): MemoryInteractionInstruction {
  return { kind: "invalid", reason, rawCommand };
}

function scopeFromRememberToken(token: string): MemoryScope | null {
  const normalized = token.toLowerCase();
  if (
    normalized === "repo" ||
    normalized === "repository" ||
    normalized === "project"
  ) {
    return "repository";
  }
  if (normalized === "workspace" || normalized === "team") {
    return "workspace";
  }
  if (
    normalized === "user" ||
    normalized === "prefs" ||
    normalized === "user_prefs"
  ) {
    return "user_prefs";
  }
  return null;
}

function isUnsafeScopeAlias(token: string): boolean {
  return /^(?:global|all-repos|all_repos|secret|secrets)$/i.test(token);
}

function isReviewRouterCommandLine(line: string): boolean {
  return /^\/rr(?:\s|$)/i.test(line);
}

function isMemorySuggestionId(value: string): boolean {
  return /^mem_suggestion_[A-Za-z0-9_-]+$/.test(value);
}

function isMemoryItemId(value: string): boolean {
  return /^mem_(?!suggestion_)[A-Za-z0-9_-]+$/.test(value);
}

function normalizeOptionalReason(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeMemoryBody(value);
  return normalized.length > 0 ? normalized.slice(0, 500) : null;
}

function markdownFenceMarker(line: string): "```" | "~~~" | null {
  if (line.startsWith("```")) return "```";
  if (line.startsWith("~~~")) return "~~~";
  return null;
}

function isMarkdownTableLine(line: string): boolean {
  if (!line.startsWith("|")) return false;
  return line.endsWith("|") || /\|\s*:?-{3,}:?\s*\|/.test(line);
}
