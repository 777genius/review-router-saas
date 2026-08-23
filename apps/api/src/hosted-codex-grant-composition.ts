import { createHash, createHmac } from "node:crypto";
import {
  defaultActionOidcAudience,
  buildActionOidcReplayNonceKey,
  resolveActionOidcReplayNonceExpiresAt,
  validateOidcClaimsAgainstRepository,
  type ActionOidcReplayNonceStorePort,
  type GitHubActionsOidcClaims,
  type GitHubActionsOidcTokenVerifierPort,
  type GitHubAppCommentTokenIssuerPort,
  JoseGitHubActionsOidcTokenVerifier,
  PrismaActionOidcReplayNonceStore,
} from "@reviewrouter/features-action-control-plane";
import {
  hostedBindingId,
  invocationGrantId,
  invocationId,
  issueHostedPoolInvocationGrant,
  assertInvocationGrantAuthorityMatches,
  repositoryId,
  workspaceId,
  type HostedAccountRepositoryPort,
  type HostedCodexGrantIssuerPort,
  type CommentTokenRefreshCapabilityPort,
  type HostedPoolBindingRepositoryPort,
  type HostedPoolRepositoryPort,
  type InvocationGrantCapabilityPort,
  type InvocationGrantRepositoryPort,
  PrismaHostedAccountRepository,
  PrismaHostedPoolBindingRepository,
  PrismaHostedPoolRepository,
  PrismaInvocationGrantRepository,
} from "@reviewrouter/features-hosted-account-pool";
import {
  assertExactHostedPoolCallerWorkflow,
  type HostedPoolWorkflowSourceAttestation,
  hostedPoolWorkflowSchemaVersion,
} from "@reviewrouter/features-workflow-provisioning";
import { SystemClock, type Clock } from "@reviewrouter/shared";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  PrismaHostedCodexGrantAdmission,
  type HostedWorkflowSourceReaderPort,
} from "./prisma-hosted-codex-grant-admission.js";

export type HostedCodexGrantAdmission = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
  readonly githubInstallationId: string;
  readonly repository: string;
  readonly owner: string;
  readonly selected: boolean;
  readonly visibility: "private" | "internal";
  readonly installationStatus: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly authzEpoch: bigint;
  readonly workflowSchemaVersion: number;
  readonly workflowSource: string;
  readonly workflowJobSource: string;
  readonly workflowJobSha: string;
  readonly pullRequestNumber: number;
  readonly reviewHeadSha: string;
  readonly reviewRevisionHash: string;
  readonly workflowAttestation: HostedPoolWorkflowSourceAttestation;
  readonly workflowPath: string;
  readonly workflowSourceCommitSha: string;
  readonly workflowSourceBlobSha: string;
  readonly workflowContents: string;
  readonly reviewRequestId: string;
  readonly providerInvocationKey: string;
  readonly runtimeConfigVersion: number;
  readonly runtimeEnv: Readonly<Record<string, string>>;
  readonly model: string;
  readonly policyFingerprint: string;
};

/** Server-side read model; implementations must resolve every fact from current state. */
export interface HostedCodexGrantAdmissionPort {
  resolve(input: {
    readonly claims: GitHubActionsOidcClaims;
    readonly providerInstanceId: string;
    readonly workflowSchemaVersion: number;
    readonly bindingId: string;
    readonly bindingVersion: number;
    readonly now: Date;
  }): Promise<HostedCodexGrantAdmission>;
}

export type HostedCodexGrantPolicy = {
  readonly ttlMs: number;
  readonly maxRequests: number;
  readonly maxConcurrentRequests: number;
  readonly maxRequestBodyBytes: number;
  readonly maxCommentTokenRefreshes: number;
};

export class HostedCodexGrantIssuer implements HostedCodexGrantIssuerPort {
  constructor(
    private readonly dependencies: {
      readonly oidcVerifier: GitHubActionsOidcTokenVerifierPort;
      readonly replayNonces: ActionOidcReplayNonceStorePort;
      readonly admissions: HostedCodexGrantAdmissionPort;
      readonly pools: HostedPoolRepositoryPort;
      readonly bindings: HostedPoolBindingRepositoryPort;
      readonly accounts: HostedAccountRepositoryPort;
      readonly grants: InvocationGrantRepositoryPort;
      readonly grantCapabilities: InvocationGrantCapabilityPort;
      readonly refreshCapabilities: CommentTokenRefreshCapabilityPort;
      readonly commentTokens: GitHubAppCommentTokenIssuerPort;
      readonly clock: Clock;
      readonly relayUrl: string;
      readonly oidcAudience?: string;
      readonly policy: HostedCodexGrantPolicy;
    },
  ) {}

