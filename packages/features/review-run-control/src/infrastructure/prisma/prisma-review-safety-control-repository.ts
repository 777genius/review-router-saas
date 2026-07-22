import type { Prisma, PrismaClient } from "@prisma/client";
import {
  reviewSafetyPolicyKey,
  reviewSafetyScopeKey,
  type ReviewSafetyEmergencyControl,
  type ReviewSafetyPolicy,
  type ReviewSafetyResolutionTarget,
  type ReviewSafetyScope,
} from "../../domain/review-safety-policy";
import {
  ReviewSafetyCapability,
  ReviewSafetyRolloutMode,
  canonicalJson,
} from "../../domain/review-run-control-types";
import type {
  ReviewSafetyControlInspectionPort,
  ReviewSafetyEmergencyControlCommandPort,
  ReviewSafetyEmergencyControlQueryPort,
  ReviewSafetyPolicyCommandPort,
  ReviewSafetyPolicyQueryPort,
} from "../../application/ports/review-safety-policy-ports";
import { ReviewSafetyControlWriteStatus } from "../../application/ports/review-safety-policy-ports";
import {
  reviewSafetyEmergencyControlToDomain,
  reviewSafetyPolicyToDomain,
  reviewSafetyScopeColumns,
  reviewSafetySelectorColumns,
} from "./prisma-review-run-control-mappers";
import { lockReviewRunControlKey } from "./prisma-review-run-control-utils";

