import { PostgresLeaseLock } from "@reviewrouter/platform-locks";
import { WorkflowGitHubFixture } from "./workflow-github-fixture";
import { OctokitWorkflowSetupGateway } from "../infrastructure/github/octokit-workflow-setup-gateway";
import { provisionReviewRouterWorkflow } from "../application/use-cases/provision-reviewrouter-workflow";
import { PrismaWorkflowProvisioningTarget } from "../infrastructure/prisma/prisma-workflow-provisioning-target";
import { provisionRepositoryReviewRouterWorkflow } from "../application/use-cases/provision-repository-reviewrouter-workflow";
import { assertDisposableWorkflowDatabase } from "./disposable-database";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import {
  PrismaRepositoryConnectionRepository,
  syncInstallationRepositories,
} from "@reviewrouter/features-repositories";
import { PrismaRepositoryHealthRepository } from "@reviewrouter/features-repo-health";
import { PrismaSupportDiagnosticsRepository } from "@reviewrouter/features-support-diagnostics";
import { PrismaWorkflowProvisioningRepository } from "../infrastructure/prisma/prisma-workflow-provisioning-repository";
import { PrismaWorkflowProvisioningStatusAuthority } from "../infrastructure/prisma/prisma-workflow-provisioning-status-authority";
import { PrismaWorkflowProvisioningQuery } from "../infrastructure/prisma/prisma-workflow-provisioning-query";
import { withDrainedTargetAuthorityPools } from "../../../../../scripts/lib/quiesced-target-authority";

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
    pullRequestHeadSha: "b".repeat(40),
  };
  const identity = {
    workspaceId,
    repositoryId,
    installationId,
    setupBranch: record.branch,
    pullRequestNumber: 7,
    baseBranch: "main",
    headSha: record.pullRequestHeadSha,
  };
  beforeAll(async () => {
    assertDisposableWorkflowDatabase(databaseUrl!);
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

  it("drains capture target authority pools while preserving the old writer fence before 000090", async () => {
    const guard = readFileSync(
      new URL(
        "../../../../platform/db/prisma/migrations/000089_workflow_provisioning_writer_quiescence/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const runtimeRole = `pr244_runtime_${randomUUID().replaceAll("-", "")}`;
    const runtimePassword = randomUUID();
    const roleUrl = new URL(databaseUrl!);
    roleUrl.username = runtimeRole;
    roleUrl.password = runtimePassword;
    const oldRuntime = createPrismaClient({
      databaseUrl: roleUrl.toString(),
      poolMax: 1,
    });
    const authorityRoles = ["permit", "receipt"].map(
      (kind) => `pr244_${kind}_${randomUUID().replaceAll("-", "")}`,
    );
    const authorityClients = authorityRoles.map((role) => {
      const url = new URL(roleUrl);
      url.username = role;
      return createPrismaClient({ databaseUrl: url.toString(), poolMax: 1 });
    });
    const targetAuthority = {
      permitInstallerPrisma: authorityClients[0]!,
      targetReceiptReaderPrisma: authorityClients[1]!,
    };
    await prisma.$executeRawUnsafe(
      `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}'`,
    );
    try {
      for (const role of authorityRoles) {
        await prisma.$executeRawUnsafe(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${runtimePassword}'`,
        );
      }
      await prisma.$executeRawUnsafe(
        `GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`,
      );
      await prisma.$executeRawUnsafe(
        `GRANT UPDATE ON "WorkflowProvisioning", "RepositoryConnection" TO "${runtimeRole}"`,
      );
      await expect(prisma.$executeRawUnsafe(guard)).rejects.toThrow(
        "workflow_provisioning_writer_quiescence_required",
      );
      await oldRuntime.$queryRaw`SELECT 1`;
      await prisma.$executeRawUnsafe(`ALTER ROLE "${runtimeRole}" NOLOGIN`);
      // These are real non-superuser target connections, as left by permit
      // installation and receipt reads before the canonical capture boundary.
      await Promise.all(
        authorityClients.map((client) => client.$queryRaw`SELECT 1`),
      );
      await expect(
        withDrainedTargetAuthorityPools(targetAuthority, () =>
          prisma.$executeRawUnsafe(guard),
        ),
      ).rejects.toThrow("workflow_provisioning_writer_quiescence_required");
      await expect(oldRuntime.$queryRaw`SELECT 1`).resolves.toBeDefined();
      await oldRuntime.$disconnect();
      await Promise.all(
        authorityClients.map((client) => client.$queryRaw`SELECT 1`),
      );
      // With only the authority pools open, the unchanged guard self-blocks.
      await expect(prisma.$executeRawUnsafe(guard)).rejects.toThrow(
        "workflow_provisioning_writer_quiescence_required",
      );
      await expect(
        withDrainedTargetAuthorityPools(targetAuthority, async () => {
          const sessions = await prisma.$queryRawUnsafe<
            Array<{ count: number }>
          >(
            `SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename IN ('${authorityRoles.join("','")}')`,
          );
          expect(sessions[0]?.count).toBe(0);
          return prisma.$executeRawUnsafe(guard);
        }),
      ).resolves.toBeDefined();
      // Verification reuses the same Prisma clients only after the boundary.
      await Promise.all(
        authorityClients.map((client) => client.$queryRaw`SELECT 1`),
      );
      await expect(prisma.$executeRawUnsafe(guard)).rejects.toThrow(
        "workflow_provisioning_writer_quiescence_required",
      );
    } finally {
      await Promise.all(authorityClients.map((client) => client.$disconnect()));
      for (const role of authorityRoles) {
        await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
      }
      await oldRuntime.$disconnect();
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${runtimeRole}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${runtimeRole}"`);
    }
  });

  async function open() {
    const writer = new PrismaWorkflowProvisioningRepository(prisma);
    const attempt = await writer.beginAttempt(record);
    await writer.markSetupPullRequestOpen({
      ...record,
      ...attempt,
      pullRequestUrl: "https://github.com/acme/widget/pull/7",
    });
    identity.setupBranch = attempt.branch;
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
  it("isolates remote writes after A pauses, expires, B finishes and A resumes", async () => {
    const remote = new WorkflowGitHubFixture();
    const entered = deferred();
    const resume = deferred();
    let paused = false;
    remote.beforeWrite = async () => {
      if (!paused) {
        paused = true;
        entered.resolve();
        await resume.promise;
      }
    };
    const lock = new PostgresLeaseLock(prisma);
    const key = `${prefix}:workflow-provision`;
    const writer = new PrismaWorkflowProvisioningRepository(prisma);
    const provision = (version: string) =>
      lock.withLock(key, 5 * 60_000, () =>
        provisionReviewRouterWorkflow(
          {
            workspaceId,
            installationId,
            repositoryId,
            owner: "acme",
            name: "widget",
            defaultBranch: "main",
            actionRef: `777genius/review-router@${version}`,
            apiUrl: "https://api.reviewrouter.test",
            runtimeConfigMode: "oidc",
            codexRotatingProviderInstanceId: "codex-rotating:123456",
          },
          {
            provisioning: writer,
            setupGateway: new OctokitWorkflowSetupGateway(remote),
          },
        ),
      );
    const older = provision("a".repeat(40));
    try {
      await Promise.race([
        entered.promise,
        older.then(() => {
          throw new Error("attempt_completed_before_write_pause");
        }),
      ]);
      await prisma.distributedLock.update({
        where: { key },
        data: { expiresAt: new Date(0) },
      });
      const newer = await provision("b".repeat(40));
      const before = await prisma.workflowProvisioning.findUniqueOrThrow({
        where: { repositoryId },
      });
      const intendedFiles = remote.commits.get(newer.headSha);
      expect([...intendedFiles!.values()].join("\n")).toContain(
        `@${"b".repeat(40)}`,
      );
      resume.resolve();
      const stale = await older;
      expect(stale.branch).not.toBe(newer.branch);
      expect(remote.branches.get(newer.branch)).toBe(newer.headSha);
      expect(remote.commits.get(newer.headSha)).toEqual(intendedFiles);
      expect(
        await prisma.workflowProvisioning.findUniqueOrThrow({
          where: { repositoryId },
        }),
      ).toEqual(before);
      const authority = new PrismaWorkflowProvisioningStatusAuthority(prisma);
      const merged = {
        ...identity,
        setupBranch: newer.branch,
        pullRequestNumber: newer.number,
        headSha: newer.headSha,
      };
      expect(
        await authority.markConfigured({ ...merged, headSha: stale.headSha }),
      ).toBe(false);
      expect(await authority.markConfigured(merged)).toBe(true);
      expect(
        await prisma.workflowProvisioning.findUniqueOrThrow({
          where: { repositoryId },
        }),
      ).toMatchObject({
        status: "configured",
        actionVersion: `777genius/review-router@${"b".repeat(40)}`,
        pullRequestHeadSha: newer.headSha,
      });
    } finally {
      resume.resolve();
      await older;
    }
  });

  it("atomically invalidates setup on two-workspace transfer and aligns every projection", async () => {
    const { writer, attempt } = await open();
    const sync = new PrismaRepositoryConnectionRepository(prisma);
    const input = {
      inventoryGeneration: await sync.beginInstallationInventory(),
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
  it("does not let an older I1 inventory reverse a concurrent I2 transfer", async () => {
    await prisma.repositoryConnection.update({
      where: { id: repositoryId },
      data: { workspaceId, installationId },
    });
    const sync = new PrismaRepositoryConnectionRepository(prisma);
    const entered = deferred();
    const resume = deferred();
    const snapshot = [
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
    ];
    const older = syncInstallationRepositories(githubId.toString(), {
      repositories: sync,
      // A deliberately fast I1 clock cannot overrule the database generation.
      clock: { now: () => new Date("2099-01-01") },
      github: {
        async listInstallationRepositories() {
          entered.resolve();
          await resume.promise;
          return snapshot;
        },
      },
    });
    await entered.promise;
    try {
      await syncInstallationRepositories((githubId + 1n).toString(), {
        repositories: sync,
        clock: { now: () => new Date("2026-01-01") },
        github: {
          async listInstallationRepositories() {
            return snapshot;
          },
        },
      });
      const destination = {
        ...record,
        workspaceId: otherWorkspaceId,
        installationId: otherInstallationId,
      };
      const attempt = await new PrismaWorkflowProvisioningRepository(
        prisma,
      ).beginAttempt(destination);
      await new PrismaWorkflowProvisioningStatusAuthority(
        prisma,
      ).confirmInstalledWorkflow({
        ...destination,
        expectedAttempt: attempt,
        baseBranch: "main",
      });
      const before = await prisma.workflowProvisioning.findUniqueOrThrow({
        where: { repositoryId },
      });
      const repositoryBefore =
        await prisma.repositoryConnection.findUniqueOrThrow({
          where: { id: repositoryId },
        });
      resume.resolve();
      expect(await older).toMatchObject({ upserted: 0, unselected: 0 });
      expect(
        await prisma.repositoryConnection.findUniqueOrThrow({
          where: { id: repositoryId },
        }),
      ).toEqual(repositoryBefore);
      expect(
        await prisma.workflowProvisioning.findUniqueOrThrow({
          where: { repositoryId },
        }),
      ).toEqual(before);
    } finally {
      resume.resolve();
      await older;
    }
  });

  it.each([
    { pauseAfterLookup: false, enabled: true },
    { pauseAfterLookup: true, enabled: true },
    { pauseAfterLookup: false, enabled: false },
    { pauseAfterLookup: true, enabled: false },
  ])(
    "keeps the authorized scope through a transfer interleaving: %j",
    async ({ pauseAfterLookup, enabled }) => {
      await prisma.repositoryConnection.update({
        where: { id: repositoryId },
        data: { workspaceId, installationId },
      });
      const target = new PrismaWorkflowProvisioningTarget(prisma);
      const writer = new PrismaWorkflowProvisioningRepository(prisma);
      const entered = deferred();
      const resume = deferred();
      const gateway = { createOrUpdateSetupPullRequest: vi.fn() };
      const oldRequest = provisionRepositoryReviewRouterWorkflow(
        {
          workspaceId,
          installationId,
          repositoryId,
          actionRef: "777genius/review-router@v1",
          apiUrl: "https://api.reviewrouter.test",
          runtimeConfigMode: "oidc",
        },
        {
          targets: {
            async findWorkflowProvisioningTarget(scope) {
              if (pauseAfterLookup) {
                const found =
                  await target.findWorkflowProvisioningTarget(scope);
                entered.resolve();
                await resume.promise;
                return found;
              }
              entered.resolve();
              await resume.promise;
              return target.findWorkflowProvisioningTarget(scope);
            },
          },
          setupGateway: gateway,
          provisioning: writer,
          enabled,
        },
      );
      const rejected = expect(oldRequest).rejects.toThrow(
        "repository_not_found",
      );
      await entered.promise;
      try {
        const sync = new PrismaRepositoryConnectionRepository(prisma);
        await sync.syncInstallationRepositories({
          inventoryGeneration: await sync.beginInstallationInventory(),
          githubInstallationId: (githubId + 1n).toString(),
          syncedAt: new Date(),
          repositories: [
            {
              githubRepositoryId: githubId.toString(),
              owner: "acme",
              name: "widget",
              fullName: "acme/widget",
              defaultBranch: "main",
              visibility: "private",
              archived: false,
              stargazersCount: 0,
            },
          ],
        });
        const destination = {
          ...record,
          workspaceId: otherWorkspaceId,
          installationId: otherInstallationId,
        };
        const current = await writer.beginAttempt(destination);
        await new PrismaWorkflowProvisioningStatusAuthority(
          prisma,
        ).confirmInstalledWorkflow({
          ...destination,
          expectedAttempt: current,
          baseBranch: "main",
        });
        const before = await prisma.workflowProvisioning.findUniqueOrThrow({
          where: { repositoryId },
        });
        resume.resolve();
        await rejected;
        expect(
          await prisma.workflowProvisioning.findUniqueOrThrow({
            where: { repositoryId },
          }),
        ).toEqual(before);
        expect(gateway.createOrUpdateSetupPullRequest).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await oldRequest.catch(() => undefined);
      }
    },
  );
  it("binds a transferred no-history placeholder and rejects recovery captured in the old scope", async () => {
    const transferredRepositoryId = `${prefix}-unbound`;
    const transferredGithubId = githubId + 2n;
    await prisma.repositoryConnection.create({
      data: {
        id: transferredRepositoryId,
        workspaceId,
        installationId,
        externalRepositoryId: transferredGithubId.toString(),
        githubRepositoryId: transferredGithubId,
        owner: "acme",
        name: "unbound",
        fullName: "acme/unbound",
        defaultBranch: "main",
        visibility: "private",
        setupStatus: "configured",
      },
    });
    const sync = new PrismaRepositoryConnectionRepository(prisma);
    const transfer = async (githubInstallationId: bigint) =>
      sync.syncInstallationRepositories({
        inventoryGeneration: await sync.beginInstallationInventory(),
        githubInstallationId: githubInstallationId.toString(),
        syncedAt: new Date(),
        repositories: [
          {
            githubRepositoryId: transferredGithubId.toString(),
            owner: "acme",
            name: "unbound",
            fullName: "acme/unbound",
            defaultBranch: "main",
            visibility: "private",
            archived: false,
            stargazersCount: 0,
          },
        ],
      });
    await transfer(githubId + 1n);
    const marker = await prisma.workflowProvisioning.findUniqueOrThrow({
      where: { repositoryId: transferredRepositoryId },
    });
    expect(marker).toMatchObject({
      status: "not_started",
      workflowPath: record.workflowPath,
      workflowStyle: "explicit",
      actionVersion: "",
      pullRequestUrl: null,
      pullRequestHeadSha: null,
    });
    const authority = new PrismaWorkflowProvisioningStatusAuthority(prisma);
    const installed = {
      ...record,
      repositoryId: transferredRepositoryId,
      workspaceId: otherWorkspaceId,
      installationId: otherInstallationId,
      workflowPath: ".github/workflows/reviewrouter.yml",
      baseBranch: "main",
      expectedAttempt: marker,
    };
    // A verification started in I2 completes after transfer back to I1.
    await transfer(githubId);
    const current = await prisma.workflowProvisioning.findUniqueOrThrow({
      where: { repositoryId: transferredRepositoryId },
    });
    await expect(authority.confirmInstalledWorkflow(installed)).rejects.toThrow(
      "workflow_provisioning_match_not_found",
    );
    expect(
      await prisma.workflowProvisioning.findUniqueOrThrow({
        where: { repositoryId: transferredRepositoryId },
      }),
    ).toEqual(current);
    await authority.confirmInstalledWorkflow({
      ...installed,
      workspaceId,
      installationId,
      expectedAttempt: current,
    });
    expect(
      await prisma.workflowProvisioning.findUniqueOrThrow({
        where: { repositoryId: transferredRepositoryId },
      }),
    ).toMatchObject({
      workspaceId,
      installationId,
      status: "configured",
      workflowPath: installed.workflowPath,
      workflowStyle: installed.workflowStyle,
      actionVersion: installed.actionVersion,
      pullRequestHeadSha: null,
      revision: current.revision + 1,
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