  async issue(input: Parameters<HostedCodexGrantIssuerPort["issue"]>[0]) {
    const now = this.dependencies.clock.now();
    const claims = await this.dependencies.oidcVerifier.verify({
      token: input.oidcToken,
      audience: this.dependencies.oidcAudience ?? defaultActionOidcAudience,
    });
    const runAttempt = parsePositiveInteger(
      claims.run_attempt,
      "hosted_run_attempt_invalid",
    );
    const admission = await this.dependencies.admissions.resolve({
      claims,
      providerInstanceId: input.providerInstanceId,
      workflowSchemaVersion: input.workflowSchemaVersion,
      bindingId: input.bindingId,
      bindingVersion: input.bindingVersion,
      now,
    });
    validateOidcClaimsAgainstRepository({
      claims,
      repository: {
        workspaceId: admission.workspaceId,
        repositoryId: admission.repositoryId,
        githubRepositoryId: admission.githubRepositoryId,
        githubInstallationId: admission.githubInstallationId,
        fullName: admission.repository,
        owner: admission.owner,
        selected: admission.selected,
        installationStatus: admission.installationStatus,
        trustedWorkflowRefs: [
          admission.workflowSource,
          admission.workflowJobSource,
        ],
      },
    });
    if (
      admission.visibility !== "private" &&
      admission.visibility !== "internal"
    ) {
      throw new Error("hosted_repository_visibility_ineligible");
    }
    assertExactClientBinding(input, admission);
    assertExactWorkflowClaims(claims, admission);
    assertExactHostedPoolCallerWorkflow({
      attestation: admission.workflowAttestation,
      repositoryId: admission.githubRepositoryId,
      workflowPath: admission.workflowPath,
      callerWorkflowSha: admission.workflowSourceCommitSha,
      admittedHeadSha: admission.reviewHeadSha,
      expectedBindingId: admission.bindingId,
      expectedBindingRevision: admission.bindingRevision,
      expectedWorkflow: admission.workflowContents,
      expectedWorkflowSourceBlobSha: admission.workflowSourceBlobSha,
    });
    await consumeReplayNonce(claims, now, this.dependencies.replayNonces);

    const expiresAt = new Date(now.getTime() + this.dependencies.policy.ttlMs);
    const invocationIdentity = sha256(
      canonical([
        admission.workspaceId,
        admission.repositoryId,
        claims.run_id,
        runAttempt,
        admission.bindingId,
        admission.bindingRevision,
      ]),
    );
    const grantId = invocationGrantId(`hosted-grant-${invocationIdentity}`);
    const authority = {
      repositoryBindingId: hostedBindingId(admission.bindingId),
      reviewRequestId: admission.reviewRequestId,
      providerInvocationKey: admission.providerInvocationKey,
      runId: claims.run_id,
      runAttempt,
      model: admission.model,
      policyFingerprint: admission.policyFingerprint,
      runtimeConfigVersion: admission.runtimeConfigVersion,
      bindingRevision: admission.bindingRevision,
      authzEpoch: admission.authzEpoch,
    };
    const commentToken =
      await this.dependencies.commentTokens.issueCommentToken({
        githubInstallationId: admission.githubInstallationId,
        githubRepositoryId: admission.githubRepositoryId,
        repositoryFullName: admission.repository,
      });
    const existing = await this.dependencies.grants.findByInvocationId(
      invocationId(invocationIdentity),
    );
    if (existing) {
      assertRetryMatches(existing, admission, authority, now);
      const [grantCapability, refreshCapability] = await Promise.all([
        this.dependencies.grantCapabilities.issue({
          grantId: existing.id,
          invocationId: existing.invocationId,
          repositoryBindingId: existing.repositoryBindingId,
          expiresAt: existing.budget.expiresAt,
        }),
        this.dependencies.refreshCapabilities.issue({
          grantId: existing.id,
          invocationId: existing.invocationId,
          repositoryBindingId: existing.repositoryBindingId,
          expiresAt: existing.commentTokenRefreshCapability.expiresAt,
          maxUses: existing.commentTokenRefreshCapability.maxUses,
        }),
      ]);
      if (
        grantCapability.tokenHash !== existing.capabilityTokenHash ||
        refreshCapability.tokenHash !==
          existing.commentTokenRefreshCapability.tokenHash
      ) {
        throw new Error("hosted_grant_retry_capability_key_mismatch");
      }
      return grantResponse({
        grant: grantCapability.plaintextToken,
        refreshCapability: refreshCapability.plaintextToken,
        grantId: existing.id,
        expiresAt: existing.budget.expiresAt,
        admission,
        commentToken,
        relayUrl: this.dependencies.relayUrl,
        policy: this.dependencies.policy,
      });
    }
    const issued = await issueHostedPoolInvocationGrant(
      {
        id: grantId,
        invocationId: invocationId(invocationIdentity),
        repositoryId: repositoryId(admission.repositoryId),
        workspaceId: workspaceId(admission.workspaceId),
        budget: {
          expiresAt,
          maxRequests: this.dependencies.policy.maxRequests,
          maxConcurrentRequests: this.dependencies.policy.maxConcurrentRequests,
          maxRequestBytes: this.dependencies.policy.maxRequestBodyBytes,
        },
        commentRefreshBudget: {
          expiresAt,
          maxUses: this.dependencies.policy.maxCommentTokenRefreshes,
        },
        authority,
        now,
      },
      {
        pools: this.dependencies.pools,
        bindings: this.dependencies.bindings,
        accounts: this.dependencies.accounts,
        grants: this.dependencies.grants,
        capabilities: this.dependencies.grantCapabilities,
        commentRefreshCapabilities: this.dependencies.refreshCapabilities,
      },
    );
    return grantResponse({
      grant: issued.plaintextToken,
      refreshCapability: issued.commentRefreshPlaintextToken,
      grantId,
      expiresAt,
      admission,
      commentToken,
      relayUrl: this.dependencies.relayUrl,
      policy: this.dependencies.policy,
    });
  }
}

