import {
  createMemoryBodyHash,
  truncateRedactedExcerpt,
} from "../../domain/memory-body";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type { MemorySource } from "../../domain/memory-source";
import {
  parseMemoryInteractionInstructions,
  stripIgnoredMarkdown,
  type MemoryInteractionInstruction,
} from "./memory-command-parser";

export type MemoryInteractionEventInput = {
  readonly eventName: string;
  readonly action: string;
  readonly repository: {
    readonly githubRepositoryId: string;
    readonly sourceVisibility?: MemorySource["sourceVisibility"];
  };
  readonly comment: {
    readonly id: string | number;
    readonly body: string;
    readonly htmlUrl?: string | null;
    readonly actorLogin?: string | null;
  };
  readonly issue?: {
    readonly number: number;
    readonly isPullRequest: boolean;
  } | null;
  readonly pullRequest?: {
    readonly number: number | null;
  } | null;
};

export type MemoryCandidateSubmissionPayload = {
  readonly protocolVersion: 1;
  readonly intent: "explicit_command" | "explicit_natural_language";
  readonly requestedScope: Extract<MemoryScope, "repository" | "workspace">;
  readonly candidateBody: string;
  readonly sourceTextHash: string;
  readonly extractionMethod: "explicit_command" | "explicit_natural_language";
  readonly extractionVersion: 1;
  readonly source: {
    readonly sourceId: string;
    readonly githubCommentId: string;
    readonly githubPullRequestNumber: number | null;
    readonly url: string | null;
    readonly redactedExcerpt: string | null;
    readonly sourceHash: string;
    readonly sourceVisibility: MemorySource["sourceVisibility"];
  };
};

export type MemoryInteractionEventNormalizationResult =
  | {
      readonly kind: "processed";
      readonly instructions: readonly MemoryInteractionInstruction[];
      readonly candidates: readonly MemoryCandidateSubmissionPayload[];
    }
  | {
      readonly kind: "ignored";
      readonly reason:
        | "unsupported_event"
        | "unsupported_action"
        | "deleted_comment"
        | "not_pull_request_comment";
    };

export function normalizeMemoryInteractionEvent(
  input: MemoryInteractionEventInput,
): MemoryInteractionEventNormalizationResult {
  if (
    input.eventName !== "issue_comment" &&
    input.eventName !== "pull_request_review_comment"
  ) {
    return { kind: "ignored", reason: "unsupported_event" };
  }
  if (input.action === "deleted") {
    return { kind: "ignored", reason: "deleted_comment" };
  }
  if (input.action !== "created" && input.action !== "edited") {
    return { kind: "ignored", reason: "unsupported_action" };
  }
  if (
    input.eventName === "issue_comment" &&
    input.issue?.isPullRequest !== true
  ) {
    return { kind: "ignored", reason: "not_pull_request_comment" };
  }

  const instructions = parseMemoryInteractionInstructions(input.comment.body);
  return {
    kind: "processed",
    instructions,
    candidates: instructions.flatMap((instruction) =>
      instruction.kind === "candidate"
        ? candidatePayloadFromInstruction(input, instruction)
        : [],
    ),
  };
}

function candidatePayloadFromInstruction(
  input: MemoryInteractionEventInput,
  instruction: Extract<
    MemoryInteractionInstruction,
    { readonly kind: "candidate" }
  >,
): readonly MemoryCandidateSubmissionPayload[] {
  if (instruction.requestedScope === "user_prefs") {
    return [];
  }

  const sourceTextHash = createMemoryBodyHash(
    stripIgnoredMarkdown(input.comment.body),
  );
  return [
    {
      protocolVersion: 1,
      intent: instruction.intent,
      requestedScope: instruction.requestedScope,
      candidateBody: instruction.candidateBody,
      sourceTextHash,
      extractionMethod: instruction.extractionMethod,
      extractionVersion: 1,
      source: {
        sourceId: `${input.eventName}:${input.comment.id}`,
        githubCommentId: String(input.comment.id),
        githubPullRequestNumber: pullRequestNumberForEvent(input),
        url: input.comment.htmlUrl ?? null,
        redactedExcerpt: truncateRedactedExcerpt(
          instruction.rawCommand ?? instruction.candidateBody,
        ),
        sourceHash: sourceTextHash,
        sourceVisibility: input.repository.sourceVisibility ?? "private",
      },
    },
  ];
}

function pullRequestNumberForEvent(
  input: MemoryInteractionEventInput,
): number | null {
  if (input.eventName === "issue_comment") {
    return input.issue?.number ?? null;
  }
  return input.pullRequest?.number ?? null;
}
