import type {
  HostedAccountId,
  InvocationGrantId,
  InvocationId,
  RelayRequestId,
  RepositoryId,
  WorkspaceId,
} from "../../domain/identifiers";
import {
  activateInvocationBackup,
  admitRelayRequest as admitRelayRequestTransition,
  classifyFailoverEligibility,
  issueInvocationGrant as issueInvocationGrantTransition,
  recordProviderRequestFailure,
  recordProviderResponseStarted as recordResponseStartedTransition,
  recordSuccessfulProviderResponse as recordSuccessTransition,
  type ArProviderFailureClassification,
  type InvocationGrant,
  type InvocationGrantAuthority,
  type InvocationGrantBudget,
  type ProviderEffectFence,
  type RelayAdmission,
} from "../../domain/invocation-grant";
import type { HostedAccountRepositoryPort } from "../ports/hosted-account-repository-port";
import type {
  HostedPoolBindingRepositoryPort,
  HostedPoolRepositoryPort,
} from "../ports/hosted-pool-repository-port";
import type { InvocationGrantRepositoryPort } from "../ports/invocation-grant-repository-port";
import type { InvocationGrantCapabilityPort } from "../ports/invocation-grant-capability-port";
import { z } from "zod";
import type {
  RelayRequestAdmissionPort,
  RelayRequestCompletionPort,
  RelayResponseStartedPort,
} from "../ports/relay-request-ledger-port";
import type { CommentTokenRefreshCapabilityPort } from "../ports/comment-token-refresh-capability-port";

export async function issueInvocationGrant(
  input: {
    readonly id: InvocationGrantId;
    readonly invocationId: InvocationId;
    readonly repositoryId: RepositoryId;
    readonly workspaceId: WorkspaceId;
    readonly budget: InvocationGrantBudget;
    readonly commentRefreshBudget: {
      readonly expiresAt: Date;
      readonly maxUses: number;
    };
    readonly authority: InvocationGrantAuthority;
    readonly runtimeAuthzEpoch: bigint;
    readonly now: Date;
  },
  dependencies: {
    readonly pools: HostedPoolRepositoryPort;
    readonly bindings: HostedPoolBindingRepositoryPort;
    readonly accounts: HostedAccountRepositoryPort;
    readonly grants: InvocationGrantRepositoryPort;
    readonly capabilities: InvocationGrantCapabilityPort;
    readonly commentRefreshCapabilities: CommentTokenRefreshCapabilityPort;
  },
): Promise<{
  readonly grant: InvocationGrant;
  readonly plaintextToken: string;
  readonly commentRefreshPlaintextToken: string;
}> {
  const existing = await dependencies.grants.findByInvocationId(
    input.invocationId,
  );
  if (existing) throw new Error("invocation_grant_already_issued");
  const binding = await dependencies.bindings.findByRepositoryId(
    input.repositoryId,
  );
  if (
    !binding ||
    binding.workspaceId !== input.workspaceId ||
    binding.status !== "active"
  ) {
    throw new Error("repository_not_bound_to_hosted_pool");
  }
  if (binding.revision !== input.authority.bindingRevision) {
    throw new Error("invocation_binding_revision_mismatch");
  }
  if (binding.bindingId !== input.authority.repositoryBindingId) {
    throw new Error("invocation_binding_identity_mismatch");
  }
  const pool = await dependencies.pools.findById(binding.poolId);
  if (
    !pool ||
    pool.workspaceId !== input.workspaceId ||
    pool.status !== "active"
  ) {
    throw new Error("hosted_pool_not_active");
  }
  const capability = await dependencies.capabilities.issue({
    grantId: input.id,
    invocationId: input.invocationId,
    repositoryBindingId: binding.bindingId,
    expiresAt: input.budget.expiresAt,
  });
  const plaintextToken = z
    .string()
    .trim()
    .min(16)
    .max(16_384)
    .parse(capability.plaintextToken);
  const capabilityTokenHash = z
    .string()
    .trim()
    .min(16)
    .max(512)
    .parse(capability.tokenHash);
  const commentRefreshExpiresAt = z
    .date()
    .parse(input.commentRefreshBudget.expiresAt);
  const commentRefreshMaxUses = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(input.commentRefreshBudget.maxUses);
  const commentRefreshCapability =
    await dependencies.commentRefreshCapabilities.issue({
      grantId: input.id,
      invocationId: input.invocationId,
      repositoryBindingId: binding.bindingId,
      expiresAt: commentRefreshExpiresAt,
      maxUses: commentRefreshMaxUses,
    });
  const commentRefreshPlaintextToken = z
    .string()
    .trim()
    .min(16)
    .max(16_384)
    .parse(commentRefreshCapability.plaintextToken);
  const commentRefreshTokenHash = z
    .string()
    .trim()
    .min(16)
    .max(512)
    .parse(commentRefreshCapability.tokenHash);
  const grant = issueInvocationGrantTransition({
    ...input,
    poolId: pool.id,
    accounts: await dependencies.accounts.listByPoolId(pool.id),
    capabilityTokenHash,
    commentTokenRefreshCapability: {
      tokenHash: commentRefreshTokenHash,
      grantId: input.id,
      invocationId: input.invocationId,
      repositoryBindingId: binding.bindingId,
      expiresAt: commentRefreshExpiresAt,
      maxUses: commentRefreshMaxUses,
      useCount: 0,
      revokedAt: null,
    },
  });
  await dependencies.grants.insert(grant);
  return { grant, plaintextToken, commentRefreshPlaintextToken };
}