function grantResponse(input: {
  readonly grant: string;
  readonly refreshCapability: string;
  readonly grantId: string;
  readonly expiresAt: Date;
  readonly admission: HostedCodexGrantAdmission;
  readonly commentToken: Awaited<
    ReturnType<GitHubAppCommentTokenIssuerPort["issueCommentToken"]>
  >;
  readonly relayUrl: string;
  readonly policy: HostedCodexGrantPolicy;
}) {
  return {
    protocolVersion: 1 as const,
    grant: input.grant,
    relayUrl: input.relayUrl,
    invocationLeaseId: input.grantId,
    runtimeConfigVersion: input.admission.runtimeConfigVersion,
    runtimeEnv: input.admission.runtimeEnv,
    repository: input.admission.repository,
    commentToken: input.commentToken.token,
    commentTokenRefreshCapability: input.refreshCapability,
    grantExpiresAt: input.expiresAt.toISOString(),
    commentTokenExpiresAt: input.commentToken.expiresAt.toISOString(),
    policy: {
      maxRequests: input.policy.maxRequests,
      maxRequestBodyBytes: input.policy.maxRequestBodyBytes,
    },
  };
}

function assertRetryMatches(
  existing: Awaited<
    ReturnType<InvocationGrantRepositoryPort["findByInvocationId"]>
  > & {},
  admission: HostedCodexGrantAdmission,
  authority: Parameters<typeof assertInvocationGrantAuthorityMatches>[1],
  now: Date,
): void {
  if (
    existing.repositoryId !== repositoryId(admission.repositoryId) ||
    existing.workspaceId !== workspaceId(admission.workspaceId) ||
    existing.repositoryBindingId !== hostedBindingId(admission.bindingId) ||
    existing.budget.expiresAt <= now
  ) {
    throw new Error("hosted_grant_retry_authority_mismatch");
  }
  assertInvocationGrantAuthorityMatches(existing.authority, authority);
}

export function createProductionHostedCodexGrantIssuer(input: {
  readonly prisma: PrismaClient;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly relayUrl: string;
  readonly workflowSources: HostedWorkflowSourceReaderPort;
  readonly commentTokens: GitHubAppCommentTokenIssuerPort;
  readonly clock?: Clock;
}): HostedCodexGrantIssuer {
  const clock = input.clock ?? new SystemClock();
  const grants = new PrismaInvocationGrantRepository(input.prisma);
  const capabilityKey = readCapabilityKey(input.env);
  const grantCapabilities = new HmacHostedCodexCapabilityIssuer(
    capabilityKey,
    "relay-grant-v1",
  );
  const refreshCapabilityIssuer = new HmacHostedCodexCapabilityIssuer(
    capabilityKey,
    "comment-refresh-v1",
  );
  return new HostedCodexGrantIssuer({
    oidcVerifier: new JoseGitHubActionsOidcTokenVerifier(),
    replayNonces: new PrismaActionOidcReplayNonceStore(input.prisma),
    admissions: new PrismaHostedCodexGrantAdmission(
      input.prisma,
      input.workflowSources,
      hostedPoolWorkflowSchemaVersion,
    ),
    pools: new PrismaHostedPoolRepository(input.prisma),
    bindings: new PrismaHostedPoolBindingRepository(input.prisma),
    accounts: new PrismaHostedAccountRepository(input.prisma),
    grants,
    grantCapabilities,
    refreshCapabilities: {
      issue: (scope) => refreshCapabilityIssuer.issue(scope),
      consume: (command) => grants.consume(command),
      revoke: (command) => grants.revoke(command),
    },
    commentTokens: input.commentTokens,
    clock,
    relayUrl: input.relayUrl,
    ...definedString(
      "oidcAudience",
      input.env.REVIEW_ROUTER_ACTION_OIDC_AUDIENCE,
    ),
    policy: {
      ttlMs:
        readBoundedInteger(
          input.env.REVIEW_ROUTER_HOSTED_CODEX_GRANT_TTL_SECONDS,
          15 * 60,
          60,
          60 * 60,
          "hosted_grant_ttl_invalid",
        ) * 1_000,
      maxRequests: readBoundedInteger(
        input.env.REVIEW_ROUTER_HOSTED_CODEX_GRANT_MAX_REQUESTS,
        32,
        1,
        64,
        "hosted_grant_max_requests_invalid",
      ),
      maxConcurrentRequests: readBoundedInteger(
        input.env.REVIEW_ROUTER_HOSTED_CODEX_GRANT_MAX_CONCURRENT_REQUESTS,
        2,
        1,
        8,
        "hosted_grant_max_concurrency_invalid",
      ),
      maxRequestBodyBytes: readBoundedInteger(
        input.env.REVIEW_ROUTER_HOSTED_CODEX_GRANT_MAX_REQUEST_BYTES,
        2_000_000,
        1_024,
        2_000_000,
        "hosted_grant_max_request_bytes_invalid",
      ),
      maxCommentTokenRefreshes: readBoundedInteger(
        input.env.REVIEW_ROUTER_HOSTED_CODEX_COMMENT_REFRESH_MAX_USES,
        8,
        1,
        32,
        "hosted_comment_refresh_max_uses_invalid",
      ),
    },
  });
}

