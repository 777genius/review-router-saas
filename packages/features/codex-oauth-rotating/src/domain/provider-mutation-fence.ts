import { z } from "zod";

const githubRepositoryIdSchema = z.string().regex(/^[1-9][0-9]*$/);
export const codexRotatingProviderIdSchema = z
  .string()
  .regex(/^codex-rotating:[1-9][0-9]*$/);

/** The only provider discriminator accepted by rotating Codex OAuth. */
export function canonicalCodexRotatingProviderId(
  githubRepositoryId: string,
): `codex-rotating:${string}` {
  return `codex-rotating:${githubRepositoryIdSchema.parse(githubRepositoryId)}`;
}

export function assertCanonicalCodexRotatingProviderId(input: {
  readonly providerInstanceId: string;
  readonly githubRepositoryId: string;
}): asserts input is {
  readonly providerInstanceId: `codex-rotating:${string}`;
  readonly githubRepositoryId: string;
} {
  if (
    input.providerInstanceId !==
    canonicalCodexRotatingProviderId(input.githubRepositoryId)
  ) {
    throw new Error("codex_rotating_provider_identity_mismatch");
  }
}

export const codexRotatingMutationOwnerValues = [
  "runtime",
  "setup",
  "recovery",
] as const;
export const codexRotatingMutationOwnerSchema = z.enum(
  codexRotatingMutationOwnerValues,
);
export type CodexRotatingMutationOwner = z.infer<
  typeof codexRotatingMutationOwnerSchema
>;

export type CodexRotatingMutationFence = {
  readonly epoch: bigint;
  readonly owner: CodexRotatingMutationOwner;
  readonly ownerId: string;
};

export type CodexRotatingMutationConfirmationOutcome =
  | { readonly status: "confirmed"; readonly generation: number }
  | { readonly status: "idempotent"; readonly generation: number }
  | {
      readonly status: "recovery_required";
      readonly reason: "stale_epoch" | "owner_mismatch" | "ambiguous_state";
    };

export const codexRotatingExternalMutationGraceMs = 15 * 60 * 1000;
export const codexRotatingWritebackClaimMarker =
  "runtime_write_claim_v1" as const;
export const codexRotatingWritebackDispatchedMarker =
  "runtime_write_dispatched_v1" as const;

export type CodexRotatingMutationOwnership =
  | { readonly classification: "clear" }
  | { readonly classification: "active"; readonly deadline: Date }
  | { readonly classification: "remote_outcome_unknown" }
  | { readonly classification: "ambiguous" }
  | { readonly classification: "recoverable"; readonly deadline?: Date };

/**
 * Shared, transport-free ownership policy for setup installers and runtime
 * writers. A database lock serializes decisions. Once an external secret PUT
 * may have been dispatched, elapsed time can never prove that a late,
 * unconditional GitHub PUT will not overwrite a replacement credential.
 */
export function classifyCodexRotatingMutationOwnership(input: {
  readonly owner: string | null;
  readonly ownerId: string | null;
  readonly now: Date;
  readonly setup?: {
    readonly id: string;
    readonly status: string;
    readonly expiresAt: Date;
    readonly lastFetchedAt: Date | null;
  } | null;
  readonly writeback?: {
    readonly id: string;
    readonly leaseId: string;
    readonly status: string;
    readonly claimedAt: Date;
    readonly claimMarker: boolean;
    readonly remoteNamespacePermanentlyRetired?: boolean;
  } | null;
  readonly runtimeLease?: {
    readonly id: string;
    readonly status: string;
    readonly expiresAt: Date;
  } | null;
  readonly graceMs?: number;
}): CodexRotatingMutationOwnership {
  if ((input.owner === null) !== (input.ownerId === null)) {
    return { classification: "ambiguous" };
  }
  if (input.owner === null) {
    return input.setup || input.writeback || input.runtimeLease
      ? { classification: "ambiguous" }
      : { classification: "clear" };
  }
  const graceMs = input.graceMs ?? codexRotatingExternalMutationGraceMs;
  if (input.owner === "recovery") {
    if (input.setup && input.writeback) {
      return { classification: "ambiguous" };
    }
    if (input.setup) {
      if (input.setup.status === "fetched") {
        return { classification: "remote_outcome_unknown" };
      }
      const deadline =
        input.setup.status === "issued" ? input.setup.expiresAt : null;
      if (!deadline) return { classification: "ambiguous" };
      return deadline > input.now
        ? { classification: "active", deadline }
        : { classification: "recoverable", deadline };
    }
    if (input.writeback) {
      if (input.writeback.status === "remote_outcome_unknown") {
        return input.writeback.remoteNamespacePermanentlyRetired === true
          ? { classification: "recoverable" }
          : { classification: "remote_outcome_unknown" };
      }
      if (
        !input.runtimeLease ||
        input.writeback.leaseId !== input.runtimeLease.id ||
        input.writeback.status !== "pending" ||
        !input.writeback.claimMarker
      ) {
        return { classification: "ambiguous" };
      }
      const deadline = new Date(
        Math.max(
          input.runtimeLease.expiresAt.getTime() + graceMs,
          input.writeback.claimedAt.getTime() + graceMs,
        ),
      );
      return deadline > input.now
        ? { classification: "active", deadline }
        : { classification: "recoverable", deadline };
    }
    return { classification: "recoverable" };
  }
  if (input.owner === "setup") {
    if (input.writeback) return { classification: "ambiguous" };
    if (!input.setup || input.setup.id !== input.ownerId) {
      return { classification: "ambiguous" };
    }
    if (input.setup.status === "issued") {
      return input.setup.expiresAt > input.now
        ? { classification: "active", deadline: input.setup.expiresAt }
        : { classification: "recoverable", deadline: input.setup.expiresAt };
    }
    if (input.setup.status === "fetched") {
      return { classification: "remote_outcome_unknown" };
    }
    return { classification: "ambiguous" };
  }
  if (input.owner === "runtime") {
    if (input.setup) return { classification: "ambiguous" };
    if (!input.runtimeLease || input.runtimeLease.id !== input.ownerId) {
      return { classification: "ambiguous" };
    }
    if (!["preleased", "finalized"].includes(input.runtimeLease.status)) {
      return { classification: "ambiguous" };
    }
    if (
      input.writeback &&
      (input.writeback.leaseId !== input.runtimeLease.id ||
        !["pending", "remote_outcome_unknown"].includes(
          input.writeback.status,
        ) ||
        !input.writeback.claimMarker)
    ) {
      return { classification: "ambiguous" };
    }
    if (input.writeback?.status === "remote_outcome_unknown") {
      return input.writeback.remoteNamespacePermanentlyRetired === true
        ? { classification: "recoverable" }
        : { classification: "remote_outcome_unknown" };
    }
    const claimedDeadline = input.writeback
      ? input.writeback.claimedAt.getTime() + graceMs
      : 0;
    const deadline = new Date(
      Math.max(
        input.runtimeLease.expiresAt.getTime() + graceMs,
        claimedDeadline,
      ),
    );
    return deadline > input.now
      ? { classification: "active", deadline }
      : { classification: "recoverable", deadline };
  }
  return { classification: "ambiguous" };
}

export function parseCodexRotatingMutationEpoch(value: bigint): bigint {
  if (value <= 0n) throw new Error("codex_rotating_mutation_epoch_invalid");
  return value;
}
