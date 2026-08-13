import {
  assertRateLimit,
  PrismaRateLimitStore,
  type RateLimitStorePort,
} from "@reviewrouter/features-rate-limits";
import { freeBetaLimits } from "@reviewrouter/features-entitlements";
import type { Prisma } from "@prisma/client";
import type { PrismaClient } from "@reviewrouter/platform-db";

type Clock = {
  now(): Date;
};

const minute = 60 * 1000;
const hour = 60 * minute;

const dashboardMutationLimits = {
  installationSync: {
    limit: freeBetaLimits.installationSyncsPerInstallationPer15Minutes,
    windowMs: 15 * minute,
  },
  workflowSetupPr: {
    limit: freeBetaLimits.setupPrAttemptsPerRepositoryPerHour,
    windowMs: hour,
  },
  workflowActivation: {
    limit: 10,
    windowMs: hour,
  },
  reviewConfigSave: {
    limit: freeBetaLimits.reviewConfigSavesPerWorkspacePerHour,
    windowMs: hour,
  },
  outboxRetry: {
    limit: freeBetaLimits.outboxRetriesPerWorkspacePerHour,
    windowMs: hour,
  },
  orgRulesetProvisioning: {
    limit: 3,
    windowMs: hour,
  },
  repositoryAccessRefresh: {
    limit: 10,
    windowMs: 15 * minute,
  },
} as const;

export class DashboardRateLimitPolicy {
  constructor(
    private readonly rateLimits: RateLimitStorePort,
    private readonly clock: Clock,
  ) {}

  async assertInstallationSyncAllowed(input: {
    readonly workspaceId: string;
    readonly githubInstallationId: string;
  }): Promise<void> {
    await this.assertOperationAllowed({
      operation: "installation_sync",
      workspaceId: input.workspaceId,
      resourceId: input.githubInstallationId,
      ...dashboardMutationLimits.installationSync,
    });
  }

  async assertWorkflowSetupPrAllowed(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
  }): Promise<void> {
    await this.assertOperationAllowed({
      operation: "workflow_setup_pr",
      workspaceId: input.workspaceId,
      resourceId: input.repositoryId,
      ...dashboardMutationLimits.workflowSetupPr,
    });
  }

  async assertWorkflowActivationAllowed(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
  }): Promise<void> {
    await this.assertOperationAllowed({
      operation: "workflow_activation",
      workspaceId: input.workspaceId,
      resourceId: input.repositoryId,
      ...dashboardMutationLimits.workflowActivation,
    });
  }

  async assertReviewConfigSaveAllowed(input: {
    readonly workspaceId: string;
    readonly resourceId?: string;
  }): Promise<void> {
    await this.assertOperationAllowed({
      operation: "review_config_save",
      workspaceId: input.workspaceId,
      resourceId: input.resourceId ?? "workspace",
      ...dashboardMutationLimits.reviewConfigSave,
    });
  }

  async assertOutboxRetryAllowed(input: {
    readonly workspaceId: string;
    readonly eventId: string;
  }): Promise<void> {
    await this.assertOperationAllowed({
      operation: "outbox_retry",
      workspaceId: input.workspaceId,
      resourceId: input.eventId,
      ...dashboardMutationLimits.outboxRetry,
    });
  }

  async assertOrgRulesetProvisioningAllowed(input: {
    readonly workspaceId: string;
    readonly githubInstallationId: string;
  }): Promise<void> {
    await this.assertOperationAllowed({
      operation: "org_ruleset_provisioning",
      workspaceId: input.workspaceId,
      resourceId: input.githubInstallationId,
      ...dashboardMutationLimits.orgRulesetProvisioning,
    });
  }

  async assertRepositoryAccessRefreshAllowed(input: {
    readonly userId: string;
  }): Promise<void> {
    await this.assertOperationAllowed({
      operation: "repository_access_refresh",
      workspaceId: `user:${input.userId}`,
      resourceId: "github",
      ...dashboardMutationLimits.repositoryAccessRefresh,
    });
  }

  private async assertOperationAllowed(input: {
    readonly operation:
      | "installation_sync"
      | "workflow_setup_pr"
      | "workflow_activation"
      | "review_config_save"
      | "outbox_retry"
      | "org_ruleset_provisioning"
      | "repository_access_refresh";
    readonly workspaceId: string;
    readonly resourceId: string;
    readonly limit: number;
    readonly windowMs: number;
  }): Promise<void> {
    await assertRateLimit(
      {
        key: [
          "dashboard",
          input.operation,
          keyPart(input.workspaceId),
          keyPart(input.resourceId),
        ].join(":"),
        limit: input.limit,
        windowMs: input.windowMs,
      },
      { rateLimits: this.rateLimits, clock: this.clock },
    );
  }
}

export function createDashboardRateLimitPolicy(
  prisma: PrismaClient | Prisma.TransactionClient,
): DashboardRateLimitPolicy {
  return new DashboardRateLimitPolicy(new PrismaRateLimitStore(prisma), {
    now: () => new Date(),
  });
}

function keyPart(value: string): string {
  return encodeURIComponent(value.trim());
}