export class PrismaReviewSafetyControlRepository
  implements
    ReviewSafetyPolicyQueryPort,
    ReviewSafetyPolicyCommandPort,
    ReviewSafetyEmergencyControlQueryPort,
    ReviewSafetyEmergencyControlCommandPort,
    ReviewSafetyControlInspectionPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async findApplicableReviewSafetyPolicies(input: {
    readonly target: ReviewSafetyResolutionTarget;
    readonly capabilities: readonly ReviewSafetyCapability[];
  }): Promise<readonly ReviewSafetyPolicy[]> {
    if (input.capabilities.length === 0) return [];
    const rows = await this.prisma.reviewSafetyPolicy.findMany({
      where: {
        capability: {
          in: input.capabilities.map(safetyCapabilityToPersistence),
        },
        OR: applicableScopePredicates(input.target),
      },
      orderBy: [{ policyScope: "asc" }, { policyId: "asc" }],
    });
    const selectors = await this.prisma.reviewSafetyPolicySelector.findMany({
      where: { policyId: { in: rows.map((row) => row.policyId) } },
      orderBy: [{ policyId: "asc" }, { selectorOrdinal: "asc" }],
    });
    return rows.map((row) =>
      reviewSafetyPolicyToDomain(
        row,
        selectors.filter((selector) => selector.policyId === row.policyId),
      ),
    );
  }

  async findApplicableReviewSafetyEmergencyControls(
    target: ReviewSafetyResolutionTarget,
  ): Promise<readonly ReviewSafetyEmergencyControl[]> {
    const rows = await this.prisma.reviewSafetyEmergencyControl.findMany({
      where: { OR: applicableScopePredicates(target) },
      orderBy: [{ policyScope: "asc" }, { emergencyControlId: "asc" }],
    });
    return rows.map(reviewSafetyEmergencyControlToDomain);
  }

  async findReviewSafetyPolicy(input: {
    readonly scope: ReviewSafetyScope;
    readonly capability: ReviewSafetyCapability;
  }): Promise<ReviewSafetyPolicy | null> {
    const row = await this.prisma.reviewSafetyPolicy.findFirst({
      where: {
        ...reviewSafetyScopeColumns(input.scope),
        capability: safetyCapabilityToPersistence(input.capability),
      },
    });
    if (!row) return null;
    const selectors = await this.prisma.reviewSafetyPolicySelector.findMany({
      where: { policyId: row.policyId },
      orderBy: { selectorOrdinal: "asc" },
    });
    return reviewSafetyPolicyToDomain(row, selectors);
  }

  async findReviewSafetyEmergencyControl(
    scope: ReviewSafetyScope,
  ): Promise<ReviewSafetyEmergencyControl | null> {
    const row = await this.prisma.reviewSafetyEmergencyControl.findFirst({
      where: reviewSafetyScopeColumns(scope),
    });
    return row ? reviewSafetyEmergencyControlToDomain(row) : null;
  }

  async putReviewSafetyPolicy(input: {
    readonly expectedVersion: number;
    readonly policy: ReviewSafetyPolicy;
  }) {
    const key = reviewSafetyPolicyKey(input.policy);
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKey(transaction, "review-safety-policy", key);
      const currentRow = await transaction.reviewSafetyPolicy.findFirst({
        where: {
          ...reviewSafetyScopeColumns(input.policy.scope),
          capability: safetyCapabilityToPersistence(input.policy.capability),
        },
      });
      const currentSelectors = currentRow
        ? await transaction.reviewSafetyPolicySelector.findMany({
            where: { policyId: currentRow.policyId },
            orderBy: { selectorOrdinal: "asc" },
          })
        : [];
      const current = currentRow
        ? reviewSafetyPolicyToDomain(currentRow, currentSelectors)
        : null;
      if (current && equivalentPolicy(current, input.policy)) {
        return {
          status: ReviewSafetyControlWriteStatus.Restored,
          policy: current,
        } as const;
      }
      if (
        (current?.version ?? 0) !== input.expectedVersion ||
        input.policy.version !== input.expectedVersion + 1 ||
        (current !== null && current.policyId !== input.policy.policyId)
      ) {
        return { status: ReviewSafetyControlWriteStatus.Conflict } as const;
      }
      if (!current) {
        const created = await transaction.reviewSafetyPolicy.create({
          data: policyData(input.policy),
        });
        await replaceSelectors(transaction, input.policy);
        return {
          status: ReviewSafetyControlWriteStatus.Created,
          policy: reviewSafetyPolicyToDomain(
            created,
            await transaction.reviewSafetyPolicySelector.findMany({
              where: { policyId: created.policyId },
              orderBy: { selectorOrdinal: "asc" },
            }),
          ),
        } as const;
      }
      const updated = await transaction.reviewSafetyPolicy.updateMany({
        where: {
          policyId: current.policyId,
          version: input.expectedVersion,
        },
        data: policyData(input.policy),
      });
      if (updated.count !== 1) {
        return { status: ReviewSafetyControlWriteStatus.Conflict } as const;
      }
      await replaceSelectors(transaction, input.policy);
      return {
        status: ReviewSafetyControlWriteStatus.Updated,
        policy: input.policy,
      } as const;
    });
  }

  async putReviewSafetyEmergencyControl(input: {
    readonly expectedVersion: number;
    readonly control: ReviewSafetyEmergencyControl;
  }) {
    const key = reviewSafetyScopeKey(input.control.scope);
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKey(
        transaction,
        "review-safety-emergency",
        key,
      );
      const currentRow =
        await transaction.reviewSafetyEmergencyControl.findFirst({
          where: reviewSafetyScopeColumns(input.control.scope),
        });
      const current = currentRow
        ? reviewSafetyEmergencyControlToDomain(currentRow)
        : null;
      if (current && equivalentEmergency(current, input.control)) {
        return {
          status: ReviewSafetyControlWriteStatus.Restored,
          control: current,
        } as const;
      }
      if (
        (current?.version ?? 0) !== input.expectedVersion ||
        input.control.version !== input.expectedVersion + 1 ||
        (current !== null &&
          current.emergencyControlId !== input.control.emergencyControlId)
      ) {
        return { status: ReviewSafetyControlWriteStatus.Conflict } as const;
      }
      if (!current) {
        const created = await transaction.reviewSafetyEmergencyControl.create({
          data: emergencyData(input.control),
        });
        return {
          status: ReviewSafetyControlWriteStatus.Created,
          control: reviewSafetyEmergencyControlToDomain(created),
        } as const;
      }
      const updated = await transaction.reviewSafetyEmergencyControl.updateMany(
        {
          where: {
            emergencyControlId: current.emergencyControlId,
            version: input.expectedVersion,
          },
          data: emergencyData(input.control),
        },
      );
      if (updated.count !== 1) {
        return { status: ReviewSafetyControlWriteStatus.Conflict } as const;
      }
      return {
        status: ReviewSafetyControlWriteStatus.Updated,
        control: input.control,
      } as const;
    });
  }
}

