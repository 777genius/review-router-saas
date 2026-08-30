import { z } from "zod";
import type {
  HostedAccountId,
  HostedBindingId,
  HostedPoolId,
  InvocationGrantId,
  InvocationId,
  RelayRequestId,
  RepositoryId,
  WorkspaceId,
} from "./identifiers";
import {
  coolDownHostedAccount,
  isHostedAccountHealthy,
  quarantineHostedAccount,
  type HostedPoolAccount,
} from "./account-pool";

export type InvocationGrantBudget = {
  readonly expiresAt: Date;
  readonly maxRequests: number;
  readonly maxConcurrentRequests: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxOutputTokens: number;
};

export type InvocationGrantAuthority = {
  readonly repositoryBindingId: HostedBindingId;
  readonly reviewRequestId: string;
  readonly providerInvocationKey: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly model: string;
  readonly policyFingerprint: string;
  readonly runtimeConfigVersion: number;
  readonly bindingRevision: number;
  readonly authzEpoch: bigint;
};

export type CommentTokenRefreshCapability = {
  readonly tokenHash: string;
  readonly grantId: InvocationGrantId;
  readonly invocationId: InvocationId;
  readonly repositoryBindingId: HostedBindingId;
  readonly expiresAt: Date;
  readonly maxUses: number;
  readonly useCount: number;
  readonly revokedAt: Date | null;
};

export type InvocationGrant = {
  readonly id: InvocationGrantId;
  readonly invocationId: InvocationId;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly poolId: HostedPoolId;
  readonly repositoryBindingId: HostedBindingId;
  readonly primaryAccountId: HostedAccountId;
  readonly backupAccountId: HostedAccountId | null;
  readonly activeAccountId: HostedAccountId;
  readonly backupActivated: boolean;
  readonly failoverCount: number;
  readonly successfulProviderResponseRecorded: boolean;
  /** Hash only. The plaintext capability is never part of this aggregate. */
  readonly capabilityTokenHash: string;
  readonly commentTokenRefreshCapability: CommentTokenRefreshCapability;
  /** Immutable trust-domain binding copied into the signed relay grant. */
  readonly authority: InvocationGrantAuthority;
  readonly runtimeAuthzEpoch: bigint;
  readonly budget: InvocationGrantBudget;
  readonly admittedRequestIds: readonly RelayRequestId[];
  readonly inFlightRequestIds: readonly RelayRequestId[];
  readonly createdAt: Date;
};

export type RelayAdmission =
  | {
      readonly status: "admitted" | "already_admitted";
      readonly accountId: HostedAccountId;
      readonly grant: InvocationGrant;
    }
  | {
      readonly status:
        | "expired"
        | "request_budget_exhausted"
        | "concurrency_budget_exhausted"
        | "request_bytes_exceeded";
      readonly grant: InvocationGrant;
    };

export type ArProviderFailureClassification =
  | "transient_upstream"
  | "rate_limited"
  | "credential_refresh_failed"
  | "credential_invalid"
  | "needs_reconnect"
  | "account_policy_blocked"
  | "request_invalid"
  | "unknown";

export type ProviderEffectFence =
  | "before_refresh_or_upstream_effect"
  | "classified_response_before_success"
  | "refresh_outcome_unknown"
  | "upstream_effect_started";

export type FailoverEligibility = {
  readonly eligible: boolean;
  readonly reason:
    | "eligible"
    | "not_failover_class"
    | "backup_unavailable"
    | "already_failed_over"
    | "successful_response_fence";
  readonly accountDisposition: "none" | "cooldown" | "quarantine";
};

const budgetSchema = z
  .object({
    expiresAt: z.date(),
    maxRequests: z.number().int().min(1).max(10_000),
    maxConcurrentRequests: z.number().int().min(1).max(1_000),
    maxRequestBytes: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024),
    maxResponseBytes: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024),
    maxOutputTokens: z.number().int().min(1).max(100_000),
  })
  .strict();

