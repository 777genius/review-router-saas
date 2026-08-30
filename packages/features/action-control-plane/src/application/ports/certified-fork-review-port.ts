import type { GitHubActionsOidcClaims } from "../../domain/action-control-plane.js";

export type CertifiedForkReviewBinding = Readonly<{
  sourceRepository: string;
  sourceRepositoryId: string;
  baseRepository: string;
  baseRepositoryId: string;
  pullRequestNumber: number;
  reviewHeadSha: string;
  baseSha: string;
  trustDomain: "fork";
}>;

export type CertifiedForkReviewFile = Readonly<{
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}>;

export type CertifiedForkReviewPromptPacket = Readonly<{
  protocolVersion: 1;
  contextHash: string;
  repository: Readonly<{ base: string; source: string }>;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  files: readonly CertifiedForkReviewFile[];
}>;

export interface CertifiedForkReviewGatewayPort {
  assertBindingCurrent(input: {
    readonly githubInstallationId: string;
    readonly binding: CertifiedForkReviewBinding;
  }): Promise<void>;
  prepareContext(input: {
    readonly githubInstallationId: string;
    readonly binding: CertifiedForkReviewBinding;
  }): Promise<{
    readonly contextHash: string;
    readonly promptPacket: CertifiedForkReviewPromptPacket;
  }>;
  assertContextCurrent(input: {
    readonly githubInstallationId: string;
    readonly binding: CertifiedForkReviewBinding;
    readonly expectedContextHash: string;
  }): Promise<{ readonly promptPacket: CertifiedForkReviewPromptPacket }>;
  upsertOwnedComment(input: {
    readonly githubInstallationId: string;
    readonly binding: CertifiedForkReviewBinding;
    readonly markerPrefix: string;
    readonly marker: string;
    readonly executionDigest: string;
    readonly outputDigest: string;
    readonly body: string;
  }): Promise<{
    readonly status: "created" | "updated";
    readonly commentId: string;
    readonly commentUrl?: string;
  }>;
}

export interface CertifiedForkReviewPublishLockPort {
  withLock<T>(
    key: string,
    run: (claims: CertifiedForkReviewClaimPort) => Promise<T>,
  ): Promise<T>;
}

export interface CertifiedForkReviewAdmissionPort {
  assertEnabled(binding: CertifiedForkReviewBinding): void;
}

export type CertifiedForkReviewClaimScope = Readonly<{
  baseRepositoryId: string;
  pullRequestNumber: number;
  reviewHeadSha: string;
  baseSha: string;
  contextHash: string;
  promptPolicyVersion: number;
}>;

export interface CertifiedForkReviewClaimPort {
  claimPrelease(input: {
    readonly scope: CertifiedForkReviewClaimScope;
    readonly reservationOwner: string;
  }): Promise<
    | { readonly status: "ready" | "resume" }
    | { readonly status: "in_progress" }
    | {
        readonly status: "already_published";
        readonly commentId: string;
        readonly commentUrl?: string;
      }
  >;
  abandonPrelease(input: {
    readonly scope: CertifiedForkReviewClaimScope;
    readonly reservationOwner: string;
  }): Promise<void>;
  markPreleaseAmbiguous(input: {
    readonly scope: CertifiedForkReviewClaimScope;
    readonly reservationOwner: string;
  }): Promise<void>;
  recoverAmbiguousPrelease(input: {
    readonly scope: CertifiedForkReviewClaimScope;
    readonly reservationOwner: string;
    readonly noProviderEffectEvidenceHash: string;
  }): Promise<void>;
  claimPrepare(input: {
    readonly scope: CertifiedForkReviewClaimScope;
    readonly reservationOwner: string;
    readonly executionId: string;
  }): Promise<
    | { readonly status: "ready" | "resume" }
    | { readonly status: "in_progress" }
    | {
        readonly status: "already_published";
        readonly commentId: string;
        readonly commentUrl?: string;
      }
  >;
  beginPublish(input: {
    readonly scope: CertifiedForkReviewClaimScope;
    readonly executionId: string;
    readonly outputDigest: string;
  }): Promise<
    | { readonly status: "ready" }
    | {
        readonly status: "already_published";
        readonly commentId: string;
        readonly commentUrl?: string;
      }
  >;
  completePublished(input: {
    readonly scope: CertifiedForkReviewClaimScope;
    readonly executionId: string;
    readonly outputDigest: string;
    readonly commentId: string;
    readonly commentUrl?: string;
  }): Promise<void>;
}

export interface CertifiedForkReviewLeasePort {
  assertFinalizedV5ForkLease(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly claims: GitHubActionsOidcClaims;
    readonly binding: CertifiedForkReviewBinding;
  }): Promise<{ readonly githubInstallationId: string }>;
}

export type CertifiedForkReviewTicket = Readonly<{
  executionId: string;
  contextHash: string;
  leaseId: string;
  providerInstanceId: string;
  githubInstallationId: string;
  githubRunId: string;
  githubRunAttempt: string;
  workflowRef: string;
  workflowSha: string;
  binding: CertifiedForkReviewBinding;
}>;

export interface CertifiedForkReviewTicketPort {
  issue(
    input: Omit<CertifiedForkReviewTicket, "executionId">,
  ): Promise<CertifiedForkReviewTicket>;
  verify(executionId: string): Promise<CertifiedForkReviewTicket>;
  signPublication(input: {
    readonly executionDigest: string;
    readonly outputDigest: string;
  }): Promise<string>;
}

export interface CertifiedForkReviewOutputPort {
  render(input: {
    readonly modelOutput: unknown;
    readonly binding: CertifiedForkReviewBinding;
    readonly generatedAt: Date;
    readonly promptPacket: CertifiedForkReviewPromptPacket;
  }): { readonly body: string };
}
