import type { ScmProvider } from "@reviewrouter/shared";

export enum ReviewConfigurationOperatorOperation {
  Read = "read_review_configuration",
  SetReasoningEffort = "set_review_reasoning_effort",
}

export type ReviewConfigurationOperatorPrincipal = Readonly<{
  operatorId: string;
}>;

export interface ReviewConfigurationOperatorAuthorizationPort {
  authenticate(input: {
    readonly credential: string;
    readonly operation: ReviewConfigurationOperatorOperation;
  }): Promise<ReviewConfigurationOperatorPrincipal | null>;
}

export interface ReviewConfigurationOperatorRateLimitPort {
  consume(input: {
    readonly operatorId: string;
    readonly operation: ReviewConfigurationOperatorOperation;
    readonly repositoryFullName: string;
  }): Promise<boolean>;
}

export type ReviewConfigurationOperatorAuditEvent = Readonly<{
  workspaceId: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export interface ReviewConfigurationOperatorAuditPort {
  record(event: ReviewConfigurationOperatorAuditEvent): Promise<void>;
}

export type ReviewConfigurationOperatorRepository = Readonly<{
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  provider: ScmProvider;
  fullName: string;
}>;

export interface ReviewConfigurationOperatorRepositoryPort {
  findActiveCandidates(input: {
    readonly provider: ScmProvider;
    readonly repositoryFullName: string;
    readonly workspace?: string;
  }): Promise<readonly ReviewConfigurationOperatorRepository[]>;
}
