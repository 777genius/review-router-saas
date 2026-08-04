import { describe, expect, it, vi } from "vitest";
import {
  InvestigationRolloutCapability,
  InvestigationRolloutDecision,
  InvestigationRolloutProvider,
} from "@reviewrouter/features-review-investigation-operations";
import { ReviewInvestigationRolloutGuard } from "./review-investigation-rollout-guard.js";

const target = {
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-1",
  scmRepositoryIdentityId: "scm-repository-1",
  provider: InvestigationRolloutProvider.Codex,
  trustDomain: "trusted-managed",
  producerReleaseId: "release-1",
} as const;

describe("ReviewInvestigationRolloutGuard", () => {
  it("allows only the current allowed decision", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue(InvestigationRolloutDecision.Allowed);
    const guard = new ReviewInvestigationRolloutGuard({ execute } as never);

    await expect(
      guard.assertAllowed({
        capability: InvestigationRolloutCapability.ProductionEffects,
        target,
      }),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("maps an unavailable policy source to a retryable service failure", async () => {
    const guard = new ReviewInvestigationRolloutGuard({
      execute: vi
        .fn()
        .mockResolvedValue(InvestigationRolloutDecision.Unavailable),
    } as never);

    await expect(
      guard.assertAllowed({
        capability: InvestigationRolloutCapability.ProductionEffects,
        target,
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it.each([
    InvestigationRolloutDecision.Disabled,
    InvestigationRolloutDecision.OutsideCohort,
    InvestigationRolloutDecision.EmergencyDisabled,
  ])("maps %s to a deterministic capability denial", async (decision) => {
    const guard = new ReviewInvestigationRolloutGuard({
      execute: vi.fn().mockResolvedValue(decision),
    } as never);

    await expect(
      guard.assertAllowed({
        capability: InvestigationRolloutCapability.ProductionEffects,
        target,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("returns only allowed capabilities from one batch resolution", async () => {
    const executeAllForTargets = vi.fn().mockResolvedValue([
      {
        [InvestigationRolloutCapability.ContextCritic]:
          InvestigationRolloutDecision.Disabled,
        [InvestigationRolloutCapability.CrossRevisionReplay]:
          InvestigationRolloutDecision.Disabled,
        [InvestigationRolloutCapability.ProductionEffects]:
          InvestigationRolloutDecision.Disabled,
        [InvestigationRolloutCapability.Recording]:
          InvestigationRolloutDecision.Allowed,
        [InvestigationRolloutCapability.Shadow]:
          InvestigationRolloutDecision.Disabled,
        [InvestigationRolloutCapability.VerifiedClean]:
          InvestigationRolloutDecision.Disabled,
      },
    ]);
    const guard = new ReviewInvestigationRolloutGuard({
      executeAllForTargets,
    } as never);

    await expect(guard.resolveAllowedCapabilities({ target })).resolves.toEqual(
      [InvestigationRolloutCapability.Recording],
    );
    expect(executeAllForTargets).toHaveBeenCalledOnce();
  });

  it("fails closed when a batch policy snapshot is unavailable", async () => {
    const unavailable = Object.fromEntries(
      Object.values(InvestigationRolloutCapability).map((capability) => [
        capability,
        InvestigationRolloutDecision.Unavailable,
      ]),
    );
    const guard = new ReviewInvestigationRolloutGuard({
      executeAllForTargets: vi.fn().mockResolvedValue([unavailable]),
    } as never);

    await expect(
      guard.resolveAllowedCapabilities({ target }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
