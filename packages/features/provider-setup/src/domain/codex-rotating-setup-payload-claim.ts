import { z } from "zod";
import { versionedProviderSecretNamePattern } from "@reviewrouter/features-codex-oauth-rotating";

const opaqueId = z.string().regex(/^[A-Za-z0-9_.:-]{8,180}$/);
const digest = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const codexRotatingSetupDispatchAuthorityTtlMs = 10 * 60_000;

export function reserveCodexRotatingSetupDispatchAuthorityWindow(
  now: Date,
): Date {
  return new Date(now.getTime() + codexRotatingSetupDispatchAuthorityTtlMs);
}

/**
 * Continuation capability minted only by the setup writer. `crypto.randomUUID()`
 * fixes six UUID v4/variant bits and leaves 122 unpredictable bits. Repository,
 * provider, and setup-nonce identifiers deliberately do not match this shape.
 */
export const codexRotatingSetupClaimCapabilitySchema = z
  .string()
  .regex(
    /^codex_claim_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
  );

export const codexRotatingAccountIdentityAlgorithm =
  "provider_issuer_subject_account_v1" as const;

export const codexRotatingSetupClaimStatuses = [
  "prepared",
  "confirmed_candidate",
  "active",
  "superseded_predispatch",
  "retired_confirmed",
  "retired_active",
] as const;
export type CodexRotatingSetupClaimStatus =
  (typeof codexRotatingSetupClaimStatuses)[number];
export const codexRotatingSetupLiveClaimStatuses = [
  "prepared",
  "confirmed_candidate",
  "active",
] as const satisfies readonly CodexRotatingSetupClaimStatus[];
export type CodexRotatingSetupLiveClaimStatus =
  (typeof codexRotatingSetupLiveClaimStatuses)[number];
export const codexRotatingSetupReplayableClaimStatuses = [
  "prepared",
  "confirmed_candidate",
] as const satisfies readonly CodexRotatingSetupLiveClaimStatus[];
export type CodexRotatingSetupReplayableClaimStatus =
  (typeof codexRotatingSetupReplayableClaimStatuses)[number];
export const codexRotatingSetupTerminalClaimStatuses = [
  "superseded_predispatch",
  "retired_confirmed",
  "retired_active",
] as const satisfies readonly CodexRotatingSetupClaimStatus[];
export type CodexRotatingSetupTerminalClaimStatus =
  (typeof codexRotatingSetupTerminalClaimStatuses)[number];
export const codexRotatingSetupIdentityBearingClaimStatuses = [
  "confirmed_candidate",
  "active",
  "retired_confirmed",
  "retired_active",
] as const satisfies readonly CodexRotatingSetupClaimStatus[];
export type CodexRotatingSetupIdentityBearingClaimStatus =
  (typeof codexRotatingSetupIdentityBearingClaimStatuses)[number];

export const codexRotatingSetupAttemptStatuses = [
  "dispatch_authorized",
  "confirmed",
  "retired_ambiguous",
  "retired_confirmed",
] as const;
export type CodexRotatingSetupAttemptStatus =
  (typeof codexRotatingSetupAttemptStatuses)[number];
export type CodexRotatingDispatchAttempt = Readonly<{
  claimId: string;
  attemptId: string;
  namespaceId: string;
  namespaceEpoch: string;
  secretName: string;
  status: CodexRotatingSetupAttemptStatus;
  dispatchExpiresAt: string;
}>;
export type CodexRotatingSetupStatus = Readonly<{
  status: CodexRotatingSetupClaimStatus;
  claimId: string;
  databaseIncarnation: string;
  databaseRecoveryWitnessFingerprint: string;
  attempt: CodexRotatingDispatchAttempt | null;
}>;
export const codexRotatingSetupLiveAttemptStatuses = [
  "dispatch_authorized",
  "confirmed",
] as const satisfies readonly CodexRotatingSetupAttemptStatus[];
export type CodexRotatingSetupLiveAttemptStatus =
  (typeof codexRotatingSetupLiveAttemptStatuses)[number];
export const codexRotatingSetupTerminalAttemptStatuses = [
  "retired_ambiguous",
  "retired_confirmed",
] as const satisfies readonly CodexRotatingSetupAttemptStatus[];
export type CodexRotatingSetupTerminalAttemptStatus =
  (typeof codexRotatingSetupTerminalAttemptStatuses)[number];

export const codexRotatingForcedRecoveryClaimTransitions = {
  prepared: "superseded_predispatch",
  confirmed_candidate: "retired_confirmed",
  active: "retired_active",
} as const satisfies Record<
  CodexRotatingSetupLiveClaimStatus,
  CodexRotatingSetupTerminalClaimStatus
>;

export const codexRotatingForcedRecoveryAttemptTransitions = {
  dispatch_authorized: "retired_ambiguous",
  confirmed: "retired_confirmed",
} as const satisfies Record<
  CodexRotatingSetupLiveAttemptStatus,
  CodexRotatingSetupTerminalAttemptStatus
>;

export type CodexRotatingSetupRecoveryFence = Readonly<{
  providerInstanceId: string;
  recoveryRequestId: string;
  recoveryEpoch: bigint;
}>;

export function isCodexRotatingSetupLiveClaimStatus(
  status: CodexRotatingSetupClaimStatus,
): status is CodexRotatingSetupLiveClaimStatus {
  return (codexRotatingSetupLiveClaimStatuses as readonly string[]).includes(
    status,
  );
}

export function isCodexRotatingSetupTerminalClaimStatus(
  status: CodexRotatingSetupClaimStatus,
): status is CodexRotatingSetupTerminalClaimStatus {
  return (
    codexRotatingSetupTerminalClaimStatuses as readonly string[]
  ).includes(status);
}

