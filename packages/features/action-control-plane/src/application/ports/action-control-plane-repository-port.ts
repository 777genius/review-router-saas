import type {
  ActionHealthReport,
  ActionRepositoryContext,
  ActionSessionClaims,
} from "../../domain/action-control-plane.js";
import type { ReviewConfiguration } from "@reviewrouter/features-review-config";

export type RuntimeReviewConfigurationRecord = {
  readonly version: number;
  readonly config: ReviewConfiguration;
};

export interface ActionControlPlaneRepositoryPort {
  findSelectedRepositoryByGithubId(
    githubRepositoryId: string,
  ): Promise<ActionRepositoryContext | null>;

  findRuntimeReviewConfiguration(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
  }): Promise<RuntimeReviewConfigurationRecord | null>;

  recordHealthReport(input: {
    readonly session: ActionSessionClaims;
    readonly report: ActionHealthReport;
    readonly receivedAt: Date;
  }): Promise<void>;
}