const authoritySchema = z
  .object({
    repositoryBindingId: z.string().trim().min(1).max(160),
    reviewRequestId: z.string().trim().min(1).max(256),
    providerInvocationKey: z.string().trim().min(1).max(256),
    runId: z.string().trim().min(1).max(256),
    runAttempt: z.number().int().positive(),
    model: z.string().trim().min(1).max(256),
    policyFingerprint: z.string().trim().min(1).max(512),
    runtimeConfigVersion: z.number().int().positive(),
    bindingRevision: z.number().int().positive(),
    authzEpoch: z.bigint().positive(),
  })
  .strict();

export function issueInvocationGrant(input: {
  readonly id: InvocationGrantId;
  readonly invocationId: InvocationId;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly poolId: HostedPoolId;
  readonly accounts: readonly HostedPoolAccount[];
  readonly authority: InvocationGrantAuthority;
  readonly runtimeAuthzEpoch: bigint;
  readonly capabilityTokenHash: string;
  readonly commentTokenRefreshCapability: CommentTokenRefreshCapability;
  readonly budget: InvocationGrantBudget;
  readonly now: Date;
}): InvocationGrant {
  const budget = budgetSchema.parse(input.budget);
  const authority = authoritySchema.parse(
    input.authority,
  ) as InvocationGrantAuthority;
  const runtimeAuthzEpoch = z
    .bigint()
    .positive()
    .parse(input.runtimeAuthzEpoch);
  const capabilityTokenHash = z
    .string()
    .trim()
    .min(16)
    .max(512)
    .parse(input.capabilityTokenHash);
  const commentTokenRefreshCapability = parseCommentTokenRefreshCapability(
    input.commentTokenRefreshCapability,
  );
  if (
    commentTokenRefreshCapability.grantId !== input.id ||
    commentTokenRefreshCapability.invocationId !== input.invocationId ||
    commentTokenRefreshCapability.repositoryBindingId !==
      authority.repositoryBindingId
  ) {
    throw new Error("comment_refresh_capability_scope_mismatch");
  }
  if (commentTokenRefreshCapability.expiresAt > budget.expiresAt) {
    throw new Error("comment_refresh_capability_exceeds_grant_expiry");
  }
  if (commentTokenRefreshCapability.expiresAt <= input.now) {
    throw new Error("comment_refresh_capability_expired_on_issue");
  }
  if (budget.expiresAt <= input.now)
    throw new Error("invocation_grant_expired_on_issue");
  const eligible = input.accounts
    .filter(
      (account) =>
        account.poolId === input.poolId &&
        isHostedAccountHealthy(account, input.now),
    )
    .sort(compareAccounts);
  const primary = eligible[0];
  if (!primary) throw new Error("hosted_pool_has_no_healthy_account");
  const backup = eligible[1] ?? null;
  return {
    id: input.id,
    invocationId: input.invocationId,
    repositoryId: input.repositoryId,
    workspaceId: input.workspaceId,
    poolId: input.poolId,
    repositoryBindingId: authority.repositoryBindingId,
    primaryAccountId: primary.id,
    backupAccountId: backup?.id ?? null,
    activeAccountId: primary.id,
    backupActivated: false,
    failoverCount: 0,
    successfulProviderResponseRecorded: false,
    capabilityTokenHash,
    commentTokenRefreshCapability,
    authority,
    runtimeAuthzEpoch,
    budget,
    admittedRequestIds: [],
    inFlightRequestIds: [],
    createdAt: input.now,
  };
}