function applicableScopePredicates(target: ReviewSafetyResolutionTarget) {
  return [
    {
      policyScope: "global" as const,
      workspaceId: null,
      repositoryConnectionId: null,
      scmRepositoryIdentityId: null,
    },
    {
      policyScope: "workspace" as const,
      workspaceId: target.workspaceId,
      repositoryConnectionId: null,
      scmRepositoryIdentityId: null,
    },
    {
      policyScope: "repository" as const,
      workspaceId: target.workspaceId,
      repositoryConnectionId: target.repositoryConnectionId,
      scmRepositoryIdentityId: target.scmRepositoryIdentityId,
    },
  ];
}

function policyData(policy: ReviewSafetyPolicy) {
  return {
    policyId: policy.policyId,
    ...reviewSafetyScopeColumns(policy.scope),
    capability: safetyCapabilityToPersistence(policy.capability),
    version: policy.version,
    rolloutMode: rolloutModeToPersistence(policy.rolloutMode),
    updatedBy: policy.updatedBy,
    updatedAt: policy.updatedAt,
  };
}

function emergencyData(control: ReviewSafetyEmergencyControl) {
  return {
    emergencyControlId: control.emergencyControlId,
    ...reviewSafetyScopeColumns(control.scope),
    version: control.version,
    stopped: control.stopped,
    reason: control.reason,
    updatedBy: control.updatedBy,
    updatedAt: control.updatedAt,
  };
}

async function replaceSelectors(
  transaction: Prisma.TransactionClient,
  policy: ReviewSafetyPolicy,
): Promise<void> {
  await transaction.reviewSafetyPolicySelector.deleteMany({
    where: { policyId: policy.policyId },
  });
  if (policy.providerTaskSelectors.length === 0) return;
  await transaction.reviewSafetyPolicySelector.createMany({
    data: policy.providerTaskSelectors.map((selector, selectorOrdinal) => ({
      policyId: policy.policyId,
      selectorOrdinal,
      ...reviewSafetySelectorColumns(selector),
    })),
  });
}

function equivalentPolicy(
  left: ReviewSafetyPolicy,
  right: ReviewSafetyPolicy,
): boolean {
  return (
    canonicalJson({ ...left, updatedAt: undefined }) ===
    canonicalJson({ ...right, updatedAt: undefined })
  );
}

function equivalentEmergency(
  left: ReviewSafetyEmergencyControl,
  right: ReviewSafetyEmergencyControl,
): boolean {
  return (
    canonicalJson({ ...left, updatedAt: undefined }) ===
    canonicalJson({ ...right, updatedAt: undefined })
  );
}

function safetyCapabilityToPersistence(
  capability: ReviewSafetyCapability,
):
  | "run_authorization_v2"
  | "evidence_writes_v2"
  | "evidence_reuse_v2"
  | "prompt_only_reuse"
  | "context_gateway_reuse"
  | "publication_operations_v2"
  | "mutation_epoch_v2" {
  switch (capability) {
    case ReviewSafetyCapability.RunAuthorizationV2:
      return "run_authorization_v2";
    case ReviewSafetyCapability.EvidenceWritesV2:
      return "evidence_writes_v2";
    case ReviewSafetyCapability.EvidenceReuseV2:
      return "evidence_reuse_v2";
    case ReviewSafetyCapability.PromptOnlyReuse:
      return "prompt_only_reuse";
    case ReviewSafetyCapability.ContextGatewayReuse:
      return "context_gateway_reuse";
    case ReviewSafetyCapability.PublicationOperationsV2:
      return "publication_operations_v2";
    case ReviewSafetyCapability.MutationEpochV2:
      return "mutation_epoch_v2";
  }
}

function rolloutModeToPersistence(
  mode: ReviewSafetyRolloutMode,
): "disabled" | "shadow" | "allowlisted" | "enabled" {
  switch (mode) {
    case ReviewSafetyRolloutMode.Disabled:
      return "disabled";
    case ReviewSafetyRolloutMode.Shadow:
      return "shadow";
    case ReviewSafetyRolloutMode.Allowlisted:
      return "allowlisted";
    case ReviewSafetyRolloutMode.Enabled:
      return "enabled";
  }
}
