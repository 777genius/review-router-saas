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
    readonly marker: string;
    readonly body: string;
  }): Promise<{
    readonly status: "created" | "updated";
    readonly commentId: string;
    readonly commentUrl?: string;
  }>;
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
}

export interface CertifiedForkReviewOutputPort {
  render(input: {
    readonly modelOutput: unknown;
    readonly marker: string;
    readonly binding: CertifiedForkReviewBinding;
    readonly generatedAt: Date;
    readonly promptPacket: CertifiedForkReviewPromptPacket;
  }): { readonly body: string };
}