export async function admitRelayRequest(
  input: {
    readonly grantId: InvocationGrantId;
    readonly requestId: RelayRequestId;
    readonly authority: InvocationGrantAuthority;
    readonly ordinal: number;
    readonly idempotencyKeyHash: string;
    readonly requestBytes: number;
    readonly now: Date;
  },
  admissions: RelayRequestAdmissionPort,
): Promise<RelayAdmission> {
  const ordinal = z.number().int().positive().parse(input.ordinal);
  const idempotencyKeyHash = z
    .string()
    .trim()
    .min(16)
    .max(512)
    .parse(input.idempotencyKeyHash);
  return admissions.admit({
    grantId: input.grantId,
    requestId: input.requestId,
    ordinal,
    idempotencyKeyHash,
    requestBytes: input.requestBytes,
    now: input.now,
    transition: (current) =>
      admitRelayRequestTransition({
        grant: current,
        requestId: input.requestId,
        authority: input.authority,
        requestBytes: input.requestBytes,
        now: input.now,
      }),
  });
}

export function recordProviderResponseStarted(
  input: {
    readonly grantId: InvocationGrantId;
    readonly requestId: RelayRequestId;
    readonly startedAt: Date;
    readonly effect?: Parameters<
      RelayResponseStartedPort["markStarted"]
    >[0]["effect"];
  },
  responses: RelayResponseStartedPort,
): Promise<InvocationGrant> {
  return responses.markStarted({
    grantId: input.grantId,
    requestId: input.requestId,
    startedAt: input.startedAt,
    ...(input.effect ? { effect: input.effect } : {}),
    transition: (grant) =>
      recordResponseStartedTransition({ grant, requestId: input.requestId }),
  });
}

export async function recordSuccessfulProviderResponse(
  input: {
    readonly grantId: InvocationGrantId;
    readonly requestId: RelayRequestId;
    readonly responseBytes: number;
    readonly responseHash: string;
    readonly completedAt: Date;
    readonly effect?: Parameters<
      RelayRequestCompletionPort["complete"]
    >[0]["effect"];
  },
  completions: RelayRequestCompletionPort,
): Promise<InvocationGrant> {
  return completions.complete({
    grantId: input.grantId,
    requestId: input.requestId,
    responseBytes: z.number().int().min(0).parse(input.responseBytes),
    responseHash: z.string().trim().min(16).max(512).parse(input.responseHash),
    errorCode: null,
    completedAt: input.completedAt,
    ...(input.effect ? { effect: input.effect } : {}),
    transition: (grant) =>
      recordSuccessTransition({ grant, requestId: input.requestId }),
  });
}

export async function failoverInvocationBeforeFirstSuccess(
  input: {
    readonly grantId: InvocationGrantId;
    readonly requestId: RelayRequestId;
    readonly failure: ArProviderFailureClassification;
    readonly effectFence: ProviderEffectFence;
    readonly responseBytes: number;
    readonly responseHash: string | null;
    readonly errorCode: string;
    readonly completedAt: Date;
  },
  completions: RelayRequestCompletionPort,
): Promise<{
  readonly grant: InvocationGrant;
  readonly failedAccountId: HostedAccountId;
  readonly accountDisposition: "none" | "cooldown" | "quarantine";
}> {
  let failedAccountId: HostedAccountId | undefined;
  let accountDisposition: "none" | "cooldown" | "quarantine" = "none";
  const grant = await completions.complete({
    grantId: input.grantId,
    requestId: input.requestId,
    responseBytes: z.number().int().min(0).parse(input.responseBytes),
    responseHash:
      input.responseHash === null
        ? null
        : z.string().trim().min(16).max(512).parse(input.responseHash),
    errorCode: z.string().trim().min(1).max(160).parse(input.errorCode),
    completedAt: input.completedAt,
    transition: (current) => {
      failedAccountId = current.activeAccountId;
      const afterFailure = recordProviderRequestFailure({
        grant: current,
        requestId: input.requestId,
      });
      const eligibility = classifyFailoverEligibility({
        grant: afterFailure,
        failure: input.failure,
        effectFence: input.effectFence,
      });
      accountDisposition = eligibility.accountDisposition;
      return eligibility.eligible
        ? activateInvocationBackup({ grant: afterFailure, eligibility })
        : afterFailure;
    },
  });
  if (!failedAccountId) throw new Error("invocation_grant_mutation_failed");
  return { grant, failedAccountId, accountDisposition };
}
