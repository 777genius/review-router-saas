import type {
  CodexRotatingEncryptedWritebackRequest,
  CodexRotatingLeaseRecord,
  CodexRotatingProviderBinding,
  VersionedSecretWorkflowSourceAttestation,
} from "@reviewrouter/features-codex-oauth-rotating";
import type { ActionRepositoryContext } from "../../domain/action-control-plane.js";

export type CodexRotatingPreleaseRecord = CodexRotatingLeaseRecord & {
  readonly repository: ActionRepositoryContext;
  readonly generationHashSalt: string;
  readonly accountFingerprintSalt: string;
  readonly currentGeneration: number;
  readonly currentGenerationHash?: string | undefined;
  readonly mutationEpoch: bigint;
  readonly secretNamespaceId?: string | undefined;
  readonly secretNamespaceEpoch?: bigint | undefined;
};

export type CodexRotatingSecretWriteTarget = {
  readonly expectedProviderInstanceId?: string;
  readonly githubInstallationId: string;
  readonly githubRepositoryId: string;
  readonly repositoryFullName: string;
  readonly owner: string;
  readonly repo: string;
  readonly secretName: string;
};

export interface CodexRotatingOAuthRepositoryPort {
  findProviderBinding(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly workflowSha: string;
    readonly workflowSchemaVersion: number;
  }): Promise<CodexRotatingProviderBinding | null>;

  ensureVerifiedProviderBinding(input: {
    readonly repository: ActionRepositoryContext;
    readonly binding: CodexRotatingProviderBinding;
  }): Promise<void>;

  acquirePrelease(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly eventName?:
      | "pull_request"
      | "pull_request_target"
      | "workflow_dispatch"
      | "schedule"
      | undefined;
    readonly verifiedWorkflowCommitSha?: string | undefined;
    readonly verifiedActionRef?: string | undefined;
    readonly pullRequestNumber?: number | undefined;
    readonly newWorkAdmissionBarrier: Readonly<{
      assertAdmitted(): void;
    }>;
  }): Promise<CodexRotatingPreleaseRecord>;

  finalizeLease(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly restoredGenerationHash: string;
  }): Promise<{
    readonly leaseId: string;
    readonly nextGeneration: number;
    readonly repository?: ActionRepositoryContext;
    readonly status: "finalized" | "stale_queued_secret";
  }>;

  abandonLease(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly reason: "needs_reconnect" | "unknown_auth_state";
  }): Promise<{
    readonly status: "abandoned" | "lease_not_active";
  }>;

  preflightWriteback(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly githubKeyId: string;
  }): Promise<
    | {
        readonly status: "ready";
        readonly writeTarget: CodexRotatingSecretWriteTarget;
      }
    | {
        readonly status:
          | "lease_not_active"
          | "stale_queued_secret"
          | "permission_required";
      }
  >;

  findCompletedLeaseWriteTarget(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly now: Date;
    readonly completedLeaseTtlMs?: number | undefined;
  }): Promise<
    | {
        readonly status: "ready";
        readonly writeTarget: CodexRotatingSecretWriteTarget;
      }
    | {
        readonly status: "lease_not_completed" | "lease_not_active";
      }
  >;
}

export class CodexRotatingSecretPutPreDispatchError extends Error {
  readonly outcome = "pre_dispatch_failure" as const;

  constructor() {
    super("codex_rotating_secret_put_pre_dispatch_failed");
  }
}

export function isCodexRotatingSecretPutPreDispatchError(
  error: unknown,
): error is CodexRotatingSecretPutPreDispatchError {
  return (
    error instanceof CodexRotatingSecretPutPreDispatchError ||
    (typeof error === "object" &&
      error !== null &&
      "outcome" in error &&
      error.outcome === "pre_dispatch_failure")
  );
}

export interface CodexRotatingGitHubSecretTokenIssuerPort {
  issueSecretsReadToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
    readonly permissions: { readonly secrets: "read" };
  }>;
}

export interface CodexRotatingGitHubSecretWriterPort {
  assertCanWriteRepositorySecret(
    input: CodexRotatingSecretWriteTarget,
  ): Promise<{
    readonly status: "ready";
  }>;

  putEncryptedRepositorySecret(
    input: CodexRotatingSecretWriteTarget & {
      readonly encryptedValue: string;
      readonly keyId: string;
    },
  ): Promise<{
    readonly status: "accepted";
    readonly statusCode: 201 | 204;
  }>;
}

/**
 * Required replacement for runtime refresh writes. Implementations must
 * durably allocate a never-reused namespace and one dispatch attempt before
 * issuing one provider PUT; an ambiguous result permanently retires the name.
 */
