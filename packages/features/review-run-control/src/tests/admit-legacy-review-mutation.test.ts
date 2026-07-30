import { describe, expect, it, vi } from "vitest";
import { AdmitLegacyReviewMutation } from "../application/use-cases/admit-legacy-review-mutation";
import type { ReviewMutationAuthority } from "../domain/review-mutation-authority";
import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
} from "../domain/review-run-control-types";
import { ReviewMutationAuthorityWriteStatus } from "../application/ports/review-mutation-authority-ports";

const now = new Date("2026-07-30T12:00:00.000Z");

describe("AdmitLegacyReviewMutation", () => {
  it("persists V1 authority before admitting the first legacy capability", async () => {
    const initialize = vi.fn(async (authority: ReviewMutationAuthority) => ({
      status: ReviewMutationAuthorityWriteStatus.Created as const,
      authority,
    }));
    const admission = new AdmitLegacyReviewMutation({
      clock: { now: () => now },
      queries: { findReviewMutationAuthority: async () => null },
      commands: {
        initializeReviewMutationAuthority: initialize,
        compareAndSetReviewMutationAuthority: vi.fn(),
      },
    });

    const authority = await admission.admit({
      scmRepositoryIdentityId: "identity-1",
    });

    expect(authority).toMatchObject({
      scmRepositoryIdentityId: "identity-1",
      laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
      mode: ReviewMutationMode.V1Open,
      epoch: 0n,
    });
    expect(initialize).toHaveBeenCalledOnce();
  });

  it("returns the winning Direct V2 authority when initialization races", async () => {
    const directV2 = authority(ReviewMutationMode.V2Active);
    const admission = new AdmitLegacyReviewMutation({
      clock: { now: () => now },
      queries: { findReviewMutationAuthority: async () => null },
      commands: {
        initializeReviewMutationAuthority: async () => ({
          status: ReviewMutationAuthorityWriteStatus.Conflict,
          authority: directV2,
        }),
        compareAndSetReviewMutationAuthority: vi.fn(),
      },
    });

    await expect(
      admission.admit({ scmRepositoryIdentityId: "identity-1" }),
    ).resolves.toBe(directV2);
  });
});

function authority(mode: ReviewMutationMode): ReviewMutationAuthority {
  return {
    scmRepositoryIdentityId: "identity-1",
    laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
    version: 1,
    epoch: mode === ReviewMutationMode.V2Active ? 1n : 0n,
    mode,
    drainPolicyVersion: null,
    drainStartedAt: null,
    v1AdmissionClosedAt: null,
    drainNotBefore: null,
    managedWorkflowInventoryHash: null,
    activationSafetyDecisionHash: null,
    initializedAt: now,
    activatedAt: mode === ReviewMutationMode.V2Active ? now : null,
    pausedAt: null,
  };
}
