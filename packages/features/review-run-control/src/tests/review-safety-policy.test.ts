import { describe, expect, it } from "vitest";
import {
  ReviewProviderKind,
  ReviewSafetyCapability,
  ReviewSafetyDecisionKind,
  ReviewSafetyPolicyScope,
  ReviewSafetyRolloutMode,
  ReviewTaskKind,
} from "../domain/review-run-control-types";
import { createReviewRunControlTestKit } from "../testing/review-run-control-test-kit";

const target = {
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-1",
  scmRepositoryIdentityId: "scm-1",
  providerTasks: [
    {
      providerKind: ReviewProviderKind.Codex,
      taskKind: ReviewTaskKind.CodeReview,
    },
  ],
} as const;

describe("ReviewSafetyPolicy resolution", () => {
  it("is disabled by default and fails closed when the global control is missing or unreadable", async () => {
    const kit = createReviewRunControlTestKit();
    const missing = await kit.control.safetyResolver.resolveReviewSafetyPolicy({
      decisionKind: ReviewSafetyDecisionKind.RunAuthorization,
      target,
    });
    expect(missing).toMatchObject({
      effectAllowed: false,
      emergencyStopped: true,
    });
    kit.store.setSafetyStoreReadable(false);
    const unreadable =
      await kit.control.safetyResolver.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.AuthorizedExecutionContinuation,
        target,
      });
    expect(unreadable).toMatchObject({
      effectAllowed: false,
      emergencyStopped: true,
    });
    const recovery = await kit.control.safetyResolver.resolveReviewSafetyPolicy(
      {
        decisionKind: ReviewSafetyDecisionKind.StatusOrReconciliation,
        target,
      },
    );
    expect(recovery).toMatchObject({
      effectAllowed: true,
      emergencyStopped: false,
    });
  });

  it("applies disable-wins and never lets a narrower rule broaden disabled or shadow", async () => {
    const kit = createReviewRunControlTestKit();
    await openGlobalEmergency(kit);
    await putPolicy(kit, {
      expectedVersion: 0,
      scope: { scope: ReviewSafetyPolicyScope.Global },
      rolloutMode: ReviewSafetyRolloutMode.Enabled,
    });
    await putPolicy(kit, {
      expectedVersion: 0,
      scope: {
        scope: ReviewSafetyPolicyScope.Workspace,
        workspaceId: target.workspaceId,
      },
      rolloutMode: ReviewSafetyRolloutMode.Disabled,
    });
    await putPolicy(kit, {
      expectedVersion: 0,
      scope: {
        scope: ReviewSafetyPolicyScope.Repository,
        workspaceId: target.workspaceId,
        repositoryConnectionId: target.repositoryConnectionId,
        scmRepositoryIdentityId: target.scmRepositoryIdentityId,
      },
      rolloutMode: ReviewSafetyRolloutMode.Enabled,
    });
    const decision = await resolveRunAuthorization(kit);
    expect(decision.effectAllowed).toBe(false);
    expect(decision.capabilityDecisions[0]?.effectiveMode).toBe(
      ReviewSafetyRolloutMode.Disabled,
    );
  });

  it("requires explicit narrower allowlist enrollment and matching selectors", async () => {
    const kit = createReviewRunControlTestKit();
    await openGlobalEmergency(kit);
    await putPolicy(kit, {
      expectedVersion: 0,
      scope: { scope: ReviewSafetyPolicyScope.Global },
      rolloutMode: ReviewSafetyRolloutMode.Allowlisted,
      providerTaskSelectors: [
        {
          providerKind: ReviewProviderKind.Codex,
          taskKind: ReviewTaskKind.CodeReview,
        },
      ],
    });
    expect((await resolveRunAuthorization(kit)).effectAllowed).toBe(false);
    await putPolicy(kit, {
      expectedVersion: 0,
      scope: {
        scope: ReviewSafetyPolicyScope.Workspace,
        workspaceId: target.workspaceId,
      },
      rolloutMode: ReviewSafetyRolloutMode.Enabled,
    });
    expect((await resolveRunAuthorization(kit)).effectAllowed).toBe(true);
    const otherProvider =
      await kit.control.safetyResolver.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.RunAuthorization,
        target: {
          ...target,
          providerTasks: [
            {
              providerKind: ReviewProviderKind.ClaudeCode,
              taskKind: ReviewTaskKind.CodeReview,
            },
          ],
        },
      });
    expect(otherProvider.effectAllowed).toBe(false);
    expect(otherProvider.capabilityDecisions[0]?.selectorMatched).toBe(false);
  });

  it("hashes only required capability fences while global emergency fences every effect decision", async () => {
    const kit = createReviewRunControlTestKit();
    await openGlobalEmergency(kit);
    await putPolicy(kit, {
      expectedVersion: 0,
      scope: { scope: ReviewSafetyPolicyScope.Global },
      rolloutMode: ReviewSafetyRolloutMode.Enabled,
    });
    const first = await resolveRunAuthorization(kit);
    kit.clock.advance(15_000);
    const same = await resolveRunAuthorization(kit);
    expect(same.safetyDecisionHash).toBe(first.safetyDecisionHash);

    await kit.control.safetyControls.updateReviewSafetyPolicy({
      expectedVersion: 0,
      scope: { scope: ReviewSafetyPolicyScope.Global },
      capability: ReviewSafetyCapability.EvidenceWritesV2,
      rolloutMode: ReviewSafetyRolloutMode.Enabled,
      updatedBy: "operator",
    });
    expect((await resolveRunAuthorization(kit)).safetyDecisionHash).toBe(
      first.safetyDecisionHash,
    );

    await putPolicy(kit, {
      expectedVersion: 1,
      scope: { scope: ReviewSafetyPolicyScope.Global },
      rolloutMode: ReviewSafetyRolloutMode.Enabled,
    });
    const matchingChange = await resolveRunAuthorization(kit);
    expect(matchingChange.safetyDecisionHash).not.toBe(
      first.safetyDecisionHash,
    );

    await kit.control.safetyControls.setReviewSafetyEmergencyStop({
      expectedVersion: 1,
      scope: { scope: ReviewSafetyPolicyScope.Global },
      stopped: true,
      reason: "incident",
      updatedBy: "operator",
    });
    const stopped = await resolveRunAuthorization(kit);
    expect(stopped.effectAllowed).toBe(false);
    expect(stopped.safetyDecisionHash).not.toBe(
      matchingChange.safetyDecisionHash,
    );
  });

  it("negotiates investigation execution independently from legacy run authorization", async () => {
    const kit = createReviewRunControlTestKit();
    await openGlobalEmergency(kit);
    await putPolicy(kit, {
      expectedVersion: 0,
      scope: { scope: ReviewSafetyPolicyScope.Global },
      rolloutMode: ReviewSafetyRolloutMode.Enabled,
    });

    const disabled =
      await kit.control.safetyResolver.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.InvestigationExecution,
        target,
      });
    expect(disabled.effectAllowed).toBe(false);
    expect(disabled.capabilityDecisions).toMatchObject([
      {
        capability: ReviewSafetyCapability.ReviewInvestigationV1,
        effectiveMode: ReviewSafetyRolloutMode.Disabled,
      },
    ]);
    expect((await resolveRunAuthorization(kit)).effectAllowed).toBe(true);

    await kit.control.safetyControls.updateReviewSafetyPolicy({
      expectedVersion: 0,
      scope: { scope: ReviewSafetyPolicyScope.Global },
      capability: ReviewSafetyCapability.ReviewInvestigationV1,
      rolloutMode: ReviewSafetyRolloutMode.Shadow,
      updatedBy: "operator",
    });
    const shadow =
      await kit.control.safetyResolver.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.InvestigationExecution,
        target,
      });
    expect(shadow).toMatchObject({
      effectAllowed: false,
      shadow: true,
      capabilityDecisions: [
        {
          capability: ReviewSafetyCapability.ReviewInvestigationV1,
          effectiveMode: ReviewSafetyRolloutMode.Shadow,
        },
      ],
    });
    expect((await resolveRunAuthorization(kit)).effectAllowed).toBe(true);
  });
});

