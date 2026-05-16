import type { MemoryActor } from "./memory-actor";
import type { MemoryIntentKind } from "./memory-intent-policy";
import type { MemoryScope } from "./memory-scope-policy";
import type { MemorySource } from "./memory-source";

export type MemoryCandidateEnvelope = {
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly source: MemorySource;
  readonly actor: MemoryActor;
  readonly intent: MemoryIntentKind;
  readonly requestedScope: MemoryScope | null;
  readonly candidateBody: string;
  readonly candidateBodyHash: string;
  readonly redactedSourceExcerpt: string | null;
  readonly sourceTextHash: string | null;
  readonly extractionMethod:
    | "explicit_command"
    | "explicit_natural_language"
    | "model_suggested_candidate";
  readonly extractionVersion: number;
};
