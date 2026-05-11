import {
  createMemoryBodyHash,
  normalizeMemoryBody,
} from "../../domain/memory-body";
import type { MemoryCandidateEnvelope } from "../../domain/memory-candidate";
import { memoryActorRef } from "../../domain/memory-actor";
import { MemoryError } from "../../domain/memory-errors";
import { MemorySuggestion } from "../../domain/memory-suggestion";
import { evaluateMemorySafety } from "../../domain/memory-safety-policy";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import { rememberMemoryDirectly } from "./remember-memory-directly";
import type {
  MemoryMutationResult,
  MemoryUseCaseDependencies,
} from "./memory-use-case-types";

export type ProposeMemoryFromInteractionInput = {
  readonly envelope: MemoryCandidateEnvelope;
  readonly policyVersion?: number;
  readonly safetyPolicyVersion?: number;
};

export async function proposeMemoryFromInteraction(
  input: ProposeMemoryFromInteractionInput,
  dependencies: MemoryUseCaseDependencies,
): Promise<MemoryMutationResult> {
  const envelope = input.envelope;
  if (
    envelope.intent === "ambiguous_discussion" ||
    envelope.intent === "no_memory_intent"
  ) {
    return { status: "noop", reason: "no_memory_intent" };
  }

  const scope = envelope.requestedScope ?? defaultScopeForEnvelope(envelope);
  const body = normalizeMemoryBody(envelope.candidateBody);
  if (body.length === 0) {
    return { status: "rejected", reason: "memory_input_invalid" };
  }

  if (
    envelope.intent === "explicit_command" &&
    envelope.extractionMethod === "explicit_command"
  ) {
    const directInput = {
      workspaceId: envelope.workspaceId,
      repositoryId: scope === "repository" ? envelope.repositoryId : null,
      userId: scope === "user_prefs" ? envelope.userId : null,
      scope,
      body,
      source: envelope.source,
      actor: envelope.actor,
      idempotencyKey: proposalDedupeKey(envelope, scope),
    };
    return rememberMemoryDirectly(
      {
        ...directInput,
        ...(input.policyVersion === undefined
          ? {}
          : { policyVersion: input.policyVersion }),
        ...(input.safetyPolicyVersion === undefined
          ? {}
          : { safetyPolicyVersion: input.safetyPolicyVersion }),
      },
      dependencies,
    );
  }

  const safety = evaluateMemorySafety({
    body,
    scope,
    redactedSourceExcerpt: envelope.redactedSourceExcerpt,
  });
  const dedupeKey = proposalDedupeKey(envelope, scope);
  const existingSuggestion =
    await dependencies.memorySuggestions.findPendingByDedupeKey({
      workspaceId: envelope.workspaceId,
      dedupeKey,
    });
  if (existingSuggestion) {
    return {
      status: "noop",
      reason: "memory_duplicate",
      id: existingSuggestion.id,
    };
  }
  const duplicate = await dependencies.memoryItems.findActiveByBodyHash({
    workspaceId: envelope.workspaceId,
    scope,
    repositoryId: scope === "repository" ? envelope.repositoryId : null,
    userId: scope === "user_prefs" ? envelope.userId : null,
    bodyHash: createMemoryBodyHash(body),
  });
  if (duplicate) {
    return { status: "noop", reason: "memory_duplicate", id: duplicate.id };
  }

  const now = dependencies.clock.now();
  const suggestionInput = {
    id: dependencies.memoryIds.newId("mem_suggestion"),
    workspaceId: envelope.workspaceId,
    repositoryId: scope === "repository" ? envelope.repositoryId : null,
    userId: scope === "user_prefs" ? envelope.userId : null,
    suggestedScope: scope,
    suggestedBody: body,
    reason: reasonForIntent(envelope.intent),
    source: envelope.source,
    safetyReport: safety,
    policyVersion: input.policyVersion ?? 1,
    safetyPolicyVersion: input.safetyPolicyVersion ?? 1,
    actor: envelope.actor,
    expiresAt: new Date(now.getTime() + suggestionTtlMs(scope)),
    dedupeKey,
    now,
  };
  const suggestion =
    safety.severity === "blocked"
      ? MemorySuggestion.createBlocked(suggestionInput)
      : MemorySuggestion.createPending(suggestionInput);
  const snapshot = suggestion.snapshot();

  try {
    return await dependencies.memoryTransaction.run(async (tx) => {
      await tx.memorySuggestions.save(suggestion);
      await tx.memoryAudit.record({
        workspaceId: envelope.workspaceId,
        actor: memoryActorRef(envelope.actor),
        action:
          snapshot.status === "blocked"
            ? "memory.suggestion.blocked"
            : "memory.suggestion.created",
        targetType: "memory_suggestion",
        targetId: snapshot.id,
        metadata: {
          scope: snapshot.suggestedScope,
          bodyHash: snapshot.suggestedBodyHash,
          sourceType: snapshot.source.type,
          safetySeverity: snapshot.safetyReport.severity,
        },
      });
      await tx.memoryOutbox.enqueue({
        type: "memory.suggestion.created",
        version: 1,
        idempotencyKey: `memory.suggestion.created:${snapshot.workspaceId}:${snapshot.id}:${snapshot.version}`,
        workspaceId: envelope.workspaceId,
        repositoryId: snapshot.repositoryId,
        aggregateId: snapshot.id,
        payload: {
          bodyHash: snapshot.suggestedBodyHash,
          scope: snapshot.suggestedScope,
          status: snapshot.status,
        },
        occurredAt: now,
      });
      return snapshot.status === "blocked"
        ? { status: "rejected", reason: snapshot.resolutionReason ?? "blocked" }
        : { status: "created", id: snapshot.id, version: snapshot.version };
    });
  } catch (error) {
    if (error instanceof MemoryError && error.code === "memory_duplicate") {
      return { status: "noop", reason: "memory_duplicate" };
    }
    throw error;
  }
}

function defaultScopeForEnvelope(
  envelope: MemoryCandidateEnvelope,
): MemoryScope {
  if (envelope.repositoryId) return "repository";
  if (envelope.userId && envelope.intent === "model_suggested_candidate") {
    return "user_prefs";
  }
  return "workspace";
}

function reasonForIntent(intent: MemoryCandidateEnvelope["intent"]): string {
  if (intent === "model_suggested_candidate")
    return "model_suggested_candidate";
  return "explicit_natural_language";
}

function suggestionTtlMs(scope: MemoryScope): number {
  const days = scope === "user_prefs" ? 30 : 14;
  return days * 24 * 60 * 60 * 1000;
}

function proposalDedupeKey(
  envelope: MemoryCandidateEnvelope,
  scope: MemoryScope,
): string {
  return [
    "memory.propose",
    envelope.workspaceId,
    envelope.repositoryId ?? "workspace",
    envelope.source.type,
    envelope.source.sourceId,
    scope,
    envelope.sourceTextHash ?? envelope.candidateBodyHash,
  ].join(":");
}