export function admitRelayRequest(input: {
  readonly grant: InvocationGrant;
  readonly requestId: RelayRequestId;
  readonly authority: InvocationGrantAuthority;
  readonly requestBytes: number;
  readonly now: Date;
}): RelayAdmission {
  const { grant, requestId } = input;
  assertInvocationGrantAuthorityMatches(grant.authority, input.authority);
  if (grant.admittedRequestIds.includes(requestId)) {
    return {
      status: "already_admitted",
      accountId: grant.activeAccountId,
      grant,
    };
  }
  if (input.now >= grant.budget.expiresAt) return { status: "expired", grant };
  const requestBytes = z.number().int().min(0).parse(input.requestBytes);
  if (requestBytes > grant.budget.maxRequestBytes) {
    return { status: "request_bytes_exceeded", grant };
  }
  if (grant.admittedRequestIds.length >= grant.budget.maxRequests) {
    return { status: "request_budget_exhausted", grant };
  }
  if (grant.inFlightRequestIds.length >= grant.budget.maxConcurrentRequests) {
    return { status: "concurrency_budget_exhausted", grant };
  }
  const next = {
    ...grant,
    admittedRequestIds: [...grant.admittedRequestIds, requestId],
    inFlightRequestIds: [...grant.inFlightRequestIds, requestId],
  };
  return { status: "admitted", accountId: grant.activeAccountId, grant: next };
}

export function assertInvocationGrantAuthorityMatches(
  expected: InvocationGrantAuthority,
  presented: InvocationGrantAuthority,
): void {
  const left = authoritySchema.parse(expected);
  const right = authoritySchema.parse(presented);
  if (
    left.reviewRequestId !== right.reviewRequestId ||
    left.repositoryBindingId !== right.repositoryBindingId ||
    left.providerInvocationKey !== right.providerInvocationKey ||
    left.runId !== right.runId ||
    left.runAttempt !== right.runAttempt ||
    left.model !== right.model ||
    left.policyFingerprint !== right.policyFingerprint ||
    left.runtimeConfigVersion !== right.runtimeConfigVersion ||
    left.bindingRevision !== right.bindingRevision ||
    left.authzEpoch !== right.authzEpoch
  ) {
    throw new Error("invocation_grant_authority_mismatch");
  }
}

export type CommentTokenRefreshConsumption =
  | {
      readonly status: "consumed" | "replayed";
      readonly grant: InvocationGrant;
    }
  | {
      readonly status: "expired" | "revoked" | "budget_exhausted";
      readonly grant: InvocationGrant;
    };

export function commentTokenRefreshCapabilityStatus(input: {
  readonly expiresAt: Date;
  readonly maxUses: number;
  readonly useCount: number;
  readonly revokedAt: Date | null;
  readonly now: Date;
}): "available" | "expired" | "revoked" | "budget_exhausted" {
  if (input.revokedAt !== null) return "revoked";
  if (input.now >= input.expiresAt) return "expired";
  if (input.useCount >= input.maxUses) return "budget_exhausted";
  return "available";
}

export function consumeCommentTokenRefreshCapability(input: {
  readonly grant: InvocationGrant;
  readonly now: Date;
}): CommentTokenRefreshConsumption {
  const capability = input.grant.commentTokenRefreshCapability;
  const status = commentTokenRefreshCapabilityStatus({
    ...capability,
    now: input.now,
  });
  if (status !== "available") return { status, grant: input.grant };
  return {
    status: "consumed",
    grant: {
      ...input.grant,
      commentTokenRefreshCapability: {
        ...capability,
        useCount: capability.useCount + 1,
      },
    },
  };
}

export function revokeCommentTokenRefreshCapability(input: {
  readonly grant: InvocationGrant;
  readonly revokedAt: Date;
}): InvocationGrant {
  if (input.grant.commentTokenRefreshCapability.revokedAt !== null) {
    return input.grant;
  }
  return {
    ...input.grant,
    commentTokenRefreshCapability: {
      ...input.grant.commentTokenRefreshCapability,
      revokedAt: input.revokedAt,
    },
  };
}

