import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { PrismaRepositoryConnectionRepository } from "@reviewrouter/features-repositories";
import { PrismaRepositoryHealthRepository } from "@reviewrouter/features-repo-health";
import { PrismaSupportDiagnosticsRepository } from "@reviewrouter/features-support-diagnostics";
import { PrismaWorkflowProvisioningRepository } from "../infrastructure/prisma/prisma-workflow-provisioning-repository";
import { PrismaWorkflowProvisioningStatusAuthority } from "../infrastructure/prisma/prisma-workflow-provisioning-status-authority";
import { PrismaWorkflowProvisioningQuery } from "../infrastructure/prisma/prisma-workflow-provisioning-query";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const withDatabase = databaseUrl ? describe : describe.skip;
withDatabase("WorkflowProvisioning PostgreSQL concurrency and transfer", () => {
  let prisma: PrismaClient;
  const prefix = `pr244-${randomUUID()}`;
  const workspaceId = `${prefix}-w1`;
  const otherWorkspaceId = `${prefix}-w2`;
  const repositoryId = `${prefix}-repo`;
  const installationId = `${prefix}-i1`;
  const otherInstallationId = `${prefix}-i2`;
  const githubId = BigInt(Date.now());
  const record = {
    workspaceId,
    repositoryId,
    installationId,
    status: "not_started" as const,
    branch: "reviewrouter/setup",
    workflowPath: ".github/workflows/reviewrouter-codex.yml",
    workflowStyle: "reusable" as const,
    actionVersion: "a".repeat(40),
  };
  const identity = {
    workspaceId,
    repositoryId,
    installationId,
    setupBranch: record.branch,
    pullRequestNumber: 7,
    baseBranch: "main",
  };
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      url.hostname !== "127.0.0.1" ||
      !url.pathname.startsWith("/reviewrouter_pr244_disposable")
    )
      throw new Error("disposable_loopback_database_required");
    prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 6 });
    for (const [id, slug] of [
      [workspaceId, `${prefix}-one`],
      [otherWorkspaceId, `${prefix}-two`],
    ] as const) {
      await prisma.workspace.create({ data: { id, slug, name: slug } });
    }
    for (const [id, workspace, githubInstallationId] of [
      [installationId, workspaceId, githubId],
      [otherInstallationId, otherWorkspaceId, githubId + 1n],
    ] as const) {
      await prisma.gitHubInstallation.create({
        data: {
          id,
          workspaceId: workspace,
          githubInstallationId,
          accountLogin: "acme",
          accountType: "Organization",
          repositorySelection: "all",
          status: "active",
        },
      });
    }
    await prisma.repositoryConnection.create({
      data: {
        id: repositoryId,
        workspaceId,
        installationId,
        externalRepositoryId: githubId.toString(),
        githubRepositoryId: githubId,
        owner: "acme",
        name: "widget",
        fullName: "acme/widget",
        defaultBranch: "main",
        visibility: "private",
        setupStatus: "configured",
      },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.workspace.deleteMany({
      where: { id: { in: [workspaceId, otherWorkspaceId] } },
    });
    await prisma.$disconnect();
  });
  it("migrates deterministic authority and invalidates pre-existing cross-workspace rows", async () => {
    const migration = readFileSync(
      new URL(
        "../../../../platform/db/prisma/migrations/000090_workflow_provisioning_attempt_authority/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("CREATE SCHEMA pr244_migration_test");
      await tx.$executeRawUnsafe(
        "SET LOCAL search_path = pr244_migration_test",
      );
      await tx.$executeRawUnsafe(
        `CREATE TYPE "WorkflowProvisioningStatus" AS ENUM ('not_started', 'setup_pr_open', 'configured', 'failed')`,
      );
      await tx.$executeRawUnsafe(
        `CREATE TABLE "RepositoryConnection" (id TEXT PRIMARY KEY, "workspaceId" TEXT, "installationId" TEXT)`,
      );
      await tx.$executeRawUnsafe(
        `CREATE TABLE "WorkflowProvisioning" (id TEXT PRIMARY KEY, "repositoryId" TEXT, "workspaceId" TEXT, branch TEXT, status "WorkflowProvisioningStatus", "pullRequestUrl" TEXT, "errorMessage" TEXT, "updatedAt" TIMESTAMP)`,
      );
      await tx.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "WorkflowProvisioning_repositoryId_branch_key" ON "WorkflowProvisioning" ("repositoryId", branch)`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "RepositoryConnection" VALUES ('r1', 'w1', 'i1'), ('r2', 'w2', 'i2')`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "WorkflowProvisioning" VALUES ('a', 'r1', 'w1', 'old', 'configured', 'old-pr', NULL, '2026-01-01'), ('z', 'r1', 'w1', 'new', 'failed', 'new-pr', 'closed', '2026-01-01'), ('transfer', 'r2', 'w1', 'setup', 'configured', 'old-tenant-pr', NULL, '2026-01-01')`,
      );
      for (const statement of migration.split(";").filter((sql) => sql.trim()))
        await tx.$executeRawUnsafe(statement);
      const rows = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          workspaceId: string;
          installationId: string;
          attemptId: string;
          revision: number;
          status: string;
          pullRequestUrl: string | null;
        }>
      >('SELECT * FROM "WorkflowProvisioning" ORDER BY id');
      expect(rows).toMatchObject([
        {
          id: "transfer",
          workspaceId: "w2",
          installationId: "i2",
          attemptId: "transfer",
          revision: 0,
          status: "not_started",
          pullRequestUrl: null,
        },
        {
          id: "z",
          workspaceId: "w1",
          installationId: "i1",
          attemptId: "z",
          revision: 0,
          status: "failed",
          pullRequestUrl: "new-pr",
        },
      ]);
      await tx.$executeRawUnsafe("DROP SCHEMA pr244_migration_test CASCADE");
    });
  });

  async function open() {
    const writer = new PrismaWorkflowProvisioningRepository(prisma);
    const attempt = await writer.beginAttempt(record);
    await writer.markSetupPullRequestOpen({
      ...record,
      ...attempt,
      pullRequestUrl: "https://github.com/acme/widget/pull/7",
    });
    return { writer, attempt };
  }
  it("retries real serializable failure/merge conflicts and converges on configured", async () => {
    await open();
    const race = concurrentReaders(prisma);
    const authority = new PrismaWorkflowProvisioningStatusAuthority(
      race.client,
    );
    const results = await Promise.allSettled([
      authority.markConfigured(identity),
      authority.markFailed({ ...identity, reason: "setup_pr_closed" }),
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: true });
    expect(
      (
        await prisma.workflowProvisioning.findUniqueOrThrow({
          where: { repositoryId },
        })
      ).status,
    ).toBe("configured");
    expect(race.conflicts()).toBeGreaterThan(0);
    expect(await authority.markConfigured(identity)).toBe(true);
  });
  it("replays concurrent duplicate merges idempotently", async () => {
    await open();
    const race = concurrentReaders(prisma);
    const authority = new PrismaWorkflowProvisioningStatusAuthority(
      race.client,
    );
    expect(
      await Promise.all([
        authority.markConfigured(identity),
        authority.markConfigured(identity),
      ]),
    ).toEqual([true, true]);
    expect(race.conflicts()).toBeGreaterThan(0);
  });
  it("protects configured from both late writers and fences an explicitly replaced attempt", async () => {
    const { writer, attempt } = await open();
    const authority = new PrismaWorkflowProvisioningStatusAuthority(prisma);
    await authority.markConfigured(identity);
    await Promise.all([
      writer.markFailed({ ...record, ...attempt, errorMessage: "late" }),
      writer.markSetupPullRequestOpen({
        ...record,
        ...attempt,
        pullRequestUrl: null,
      }),
    ]);
    expect(
      await prisma.workflowProvisioning.findUnique({ where: { repositoryId } }),
    ).toMatchObject({
      status: "configured",
      pullRequestUrl: "https://github.com/acme/widget/pull/7",
    });
    const next = await writer.beginAttempt(record);
    await writer.markFailed({
      ...record,
      ...next,
      errorMessage: "create failed",
    });
    expect(await authority.markConfigured(identity)).toBe(false);
    expect(
      await prisma.workflowProvisioning.findUnique({ where: { repositoryId } }),
    ).toMatchObject({
      attemptId: next.attemptId,
      status: "failed",
      pullRequestUrl: null,
    });
  });
  it("creates repository-scoped authority only from verified installed evidence", async () => {
    await prisma.workflowProvisioning.deleteMany({ where: { repositoryId } });
    const authority = new PrismaWorkflowProvisioningStatusAuthority(prisma);
    await authority.confirmInstalledWorkflow({
      ...record,
      baseBranch: "main",
      expectedAttempt: null,
    });
    const current = await prisma.workflowProvisioning.findUniqueOrThrow({
      where: { repositoryId },
    });
    expect(current.status).toBe("configured");
    await authority.confirmInstalledWorkflow({
      ...record,
      baseBranch: "main",
      expectedAttempt: current,
    });
    expect(
      await prisma.workflowProvisioning.count({ where: { repositoryId } }),
    ).toBe(1);
  });
  it("atomically invalidates setup on two-workspace transfer and aligns every projection", async () => {
    const { writer, attempt } = await open();
    const sync = new PrismaRepositoryConnectionRepository(prisma);
    const input = {
      githubInstallationId: (githubId + 1n).toString(),
      syncedAt: new Date(),
      repositories: [
        {
          githubRepositoryId: githubId.toString(),
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
    const transferred = await prisma.workflowProvisioning.findUniqueOrThrow({
      where: { repositoryId },
    });
    expect(transferred).toMatchObject({
      workspaceId: otherWorkspaceId,
      installationId: otherInstallationId,
      status: "not_started",
      pullRequestUrl: null,
    });
    expect(transferred.attemptId).not.toBe(attempt.attemptId);
    await writer.markFailed({ ...record, ...attempt });
    expect(
      await new PrismaWorkflowProvisioningStatusAuthority(
        prisma,
      ).markConfigured(identity),
    ).toBe(false);
    const query = new PrismaWorkflowProvisioningQuery(prisma);
    expect(
      await query.listLatestForRepositories({
        workspaceId,
        repositoryIds: [repositoryId],
      }),
    ).toEqual([]);
    expect(
      await query.listLatestForRepositories({
        workspaceId: otherWorkspaceId,
        repositoryIds: [repositoryId],
      }),
    ).toMatchObject([{ status: "not_started" }]);
    expect(
      await new PrismaRepositoryHealthRepository(
        prisma,
      ).listWorkspaceHealthInputs(otherWorkspaceId),
    ).toMatchObject([{ setupStatus: "not_configured" }]);
    const diagnostics = new PrismaSupportDiagnosticsRepository(prisma);
    expect(
      (await diagnostics.getWorkspaceDiagnosticsInput(workspaceId))
        ?.workflowProvisioning,
    ).toEqual([]);
    expect(
      await diagnostics.getWorkspaceDiagnosticsInput(otherWorkspaceId),
    ).toMatchObject({
      repositories: [{ setupStatus: "not_configured" }],
      workflowProvisioning: [{ status: "not_started" }],
    });
    await sync.syncInstallationRepositories(input);
    expect(
      (
        await prisma.workflowProvisioning.findUniqueOrThrow({
          where: { repositoryId },
        })
      ).attemptId,
    ).toBe(transferred.attemptId);
    // The transferred installation can recover only with fresh installed evidence.
    await new PrismaWorkflowProvisioningStatusAuthority(
      prisma,
    ).confirmInstalledWorkflow({
      ...record,
      workspaceId: otherWorkspaceId,
      installationId: otherInstallationId,
      baseBranch: "main",
      expectedAttempt: transferred,
    });
  });
});

/** Both transactions see the same source state before either writes. Errors are
 * real PostgreSQL/Prisma P2034 conflicts, observed without fabricating them. */
function concurrentReaders(prisma: PrismaClient) {
  let reads = 0;
  let conflicts = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = new Proxy(prisma, {
    get(target, property) {
      if (property !== "$transaction") return Reflect.get(target, property);
      return async (
        work: (tx: unknown) => Promise<unknown>,
        options: object,
      ) => {
        try {
          return await target.$transaction(
            async (tx) =>
              work(
                new Proxy(tx, {
                  get(transaction, key) {
                    if (key !== "workflowProvisioning")
                      return Reflect.get(transaction, key);
                    return new Proxy(transaction.workflowProvisioning, {
                      get(delegate, method) {
                        if (method !== "findFirst")
                          return Reflect.get(delegate, method);
                        return async (
                          args: Parameters<typeof delegate.findFirst>[0],
                        ) => {
                          const value = await delegate.findFirst(args);
                          if (++reads <= 2) {
                            if (reads === 2) release();
                            await barrier;
                          }
                          return value;
                        };
                      },
                    });
                  },
                }),
              ),
            options,
          );
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "P2034"
          )
            conflicts++;
          throw error;
        }
      };
    },
  });
  return { client, conflicts: () => conflicts };
}
