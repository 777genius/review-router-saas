import { describe, expect, it, vi } from "vitest";
import {
  PrismaRepositoryConnectionRepository,
  syncInstallationRepositories,
} from "@reviewrouter/features-repositories";
import {
  createProvisioningPrisma,
  initialCandidate,
  record,
} from "./provisioning-prisma-fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("repository inventory ownership order", () => {
  it("ignores a delayed I1 snapshot after I2 transfers and configures the repository", async () => {
    const state = createProvisioningPrisma({
      ...initialCandidate,
      status: "configured",
    });
    let repository = {
      id: record.repositoryId,
      workspaceId: record.workspaceId,
      installationId: record.installationId,
      inventoryGeneration: 0n,
    };
    let generation = 0n;
    const repositoryConnection = {
      ...state.repositoryConnection,
      findUnique: vi.fn(async () => ({ ...repository })),
      upsert: vi.fn(async ({ update }: { update: typeof repository }) => {
        repository = { ...repository, ...update };
        return repository;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    const tx = {
      workflowProvisioning: state.workflowProvisioning,
      repositoryConnection,
    };
    const prisma = {
      ...state.prisma,
      repositoryConnection,
      $queryRaw: vi.fn(async () => [{ generation: ++generation }]),
      $transaction: async (work: (client: typeof tx) => Promise<unknown>) =>
        work(tx),
      gitHubInstallation: {
        findUnique: vi.fn(
          async ({ where }: { where: { githubInstallationId: bigint } }) =>
            where.githubInstallationId === 1n
              ? { id: record.installationId, workspaceId: record.workspaceId }
              : { id: "installation_2", workspaceId: "workspace_2" },
        ),
      },
    };
    const store = new PrismaRepositoryConnectionRepository(prisma as never);
    const fetched = deferred();
    const resume = deferred();
    const snapshot = [
      {
        githubRepositoryId: "123",
        owner: "acme",
        name: "widget",
        fullName: "acme/widget",
        defaultBranch: "main",
        visibility: "private" as const,
        archived: false,
        stargazersCount: 0,
      },
    ];
    const old = syncInstallationRepositories("1", {
      repositories: store,
      clock: { now: () => new Date("2099-01-01") },
      github: {
        async listInstallationRepositories() {
          fetched.resolve();
          await resume.promise;
          return snapshot;
        },
      },
    });
    await fetched.promise;
    try {
      await syncInstallationRepositories("2", {
        repositories: store,
        clock: { now: () => new Date("2026-01-01") },
        github: {
          async listInstallationRepositories() {
            return snapshot;
          },
        },
      });
      const configured = { ...state.current()!, status: "configured" as const };
      state.replace(configured);
      const before = { ...repository };
      resume.resolve();
      expect(await old).toMatchObject({ upserted: 0, unselected: 0 });
      expect(repository).toEqual(before);
      expect(state.current()).toEqual(configured);
      expect(repositoryConnection.upsert).toHaveBeenCalledTimes(1);
    } finally {
      resume.resolve();
      await old;
    }
  });
});