class HmacHostedCodexCapabilityIssuer implements InvocationGrantCapabilityPort {
  constructor(
    private readonly key: Buffer,
    private readonly namespace: string,
  ) {}

  async issue(input: Parameters<InvocationGrantCapabilityPort["issue"]>[0]) {
    const plaintextToken = createHmac("sha256", this.key)
      .update(
        canonical([
          this.namespace,
          input.grantId,
          input.invocationId,
          input.repositoryBindingId,
          input.expiresAt.toISOString(),
        ]),
        "utf8",
      )
      .digest("base64url");
    return { plaintextToken, tokenHash: sha256(plaintextToken) };
  }
}

function assertExactWorkflowClaims(
  claims: GitHubActionsOidcClaims,
  admission: HostedCodexGrantAdmission,
): void {
  const pullRequestRef = `refs/pull/${admission.pullRequestNumber}/merge`;
  const subject = `repo:${admission.repository}:pull_request`;
  if (
    claims.event_name !== "pull_request" ||
    claims.sub.toLowerCase() !== subject.toLowerCase() ||
    claims.ref?.toLowerCase() !== pullRequestRef.toLowerCase() ||
    claims.workflow_ref.toLowerCase() !==
      admission.workflowSource.toLowerCase() ||
    claims.job_workflow_ref?.toLowerCase() !==
      admission.workflowJobSource.toLowerCase() ||
    claims.job_workflow_sha !== admission.workflowJobSha ||
    claims.workflow_sha !== admission.reviewHeadSha
  ) {
    throw new Error("hosted_workflow_claims_mismatch");
  }
}

function assertExactClientBinding(
  input: Parameters<HostedCodexGrantIssuerPort["issue"]>[0],
  admission: HostedCodexGrantAdmission,
): void {
  if (
    input.bindingId !== admission.bindingId ||
    input.bindingVersion !== admission.bindingRevision ||
    input.workflowSchemaVersion !== admission.workflowSchemaVersion
  ) {
    throw new Error("hosted_grant_binding_mismatch");
  }
}

async function consumeReplayNonce(
  claims: GitHubActionsOidcClaims,
  now: Date,
  replayNonces: ActionOidcReplayNonceStorePort,
): Promise<void> {
  const consumed = await replayNonces.tryConsumeNonce({
    key: buildActionOidcReplayNonceKey(claims),
    expiresAt: resolveActionOidcReplayNonceExpiresAt({ claims, now }),
    now,
  });
  if (!consumed) throw new Error("oidc_replay_detected");
}

function parsePositiveInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

function canonical(values: readonly (string | number)[]): string {
  return JSON.stringify(values);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(code);
  }
  return parsed;
}

function readCapabilityKey(
  env: Readonly<Record<string, string | undefined>>,
): Buffer {
  const encoded = env.REVIEW_ROUTER_HOSTED_CODEX_CAPABILITY_HMAC_KEY?.trim();
  if (!encoded) throw new Error("hosted_capability_hmac_key_missing");
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength < 32 || key.toString("base64") !== encoded) {
    throw new Error("hosted_capability_hmac_key_invalid");
  }
  return key;
}

function definedString<K extends string>(key: K, value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? ({ [key]: normalized } as Record<K, string>) : {};
}
