import type { ScmProvider } from "@reviewrouter/shared";
import type { ReviewConfiguration } from "../../domain/review-configuration";
import type { ReviewConfigurationTarget } from "../../domain/review-configuration-target";
import type { PersistedReviewConfiguration } from "./review-configuration-repository-port";

export enum ReviewConfigurationOperatorOperation {
  Read = "read_review_configuration",
  SetReasoningEffort = "set_review_reasoning_effort",
  SetInvestigationRollout = "set_review_investigation_rollout",
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

export interface ReviewConfigurationOperatorMutationPort {
  commit(input: {
    readonly target: Extract<
      ReviewConfigurationTarget,
      { readonly scope: "repository" }
    >;
    readonly expectedRevisionToken: string;
    readonly config: ReviewConfiguration;
    readonly auditEvent: ReviewConfigurationOperatorAuditEvent;
  }): Promise<PersistedReviewConfiguration>;
}

export type ReviewConfigurationOperatorRepository = Readonly<{
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  provider: ScmProvider;
  sourceBaseUrl: string;
  fullName: string;
}>;

export interface ReviewConfigurationOperatorRepositoryPort {
  findActiveCandidates(input: {
    readonly provider: ScmProvider;
    readonly repositoryFullName: string;
    readonly workspace?: string;
    readonly sourceBaseUrl?: string;
  }): Promise<readonly ReviewConfigurationOperatorRepository[]>;
}
