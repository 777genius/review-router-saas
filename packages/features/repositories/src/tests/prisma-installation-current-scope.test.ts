import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaRepositoryConnectionRepository } from "../infrastructure/prisma/prisma-repository-connection-repository";
import { PrismaGitHubInstallationRepository } from "../../../github-installations/src/infrastructure/prisma/prisma-github-installation-repository";

function fixture() {
  const events: string[] = [];
  const guarded = (name: string, value: unknown) =>
    vi.fn(async () => {
      events.push(name);
      return value;
    });
  const tx = {
    $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
      events.push("guard");
      expect(sql.text).toContain("pg_advisory_xact_lock(");
      expect(sql.values).toEqual([
        createHash("sha256")
          .update("review-current-scope-v1\0global")
          .digest("hex"),
      ]);
      return [{ locked: 1 }];
    }),
    gitHubInstallation: {
      findUnique: guarded("installation-read", {
        id: "installation",
        workspaceId: "destination",
      }),
      upsert: guarded("installation-upsert", {}),
      update: guarded("installation-remove", {}),
    },
    workspace: {
      update: guarded("workspace-update", {}),
      upsert: guarded("workspace-upsert", { id: "destination" }),
    },
    repositoryPermissionCache: {
      deleteMany: guarded("cache-delete", { count: 2 }),
    },
    repositoryConnection: {
      findUnique: guarded("repository-read", null),
      upsert: guarded("repository-upsert", { id: "repository" }),
      updateMany: guarded("unselect", { count: 2 }),
    },
    workflowProvisioning: {
      findUnique: guarded("provisioning-read", null),
      create: guarded("provisioning-create", {}),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      events.push("begin");
      // Each retry/unit gets an authentic distinct transaction lifetime.
      const value = await work({ ...tx });
      events.push("commit");
      return value;
    }),
  };
  return {
    events,
    tx,
    prisma,
    inventory: new PrismaRepositoryConnectionRepository(prisma as never),
    installations: new PrismaGitHubInstallationRepository(prisma as never),
  };
}
const snapshot = {
  githubInstallationId: "123",
  accountLogin: "test",
  accountType: "Organization",
  repositorySelection: "all",
  status: "active" as const,
};
const input = {
  githubInstallationId: "123",
  inventoryGeneration: 2n,
  syncedAt: new Date(),
  repositories: [
    {
      githubRepositoryId: "456",
      owner: "test",
      name: "repo",
      fullName: "test/repo",
      defaultBranch: "main",
      visibility: "private" as const,
      archived: false,
      stargazersCount: 0,
    },
  ],
};

