import type {
  CodexRotatingEncryptedWritebackRequest,
  CodexRotatingMutationConfirmationOutcome,
  CodexRotatingLeaseRecord,
  CodexRotatingProviderBinding,
} from "@reviewrouter/features-codex-oauth-rotating";
import type { ActionRepositoryContext } from "../../domain/action-control-plane.js";

export type CodexRotatingPreleaseRecord = CodexRotatingLeaseRecord & {
  readonly repository: ActionRepositoryContext;
  readonly generationHashSalt: string;
  readonly currentGeneration: number;
  readonly currentGenerationHash?: string | undefined;
  readonly mutationEpoch: bigint;
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
    readonly pullRequestNumber?: number | undefined;
    readonly now: Date;
    readonly newWorkAdmissionBarrier: Readonly<{
      assertAdmitted(): void;
    }>;
  }): Promise<CodexRotatingPreleaseRecord>;

  finalizeLease(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly restoredGenerationHash: string;
    readonly now: Date;
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
    readonly now: Date;
  }): Promise<{
    readonly status: "abandoned" | "lease_not_active";
  }>;

  preflightWriteback(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly githubKeyId: string;
    readonly now: Date;
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

  prepareEncryptedWriteback(input: {
    readonly request: CodexRotatingEncryptedWritebackRequest;
    readonly encryptedPayloadDigest: string;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "ready";
        readonly intentId: string;
        readonly writeTarget: CodexRotatingSecretWriteTarget;
      }
    | {
        readonly status:
          | "idempotent_replay"
          | "writeback_recovery_required"
          | "writeback_idempotency_conflict";
      }
  >;

  confirmEncryptedWriteback(input: {
    readonly intentId: string;
    readonly now: Date;
  }): Promise<CodexRotatingMutationConfirmationOutcome>;

  markEncryptedWritebackDispatched(input: {
    readonly intentId: string;
    readonly now: Date;
  }): Promise<boolean>;

  markEncryptedWritebackFailed(input: {
    readonly intentId: string;
    readonly safeErrorCode: string;
    readonly now: Date;
  }): Promise<void>;

  markEncryptedWritebackRemoteOutcomeUnknown(input: {
    readonly intentId: string;
    readonly safeErrorCode: string;
    readonly now: Date;
  }): Promise<void>;
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
    readonly workflowPath: string;
    readonly expectedActionOwnerRepo: string;
    readonly expectedProviderInstanceId: string;
    readonly expectedWorkflowSchemaVersion: number;
  }): Promise<{
    readonly binding: CodexRotatingProviderBinding;
    readonly workflowSourceSha256: string;
  }>;

  resolveWorkflowRunPullRequest?(input: {
    readonly repository: ActionRepositoryContext;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly eventName: "pull_request_target";
  }): Promise<number>;
}