export interface CodexRotatingVersionedWritebackDispatcherPort {
  dispatchOneShot(input: {
    readonly request: CodexRotatingEncryptedWritebackRequest;
    readonly encryptedPayloadDigest: string;
  }): Promise<
    | { readonly status: "accepted"; readonly generation: number }
    | { readonly status: "idempotent_replay"; readonly generation: number }
    | { readonly status: "in_progress"; readonly retryAfter: Date }
    | { readonly status: "github_put_failed" }
    | { readonly status: "writeback_recovery_required" }
    | { readonly status: "writeback_idempotency_conflict" }
  >;
}

export type CodexRotatingVersionedWritebackClaim = Readonly<{
  intentId: string;
  attemptId: string;
  executorOwner: string;
  retirementIdentity: import("@reviewrouter/features-codex-oauth-rotating").RuntimeVersionedWritebackIdentity;
  namespace: import("@reviewrouter/features-codex-oauth-rotating").VersionedProviderSecretNamespace;
  writeTarget: CodexRotatingSecretWriteTarget;
  repository: ActionRepositoryContext;
}>;

export interface CodexRotatingVersionedWritebackLedgerPort {
  prepareVersionedWriteback(input: {
    readonly request: CodexRotatingEncryptedWritebackRequest;
    readonly encryptedPayloadDigest: string;
  }): Promise<
    | ({ readonly status: "ready" } & CodexRotatingVersionedWritebackClaim)
    | { readonly status: "unchanged_generation"; readonly generation: number }
    | { readonly status: "idempotent_replay"; readonly generation: number }
    | { readonly status: "in_progress"; readonly retryAfter: Date }
    | { readonly status: "writeback_recovery_required" }
    | { readonly status: "writeback_idempotency_conflict" }
  >;

  confirmVersionedProviderWrite(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly statusCode: 201 | 204;
  }): Promise<void>;

  retirePreDispatchVersionedWriteback(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly safeErrorCode: string;
  }): Promise<void>;

  retireAmbiguousVersionedWriteback(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly retirementIdentity: import("@reviewrouter/features-codex-oauth-rotating").RuntimeVersionedWritebackIdentity;
    readonly safeErrorCode: string;
  }): Promise<void>;

  activateVersionedWriteback(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly attestation: VersionedSecretWorkflowSourceAttestation;
    readonly rolloverOperationId?: string | undefined;
  }): Promise<{ readonly generation: number }>;
}

export interface CodexRotatingVersionedWorkflowPublisherPort {
  publishAndVerifyVersionedWorkflow(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly namespace: import("@reviewrouter/features-codex-oauth-rotating").VersionedProviderSecretNamespace;
  }): Promise<VersionedSecretWorkflowSourceAttestation>;
}

export interface CodexRotatingGitHubCheckoutTokenIssuerPort {
  issueContentsReadToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
    readonly permissions: {
      readonly contents: "read";
      readonly pullRequests: "read";
    };
  }>;
}

export interface CodexRotatingWorkflowSourceVerifierPort {
  verifyWorkflowSource(input: {
    readonly repository: ActionRepositoryContext;
    readonly workflowSha: string;
    readonly workflowRef: string;
    readonly workflowPath: string;
    readonly expectedActionOwnerRepo: string;
    readonly expectedProviderInstanceId: string;
    readonly expectedWorkflowSchemaVersion: number;
  }): Promise<{
    readonly binding: CodexRotatingProviderBinding;
    readonly attestation?: VersionedSecretWorkflowSourceAttestation;
  }>;

  resolveWorkflowRunPullRequest?(input: {
    readonly repository: ActionRepositoryContext;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly eventName: "pull_request_target";
  }): Promise<number>;

  resolveWorkflowRunPullRequestBinding?(input: {
    readonly repository: ActionRepositoryContext;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly eventName: "pull_request_target";
  }): Promise<CodexRotatingWorkflowRunPullRequestBinding>;

  resolveWorkflowRunForkPullRequest?(input: {
    readonly repository: ActionRepositoryContext;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly eventName: "pull_request_target";
  }): Promise<CodexRotatingWorkflowRunPullRequestBinding>;
}

export type CodexRotatingWorkflowRunPullRequestBinding = Readonly<{
  baseRepository: string;
  baseRepositoryId: string;
  sourceRepository: string;
  sourceRepositoryId: string;
  sourceVisibility: "public" | "private" | "internal";
  pullRequestNumber: number;
  reviewHeadSha: string;
  baseSha: string;
  draft: boolean;
  authorType: string;
}>;