async function openGlobalEmergency(
  kit: ReturnType<typeof createReviewRunControlTestKit>,
) {
  return kit.control.safetyControls.setReviewSafetyEmergencyStop({
    expectedVersion: 0,
    scope: { scope: ReviewSafetyPolicyScope.Global },
    stopped: false,
    reason: "ready",
    updatedBy: "operator",
  });
}

async function putPolicy(
  kit: ReturnType<typeof createReviewRunControlTestKit>,
  input: {
    readonly expectedVersion: number;
    readonly scope:
      | { readonly scope: ReviewSafetyPolicyScope.Global }
      | {
          readonly scope: ReviewSafetyPolicyScope.Workspace;
          readonly workspaceId: string;
        }
      | {
          readonly scope: ReviewSafetyPolicyScope.Repository;
          readonly workspaceId: string;
          readonly repositoryConnectionId: string;
          readonly scmRepositoryIdentityId: string;
        };
    readonly rolloutMode: ReviewSafetyRolloutMode;
    readonly providerTaskSelectors?:
      | readonly {
          readonly providerKind: ReviewProviderKind;
          readonly taskKind: ReviewTaskKind;
        }[]
      | undefined;
  },
) {
  return kit.control.safetyControls.updateReviewSafetyPolicy({
    ...input,
    capability: ReviewSafetyCapability.RunAuthorizationV2,
    updatedBy: "operator",
  });
}

async function resolveRunAuthorization(
  kit: ReturnType<typeof createReviewRunControlTestKit>,
) {
  return kit.control.safetyResolver.resolveReviewSafetyPolicy({
    decisionKind: ReviewSafetyDecisionKind.RunAuthorization,
    target,
  });
}