export function isCodexRotatingSetupIdentityBearingClaimStatus(
  status: CodexRotatingSetupClaimStatus,
): status is CodexRotatingSetupIdentityBearingClaimStatus {
  return (
    codexRotatingSetupIdentityBearingClaimStatuses as readonly string[]
  ).includes(status);
}

export function isCodexRotatingSetupTerminalAttemptStatus(
  status: CodexRotatingSetupAttemptStatus,
): status is CodexRotatingSetupTerminalAttemptStatus {
  return (
    codexRotatingSetupTerminalAttemptStatuses as readonly string[]
  ).includes(status);
}

export function retireCodexRotatingSetupClaimStatus(
  status: CodexRotatingSetupClaimStatus,
): CodexRotatingSetupTerminalClaimStatus {
  return isCodexRotatingSetupTerminalClaimStatus(status)
    ? status
    : codexRotatingForcedRecoveryClaimTransitions[status];
}

export function retireCodexRotatingSetupAttemptStatus(
  status: CodexRotatingSetupAttemptStatus,
): CodexRotatingSetupTerminalAttemptStatus {
  return isCodexRotatingSetupTerminalAttemptStatus(status)
    ? status
    : codexRotatingForcedRecoveryAttemptTransitions[status];
}

export function codexRotatingSetupRecoveryFencesMatch(
  left: CodexRotatingSetupRecoveryFence | null,
  right: CodexRotatingSetupRecoveryFence,
): boolean {
  return (
    left?.providerInstanceId === right.providerInstanceId &&
    left.recoveryRequestId === right.recoveryRequestId &&
    left.recoveryEpoch === right.recoveryEpoch
  );
}

/** Exact, non-secret tuple admitted before any dispatch authorization exists. */
export const codexRotatingSetupPayloadClaimSchema = z
  .object({
    payloadVersion: z.literal(2),
    canonicalizationVersion: z.literal(1),
    operationId: opaqueId,
    repositoryId: z.string().regex(/^[0-9]+$/),
    providerInstanceId: opaqueId,
    setupNonce: opaqueId,
    manifestDigest: sha256,
    recoveryEpoch: z.string().regex(/^[0-9]+$/),
    generationHash: digest,
    accountIdentityHash: digest,
    accountIdentityAlgorithm: z.literal(codexRotatingAccountIdentityAlgorithm),
    authByteSize: z
      .number()
      .int()
      .positive()
      .max(32 * 1024),
    installerVersion: z.string().min(1).max(120),
    installerDigest: sha256,
  })
  .strict();

export type CodexRotatingSetupPayloadClaim = z.infer<
  typeof codexRotatingSetupPayloadClaimSchema
>;

export const codexRotatingDispatchRequestSchema = z
  .object({
    claimId: codexRotatingSetupClaimCapabilitySchema,
    idempotencyKey: opaqueId,
  })
  .strict();

export const codexRotatingDispatchOutcomeSchema = z
  .object({
    claimId: codexRotatingSetupClaimCapabilitySchema,
    attemptId: opaqueId,
    outcome: z.enum(["definite_success", "unknown"]),
    responseCode: z.union([z.literal(201), z.literal(204)]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.outcome === "definite_success") !==
      (value.responseCode === 201 || value.responseCode === 204)
    ) {
      context.addIssue({
        code: "custom",
        path: ["responseCode"],
        message: "definite success requires a 201 or 204 response",
      });
    }
  });

export const codexRotatingSetupStatusRequestSchema = z
  .object({ claimId: codexRotatingSetupClaimCapabilitySchema })
  .strict();

export const codexRotatingActivationSchema = z
  .object({
    claimId: opaqueId,
    attemptId: opaqueId,
    repositoryId: z.string().regex(/^[0-9]+$/),
    namespaceId: opaqueId,
    namespaceEpoch: z.string().regex(/^[0-9]+$/),
    secretName: z.string().regex(versionedProviderSecretNamePattern),
    workflowPath: z.literal(".github/workflows/reviewrouter-codex.yml"),
    workflowSourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
    workflowSourceBlobSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    workflowSourceSha256: sha256,
    workflowSemanticSha256: sha256,
    sourceTrust: z.literal("trusted_default_branch_revision"),
  })
  .strict();

export type CodexRotatingActivation = z.infer<
  typeof codexRotatingActivationSchema
>;

export function codexRotatingSetupPayloadClaimsMatch(
  left: CodexRotatingSetupPayloadClaim,
  right: CodexRotatingSetupPayloadClaim,
): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof CodexRotatingSetupPayloadClaim] ===
      right[key as keyof CodexRotatingSetupPayloadClaim],
  );
}

export function assertCodexRotatingRunNamespace(input: {
  readonly activeNamespaceId: string | null;
  readonly activeNamespaceEpoch: bigint | null;
  readonly presentedNamespaceId: string;
  readonly presentedNamespaceEpoch: bigint;
}): void {
  if (
    input.activeNamespaceId !== input.presentedNamespaceId ||
    input.activeNamespaceEpoch !== input.presentedNamespaceEpoch
  ) {
    throw new Error("codex_rotating_stale_secret_namespace");
  }
}

export function assertCodexRotatingAccountIdentityTransition(input: {
  readonly priorAccountIdentityHash: string | null;
  readonly nextAccountIdentityHash: string;
  readonly recoveryMode: string | null;
}): void {
  if (
    input.priorAccountIdentityHash !== null &&
    input.priorAccountIdentityHash !== input.nextAccountIdentityHash &&
    input.recoveryMode !== "forced_reseed_account_switch"
  ) {
    throw new Error("codex_rotating_account_switch_epoch_required");
  }
}