function parseCommentTokenRefreshCapability(
  capability: CommentTokenRefreshCapability,
): CommentTokenRefreshCapability {
  const parsed = z
    .object({
      tokenHash: z.string().trim().min(16).max(512),
      grantId: z.string().trim().min(1).max(160),
      invocationId: z.string().trim().min(1).max(160),
      repositoryBindingId: z.string().trim().min(1).max(160),
      expiresAt: z.date(),
      maxUses: z.number().int().min(1).max(100),
      useCount: z.number().int().min(0),
      revokedAt: z.date().nullable(),
    })
    .strict()
    .parse(capability);
  if (parsed.useCount > parsed.maxUses) {
    throw new Error("comment_refresh_capability_use_count_invalid");
  }
  return parsed as CommentTokenRefreshCapability;
}

export function recordSuccessfulProviderResponse(input: {
  readonly grant: InvocationGrant;
  readonly requestId: RelayRequestId;
}): InvocationGrant {
  assertInFlight(input.grant, input.requestId);
  return {
    ...input.grant,
    successfulProviderResponseRecorded: true,
    inFlightRequestIds: input.grant.inFlightRequestIds.filter(
      (id) => id !== input.requestId,
    ),
  };
}

export function recordProviderResponseStarted(input: {
  readonly grant: InvocationGrant;
  readonly requestId: RelayRequestId;
}): InvocationGrant {
  assertInFlight(input.grant, input.requestId);
  return {
    ...input.grant,
    successfulProviderResponseRecorded: true,
  };
}

export function recordProviderRequestFailure(input: {
  readonly grant: InvocationGrant;
  readonly requestId: RelayRequestId;
}): InvocationGrant {
  assertInFlight(input.grant, input.requestId);
  return {
    ...input.grant,
    inFlightRequestIds: input.grant.inFlightRequestIds.filter(
      (id) => id !== input.requestId,
    ),
  };
}

/** Consumes AR's classification; this bounded context never inspects provider errors. */
export function classifyFailoverEligibility(input: {
  readonly grant: InvocationGrant;
  readonly failure: ArProviderFailureClassification;
  readonly effectFence: ProviderEffectFence;
}): FailoverEligibility {
  if (input.grant.successfulProviderResponseRecorded) {
    return {
      eligible: false,
      reason: "successful_response_fence",
      accountDisposition: "none",
    };
  }
  if (input.grant.backupActivated) {
    return {
      eligible: false,
      reason: "already_failed_over",
      accountDisposition: "none",
    };
  }
  if (input.grant.backupAccountId === null) {
    return {
      eligible: false,
      reason: "backup_unavailable",
      accountDisposition: "none",
    };
  }
  if (
    input.effectFence !== "before_refresh_or_upstream_effect" &&
    input.effectFence !== "classified_response_before_success"
  ) {
    return {
      eligible: false,
      reason: "not_failover_class",
      accountDisposition:
        input.effectFence === "refresh_outcome_unknown" ? "quarantine" : "none",
    };
  }
  if (
    input.effectFence === "classified_response_before_success" &&
    input.failure !== "rate_limited" &&
    input.failure !== "credential_invalid"
  ) {
    return {
      eligible: false,
      reason: "not_failover_class",
      accountDisposition: "none",
    };
  }
  const disposition = failureDisposition(input.failure);
  if (disposition === "none") {
    return {
      eligible: false,
      reason: "not_failover_class",
      accountDisposition: "none",
    };
  }
  return {
    eligible: true,
    reason: "eligible",
    accountDisposition: disposition,
  };
}

export function activateInvocationBackup(input: {
  readonly grant: InvocationGrant;
  readonly eligibility: FailoverEligibility;
}): InvocationGrant {
  if (!input.eligibility.eligible || input.eligibility.reason !== "eligible") {
    throw new Error("invocation_backup_not_eligible");
  }
  if (
    input.grant.successfulProviderResponseRecorded ||
    input.grant.backupActivated ||
    input.grant.backupAccountId === null
  ) {
    throw new Error("invocation_backup_fence_conflict");
  }
  return {
    ...input.grant,
    activeAccountId: input.grant.backupAccountId,
    backupActivated: true,
    failoverCount: input.grant.failoverCount + 1,
  };
}

