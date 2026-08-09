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

export function parseCodexRotatingMutationEpoch(value: bigint): bigint {
  if (value <= 0n) throw new Error("codex_rotating_mutation_epoch_invalid");
  return value;
}
