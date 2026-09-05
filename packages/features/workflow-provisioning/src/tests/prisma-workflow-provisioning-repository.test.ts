import { describe, expect, it, vi } from "vitest";
import { PrismaRepositoryConnectionRepository } from "@reviewrouter/features-repositories";
import { projectRepositorySetupStatus } from "../domain/workflow-provisioning";
import { PrismaWorkflowProvisioningRepository } from "../infrastructure/prisma/prisma-workflow-provisioning-repository";
import { PrismaWorkflowProvisioningStatusAuthority } from "../infrastructure/prisma/prisma-workflow-provisioning-status-authority";
import {
  conflict,
  createProvisioningPrisma,
  identity,
  initialCandidate,
  record,
} from "./provisioning-prisma-fixture";

describe("provisioning attempt writers", () => {
  it("records the attempt before work, persists its PR and ignores stale failure/completion", async () => {
    const f = createProvisioningPrisma(null);
    const writer = new PrismaWorkflowProvisioningRepository(f.prisma as never);
    const authority = new PrismaWorkflowProvisioningStatusAuthority(
      f.prisma as never,
    );
    const attempt = await writer.beginAttempt(record);
    expect(f.current()?.status).toBe("not_started");
    await writer.markSetupPullRequestOpen({
      ...record,
      ...attempt,
      pullRequestUrl: initialCandidate.pullRequestUrl,
    });
    expect(
      await authority.markConfigured({
        ...identity,
        setupBranch: attempt.branch,
      }),
    ).toBe(true);
    await writer.markFailed({
      ...record,
      ...attempt,
      errorMessage: "late failure",
    });
    await writer.markSetupPullRequestOpen({
      ...record,
      ...attempt,
      pullRequestUrl: "https://github.com/acme/widget/pull/8",
    });
    expect(f.current()).toMatchObject({
      status: "configured",
      pullRequestUrl: initialCandidate.pullRequestUrl,
    });
  });
  it("permits an explicit new attempt and fences the previous one", async () => {
    const f = createProvisioningPrisma({
      ...initialCandidate,
      status: "configured",
    });
    const writer = new PrismaWorkflowProvisioningRepository(f.prisma as never);
    const first = await writer.beginAttempt(record);
    const second = await writer.beginAttempt(record);
    expect(first.attemptId).not.toBe(second.attemptId);
    await writer.markFailed({ ...record, ...first, errorMessage: "old" });
    expect(f.current()).toMatchObject({
      attemptId: second.attemptId,
      status: "not_started",
    });
    await writer.markFailed({ ...record, ...second, errorMessage: "new" });
    expect(f.current()).toMatchObject({
      status: "failed",
      errorMessage: "new",
    });
  });
  it("does not erase PR identity when auditing fails after opening", async () => {
    const f = createProvisioningPrisma(null);
    const writer = new PrismaWorkflowProvisioningRepository(f.prisma as never);
    const attempt = await writer.beginAttempt(record);
    await writer.markSetupPullRequestOpen({
      ...record,
      ...attempt,
      pullRequestUrl: initialCandidate.pullRequestUrl,
    });
    await writer.markFailed({
      ...record,
      ...attempt,
      pullRequestUrl: null,
      errorMessage: "audit error",
    });
    expect(f.current()).toMatchObject({
      status: "setup_pr_open",
      pullRequestUrl: initialCandidate.pullRequestUrl,
    });
  });
  it("re-reads after conflict and cannot regress a concurrent confirmation", async () => {
    const f = createProvisioningPrisma(null);
    const writer = new PrismaWorkflowProvisioningRepository(f.prisma as never);
    const attempt = await writer.beginAttempt(record);
    f.workflowProvisioning.updateMany.mockImplementationOnce(async () => {
      f.replace({
        ...f.current()!,
        status: "configured",
        revision: attempt.revision + 1,
        pullRequestUrl: initialCandidate.pullRequestUrl,
      });
      throw conflict();
    });
    await writer.markFailed({ ...record, ...attempt, errorMessage: "old" });
    expect(f.current()?.status).toBe("configured");
    expect(f.workflowProvisioning.findUnique).toHaveBeenCalledTimes(3);
  });
  it("rejects a stale workspace/installation after transfer", async () => {
    const f = createProvisioningPrisma(null);
    const writer = new PrismaWorkflowProvisioningRepository(f.prisma as never);
    const attempt = await writer.beginAttempt(record);
    f.transfer();
    await writer.markFailed({ ...record, ...attempt });
    expect(f.current()?.status).toBe("not_started");
    await expect(writer.beginAttempt(record)).rejects.toThrow(
      "repository_not_found",
    );
  });

  it.each([true, false])(
    "invalidates a two-workspace transfer and replays sync safely (existing authority: %s)",
    async (hasAuthority) => {
      const f = createProvisioningPrisma(
        hasAuthority ? { ...initialCandidate, status: "configured" } : null,
      );
      let repository = {
        id: record.repositoryId,
        workspaceId: record.workspaceId,
        installationId: record.installationId,
      };
      const destination = {
        id: "installation_2",
        workspaceId: "workspace_2",
      };
      const repositoryConnection = {
        ...f.repositoryConnection,
        findUnique: vi.fn(async () => ({ ...repository })),
        upsert: vi.fn(
          async ({ update }: { update: Omit<typeof repository, "id"> }) => {
            repository = {
              ...repository,
              workspaceId: update.workspaceId,
              installationId: update.installationId,
            };
            f.transfer();
            return { ...repository };
          },
        ),
        updateMany: vi.fn(async () => ({ count: 0 })),
      };
      const tx = {
        repositoryConnection,
        workflowProvisioning: f.workflowProvisioning,
      };
      f.prisma.$transaction.mockImplementation(async (work) => work(tx));
      const prisma = {
        ...f.prisma,
        repositoryConnection,
        gitHubInstallation: { findUnique: vi.fn(async () => destination) },
      };
      const sync = new PrismaRepositoryConnectionRepository(prisma as never);
      const input = {
        inventoryGeneration: 1n,
        githubInstallationId: "124",
        syncedAt: new Date("2026-09-05T00:00:00Z"),
        repositories: [
          {
            githubRepositoryId: "456",
            owner: "acme",
            name: "widget",
            fullName: "acme/widget",
            defaultBranch: "main",
            visibility: "private" as const,
            archived: false,
            stargazersCount: 0,
          },
        ],
      };
      await sync.syncInstallationRepositories(input);
      expect(repository).toEqual({
        id: record.repositoryId,
        workspaceId: destination.workspaceId,
        installationId: destination.id,
      });
      const transferred = { ...f.current()! };
      expect(transferred).toMatchObject({
        repositoryId: record.repositoryId,
        workspaceId: destination.workspaceId,
        installationId: destination.id,
        status: "not_started",
        pullRequestUrl: null,
        errorMessage: null,
      });
      if (hasAuthority)
        expect(transferred.attemptId).not.toBe(initialCandidate.attemptId);
      expect(
        projectRepositorySetupStatus({
          workflowProvisioningStatus: transferred.status,
          legacySetupStatus: "configured",
        }),
      ).toBe("not_configured");
      await new PrismaWorkflowProvisioningRepository(
        prisma as never,
      ).markFailed({
        ...record,
        ...initialCandidate,
        errorMessage: "old workspace callback",
      });
      expect(
        await new PrismaWorkflowProvisioningStatusAuthority(
          prisma as never,
        ).markConfigured(identity),
      ).toBe(false);
      await sync.syncInstallationRepositories(input);
      expect(f.current()).toEqual(transferred);
      expect(f.workflowProvisioning.create).toHaveBeenCalledTimes(
        hasAuthority ? 0 : 1,
      );
      expect(f.workflowProvisioning.updateMany).toHaveBeenCalledTimes(
        hasAuthority ? 1 : 0,
      );
      expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      });
    },
  );
});
