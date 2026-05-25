import type {
  CodexRotatingEncryptedWritebackRequest,
  CodexRotatingLeaseRecord,
  CodexRotatingProviderBinding,
} from "@reviewrouter/features-codex-oauth-rotating";
import type { ActionRepositoryContext } from "../../domain/action-control-plane.js";

export type CodexRotatingPreleaseRecord = CodexRotatingLeaseRecord & {
  readonly repository: ActionRepositoryContext;
  readonly generationHashSalt: string;
  readonly currentGeneration: number;
  readonly currentGenerationHash?: string | undefined;
};

export type CodexRotatingSecretWriteTarget = {
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
  }): Promise<CodexRotatingProviderBinding | null>;

  acquirePrelease(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly now: Date;
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
        readonly status: "idempotent_replay" | "writeback_idempotency_conflict";
      }
  >;

  confirmEncryptedWriteback(input: {
    readonly intentId: string;
    readonly now: Date;
  }): Promise<void>;

  markEncryptedWritebackFailed(input: {
    readonly intentId: string;
    readonly safeErrorCode: string;
    readonly now: Date;
  }): Promise<void>;
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
    readonly expectedActionRef: string;
    readonly expectedProviderInstanceId: string;
    readonly expectedWorkflowSchemaVersion: number;
  }): Promise<{
    readonly binding: CodexRotatingProviderBinding;
    readonly workflowSourceSha256: string;
  }>;
}
