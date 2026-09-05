import { describe, expect, it } from "vitest";
import { PrismaWorkflowProvisioningStatusAuthority } from "../infrastructure/prisma/prisma-workflow-provisioning-status-authority";
import {
  conflict,
  createProvisioningPrisma,
  identity,
  initialCandidate,
  record,
} from "./provisioning-prisma-fixture";

function fixture(status = initialCandidate.status) {
  const state = createProvisioningPrisma({ ...initialCandidate, status });
  return {
    ...state,
    authority: new PrismaWorkflowProvisioningStatusAuthority(
      state.prisma as never,
    ),
  };
}

describe("setup authority", () => {
  it.each(["setup_pr_open", "failed"] as const)(
    "recovers %s and replays without another write",
    async (status) => {
      const f = fixture(status);
      expect(await f.authority.markConfigured(identity)).toBe(true);
      expect(await f.authority.markConfigured(identity)).toBe(true);
      expect(f.current()?.status).toBe("configured");
      expect(f.workflowProvisioning.updateMany).toHaveBeenCalledTimes(1);
      expect(f.workflowProvisioning.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            attemptId: "attempt_1",
            revision: 1,
            status,
            workspaceId: identity.workspaceId,
            installationId: identity.installationId,
            branch: identity.setupBranch,
            pullRequestUrl: initialCandidate.pullRequestUrl,
          }),
        }),
      );
    },
  );
  it("never matches a reused branch without current PR identity", async () => {
    const f = fixture("failed");
    f.replace({
      ...initialCandidate,
      status: "failed",
      attemptId: "new_attempt",
      pullRequestUrl: null,
    });
    expect(await f.authority.markConfigured(identity)).toBe(false);
    expect(f.workflowProvisioning.updateMany).not.toHaveBeenCalled();
  });
  it("rejects old PRs, wrong branches, other tenants and installations", async () => {
    const f = fixture();
    for (const change of [
      { pullRequestNumber: 8 },
      { headSha: "c".repeat(40) },
      { headSha: null },
      { setupBranch: "other" },
      { workspaceId: "workspace_2" },
      { installationId: "installation_2" },
    ]) {
      expect(await f.authority.markConfigured({ ...identity, ...change })).toBe(
        false,
      );
    }
    expect(f.workflowProvisioning.updateMany).not.toHaveBeenCalled();
  });
  it("rejects a wrong-base merge but accepts legitimate retargeting", async () => {
    const f = fixture("failed");
    f.replace({
      ...initialCandidate,
      status: "failed",
      errorMessage: "setup_pr_wrong_base_branch",
    });
    expect(
      await f.authority.markConfigured({ ...identity, baseBranch: "develop" }),
    ).toBe(false);
    expect(await f.authority.markConfigured(identity)).toBe(true);
  });
  it("rejects not_started and protects configured from failures", async () => {
    const f = fixture("not_started");
    expect(await f.authority.markConfigured(identity)).toBe(false);
    f.replace({ ...initialCandidate, status: "configured" });
    await expect(
      f.authority.markFailed({ ...identity, reason: "setup_pr_closed" }),
    ).rejects.toThrow("workflow_provisioning_already_configured");
  });
  it("re-reads a replacement attempt after a P2034 conflict", async () => {
    const f = fixture();
    f.workflowProvisioning.updateMany.mockImplementationOnce(async () => {
      f.replace({
        ...initialCandidate,
        attemptId: "new_attempt",
        pullRequestUrl: null,
        status: "failed",
      });
      throw conflict();
    });
    expect(await f.authority.markConfigured(identity)).toBe(false);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(f.workflowProvisioning.findFirst).toHaveBeenCalledTimes(2);
    expect(f.current()?.status).toBe("failed");
  });
  it("retries a concurrent failure then lets the matching merge win", async () => {
    const f = fixture();
    f.workflowProvisioning.updateMany.mockImplementationOnce(async () => {
      f.replace({ ...initialCandidate, status: "failed", revision: 2 });
      throw conflict();
    });
    expect(await f.authority.markConfigured(identity)).toBe(true);
    expect(f.current()?.status).toBe("configured");
  });
  it("bounds P2034 retries and never retries arbitrary errors", async () => {
    const f = fixture();
    f.prisma.$transaction.mockRejectedValue(conflict());
    await expect(f.authority.markConfigured(identity)).rejects.toMatchObject({
      code: "P2034",
    });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(3);
    f.prisma.$transaction
      .mockClear()
      .mockRejectedValue(new Error("database unavailable"));
    await expect(f.authority.markConfigured(identity)).rejects.toThrow(
      "database unavailable",
    );
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it("bootstraps verified installed evidence without PR identity", async () => {
    const state = createProvisioningPrisma(null);
    const authority = new PrismaWorkflowProvisioningStatusAuthority(
      state.prisma as never,
    );
    await authority.confirmInstalledWorkflow({
      ...record,
      baseBranch: "main",
      expectedAttempt: null,
    });
    expect(state.current()).toMatchObject({
      status: "configured",
      pullRequestUrl: null,
    });
    await authority.confirmInstalledWorkflow({
      ...record,
      baseBranch: "main",
      expectedAttempt: null,
    });
    const current = state.current()!;
    await authority.confirmInstalledWorkflow({
      ...record,
      baseBranch: "main",
      expectedAttempt: current,
    });
    expect(state.workflowProvisioning.create).toHaveBeenCalledTimes(1);
  });
  it("fences installed evidence obtained before a newer attempt or transfer", async () => {
    const f = fixture("failed");
    await expect(
      f.authority.confirmInstalledWorkflow({
        ...record,
        baseBranch: "main",
        expectedAttempt: null,
      }),
    ).rejects.toThrow("workflow_provisioning_match_not_found");
    await expect(
      f.authority.confirmInstalledWorkflow({
        ...record,
        baseBranch: "main",
        expectedAttempt: { attemptId: "older", revision: 1 },
      }),
    ).rejects.toThrow("workflow_provisioning_match_not_found");
    f.transfer();
    await expect(
      f.authority.confirmInstalledWorkflow({
        ...record,
        baseBranch: "main",
        expectedAttempt: initialCandidate,
      }),
    ).rejects.toThrow("workflow_provisioning_match_not_found");
  });
  it.each([
    { workflowPath: ".github/workflows/another.yml" },
    { workflowStyle: "explicit" as const },
    { actionVersion: "b".repeat(40) },
  ])(
    "rejects installed evidence for a different artifact: %j",
    async (change) => {
      for (const status of [
        "not_started",
        "setup_pr_open",
        "failed",
        "configured",
      ] as const) {
        const f = fixture(status);
        await expect(
          f.authority.confirmInstalledWorkflow({
            ...record,
            ...change,
            baseBranch: "main",
            expectedAttempt: initialCandidate,
          }),
        ).rejects.toThrow("workflow_provisioning_match_not_found");
        expect(f.current()?.status).toBe(status);
        expect(f.workflowProvisioning.updateMany).not.toHaveBeenCalled();
      }
    },
  );
  it("recovers failed attempts with no recorded PR only from installed evidence", async () => {
    const f = fixture("failed");
    const current = {
      ...initialCandidate,
      status: "failed" as const,
      pullRequestUrl: null,
    };
    f.replace(current);
    await expect(
      f.authority.confirmInstalledWorkflow({
        ...record,
        baseBranch: "develop",
        expectedAttempt: current,
      }),
    ).rejects.toThrow("workflow_provisioning_match_not_found");
    await f.authority.confirmInstalledWorkflow({
      ...record,
      baseBranch: "main",
      expectedAttempt: current,
    });
    expect(f.current()?.status).toBe("configured");
  });
});