export type CurrentRelayRequestFailover =
  | {
      readonly status: "switched";
      readonly grant: InvocationGrant;
      readonly failedAccount: HostedPoolAccount;
      readonly disposition: "cooldown" | "quarantine";
    }
  | {
      readonly status: "denied";
      readonly reason:
        | FailoverEligibility["reason"]
        | "request_not_in_flight"
        | "backup_unhealthy"
        | "sibling_effect_recorded";
      readonly grant: InvocationGrant;
      readonly failedAccount: HostedPoolAccount;
    };

/**
 * Switches the sticky binding for the currently processing request. It never
 * completes/removes that request, so the same HTTP/SSE exchange can continue.
 */
export function failoverCurrentRelayRequest(input: {
  readonly grant: InvocationGrant;
  readonly requestId: RelayRequestId;
  readonly failedAccount: HostedPoolAccount;
  readonly backupAccount: HostedPoolAccount | null;
  readonly failure: ArProviderFailureClassification;
  readonly effectFence: ProviderEffectFence;
  readonly cooldownUntil: Date | null;
  readonly now: Date;
}): CurrentRelayRequestFailover {
  if (
    input.failedAccount.id !== input.grant.activeAccountId ||
    input.failedAccount.poolId !== input.grant.poolId
  ) {
    throw new Error("current_request_failed_account_mismatch");
  }
  if (!input.grant.inFlightRequestIds.includes(input.requestId)) {
    return {
      status: "denied",
      reason: "request_not_in_flight",
      grant: input.grant,
      failedAccount: input.failedAccount,
    };
  }
  const eligibility = classifyFailoverEligibility({
    grant: input.grant,
    failure: input.failure,
    effectFence: input.effectFence,
  });
  if (!eligibility.eligible) {
    return {
      status: "denied",
      reason: eligibility.reason,
      grant: input.grant,
      failedAccount: input.failedAccount,
    };
  }
  if (
    !input.backupAccount ||
    input.backupAccount.id !== input.grant.backupAccountId ||
    input.backupAccount.poolId !== input.grant.poolId ||
    !isHostedAccountHealthy(input.backupAccount, input.now)
  ) {
    return {
      status: "denied",
      reason: "backup_unhealthy",
      grant: input.grant,
      failedAccount: input.failedAccount,
    };
  }
  if (eligibility.accountDisposition === "none") {
    throw new Error("current_request_failover_disposition_missing");
  }
  const failedAccount =
    eligibility.accountDisposition === "quarantine"
      ? quarantineHostedAccount(input.failedAccount, input.failure, input.now)
      : coolDownHostedAccount(input.failedAccount, {
          reason: input.failure,
          now: input.now,
          until:
            input.cooldownUntil ??
            (() => {
              throw new Error("current_request_cooldown_until_required");
            })(),
        });
  return {
    status: "switched",
    grant: activateInvocationBackup({ grant: input.grant, eligibility }),
    failedAccount,
    disposition: eligibility.accountDisposition,
  };
}

function compareAccounts(
  left: HostedPoolAccount,
  right: HostedPoolAccount,
): number {
  return (
    left.priority - right.priority ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

function failureDisposition(
  failure: ArProviderFailureClassification,
): "none" | "cooldown" | "quarantine" {
  switch (failure) {
    case "rate_limited":
      return "cooldown";
    case "credential_invalid":
    case "needs_reconnect":
      return "quarantine";
    case "credential_refresh_failed":
    case "transient_upstream":
    case "account_policy_blocked":
    case "request_invalid":
    case "unknown":
      return "none";
  }
}

function assertInFlight(
  grant: InvocationGrant,
  requestId: RelayRequestId,
): void {
  if (!grant.inFlightRequestIds.includes(requestId)) {
    throw new Error("relay_request_not_in_flight");
  }
}