describe("actual installation/inventory current-scope writers", () => {
  it("guards upsert before workspace discovery and cache invalidation, including absence", async () => {
    const f = fixture();
    f.tx.gitHubInstallation.findUnique.mockImplementation(async () => {
      f.events.push("installation-read");
      return null;
    });
    await f.installations.upsertInstallation(snapshot);
    expect(f.events).toEqual([
      "begin",
      "guard",
      "installation-read",
      "workspace-upsert",
      "installation-upsert",
      "cache-delete",
      "commit",
    ]);
  });
  it("guards existing installation updates before reads", async () => {
    const f = fixture();
    await f.installations.upsertInstallation(snapshot);
    expect(f.events).toEqual([
      "begin",
      "guard",
      "installation-read",
      "workspace-update",
      "installation-upsert",
      "cache-delete",
      "commit",
    ]);
  });
  it("keeps uninstall fanout and cache invalidation in the same guarded transaction", async () => {
    const f = fixture();
    await f.installations.markInstallationRemoved("123");
    expect(f.events).toEqual([
      "begin",
      "guard",
      "installation-read",
      "installation-remove",
      "unselect",
      "cache-delete",
      "commit",
    ]);
    expect(f.tx.repositoryConnection.updateMany).toHaveBeenCalledWith({
      where: { installationId: "installation" },
      data: { selected: false },
    });
  });
  it("guards missing uninstall and preserves its no-op", async () => {
    const f = fixture();
    f.tx.gitHubInstallation.findUnique.mockImplementation(async () => {
      f.events.push("installation-read");
      return null;
    });
    await f.installations.markInstallationRemoved("123");
    expect(f.events).toEqual(["begin", "guard", "installation-read", "commit"]);
  });
  it("guards insertion and trailing predicate unselection separately before any reads", async () => {
    const f = fixture();
    expect(await f.inventory.syncInstallationRepositories(input)).toMatchObject(
      { upserted: 1, unselected: 2 },
    );
    expect(f.events).toEqual([
      "begin",
      "guard",
      "installation-read",
      "repository-read",
      "repository-upsert",
      "commit",
      "begin",
      "guard",
      "installation-read",
      "unselect",
      "commit",
    ]);
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(f.tx.repositoryConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          installationId: "installation",
          inventoryGeneration: { lt: 2n },
          githubRepositoryId: { notIn: [456n] },
        },
      }),
    );
  });
  it("protects empty inventory unselection and rereads installation inside its transaction", async () => {
    const f = fixture();
    await f.inventory.syncInstallationRepositories({
      ...input,
      repositories: [],
    });
    expect(f.events).toEqual([
      "begin",
      "guard",
      "installation-read",
      "unselect",
      "commit",
    ]);
  });
  it("preserves inventory generation replay fence", async () => {
    const f = fixture();
    f.tx.repositoryConnection.findUnique.mockResolvedValue({
      id: "repository",
      inventoryGeneration: 2n,
    });
    expect(await f.inventory.syncInstallationRepositories(input)).toMatchObject(
      { upserted: 0 },
    );
    expect(f.tx.repositoryConnection.upsert).not.toHaveBeenCalled();
  });
  it("guards transfer plus provisioning invalidation before either workspace is touched", async () => {
    const f = fixture();
    f.tx.repositoryConnection.findUnique.mockImplementation(async () => {
      f.events.push("repository-read");
      return {
        id: "repository",
        inventoryGeneration: 1n,
        workspaceId: "old",
        installationId: "old-installation",
      };
    });
    await f.inventory.syncInstallationRepositories(input);
    expect(f.events.slice(0, 9)).toEqual([
      "begin",
      "guard",
      "installation-read",
      "repository-read",
      "repository-upsert",
      "provisioning-read",
      "provisioning-create",
      "commit",
      "begin",
    ]);
  });
  it("reacquires before retry reads after a serialization conflict", async () => {
    const f = fixture();
    f.tx.repositoryConnection.upsert.mockImplementationOnce(async () => {
      f.events.push("repository-upsert");
      throw new Prisma.PrismaClientKnownRequestError("retry", {
        code: "P2034",
        clientVersion: "7.8.0",
      });
    });
    await f.inventory.syncInstallationRepositories(input);
    expect(f.events.slice(0, 10)).toEqual([
      "begin",
      "guard",
      "installation-read",
      "repository-read",
      "repository-upsert",
      "begin",
      "guard",
      "installation-read",
      "repository-read",
      "repository-upsert",
    ]);
  });
  it.each(["upsert", "remove", "inventory", "empty"])(
    "guard failure stops %s before all reads and writes",
    async (kind) => {
      const f = fixture();
      f.tx.$queryRaw.mockRejectedValue(new Error("lock-failed"));
      const result =
        kind === "upsert"
          ? f.installations.upsertInstallation(snapshot)
          : kind === "remove"
            ? f.installations.markInstallationRemoved("123")
            : f.inventory.syncInstallationRepositories({
                ...input,
                repositories: kind === "empty" ? [] : input.repositories,
              });
      await expect(result).rejects.toThrow("lock-failed");
      expect(f.events).toEqual(["begin"]);
    },
  );
});
