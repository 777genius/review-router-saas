import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { PrismaCodexRotatingOAuthRepository } from "../../../../packages/features/action-control-plane/src/infrastructure/prisma/prisma-codex-rotating-oauth-repository";
import {
  codexRotatingSetupRecoveryAcknowledgement,
  recoverCodexRotatingSetup,
} from "@reviewrouter/features-provider-setup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CodexRotatingSetupManifestStatus,
  confirmCodexRotatingSetupManifest,
  issueCodexRotatingSetupCommand,
  resolveCodexRotatingSetupManifestForNonce,
} from "./codex-rotating-setup-manifest";
import { PrismaCodexRotatingSetupRecovery } from "./prisma-codex-rotating-setup-recovery";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describe("Codex rotating setup schema guard", () => {
  it("keeps one active setup manifest per provider", () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../packages/platform/db/prisma/migrations/000060_codex_oauth_setup_serialization/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(migration).toContain(
      'CREATE UNIQUE INDEX "CodexOAuthSetupManifest_one_active_provider_key"',
    );
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
    expect(migration).toContain("SET LOCAL statement_timeout = '5min';");
    expect(migration).toContain(
      'LOCK TABLE "CodexOAuthSetupManifest" IN ACCESS EXCLUSIVE MODE;',
    );
    expect(migration).toContain('ADD COLUMN "confirmationJson" JSONB;');
    expect(migration).toContain("WHERE \"status\" = 'issued'");
    expect(migration).not.toContain(
      "SET \"status\" = 'expired'\nWHERE \"status\" IN ('issued', 'fetched')",
    );
    expect(migration).toContain(
      'ON "CodexOAuthSetupManifest"("providerInstanceRowId")',
    );
    expect(migration).toContain("WHERE \"status\" IN ('issued', 'fetched')");
    expect(migration).toContain("COMMIT;");
  });
});

describeDatabase("Codex rotating setup serialization", () => {
  let prisma: PrismaClient;
  let concurrentPrisma: readonly [PrismaClient, PrismaClient];
  const suffix = randomUUID();
  const workspaceId = `codex-setup-workspace-${suffix}`;
  const repositoryId = `codex-setup-repository-${suffix}`;
  const installationId = `codex-setup-installation-${suffix}`;
  const githubInstallationId = BigInt(`${Date.now()}991`);
  const githubRepositoryId = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
  const repositoryFullName = "777genius/review-router-saas-e2e";
  const installer = {
    url: "https://reviewrouter.site/install/codex-rotating",
    version: "serialization-test",
    sha256: "a".repeat(64),
  } as const;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl! });
    concurrentPrisma = [
      createPrismaClient({ databaseUrl: databaseUrl! }),
      createPrismaClient({ databaseUrl: databaseUrl! }),
    ];
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `codex-setup-${suffix}`,
        name: "Codex setup serialization test",
      },
    });
    await prisma.gitHubInstallation.create({
      data: {
        id: installationId,
        workspaceId,
        githubInstallationId,
        accountLogin: "777genius",
        accountType: "Organization",
        repositorySelection: "selected",
      },
    });
    await prisma.repositoryConnection.create({
      data: {
        id: repositoryId,
        workspaceId,
        provider: "github",
        externalRepositoryId: githubRepositoryId,
        githubRepositoryId: BigInt(githubRepositoryId),
        installationId,
        owner: "777genius",
        name: "review-router-saas-e2e",
        fullName: repositoryFullName,
        defaultBranch: "main",
        visibility: "private",
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await Promise.all(concurrentPrisma.map((client) => client.$disconnect()));
    await prisma.$disconnect();
  });

  it("serializes separate-client runtime races and setup versus runtime ownership", async () => {
    const raceRepositoryId = `codex-fence-repository-${randomUUID()}`;
    const raceGithubRepositoryId = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
    const fullName = "777genius/review-router-provider-fence";
    await prisma.repositoryConnection.create({
      data: {
        id: raceRepositoryId,
        workspaceId,
        provider: "github",
        externalRepositoryId: raceGithubRepositoryId,
        githubRepositoryId: BigInt(raceGithubRepositoryId),
        installationId,
        owner: "777genius",
        name: "review-router-provider-fence",
        fullName,
        defaultBranch: "main",
        visibility: "private",
      },
    });
    const context = {
      workspaceId,
      repositoryId: raceRepositoryId,
      githubRepositoryId: raceGithubRepositoryId,
      githubInstallationId: githubInstallationId.toString(),
      fullName,
      owner: "777genius",
      selected: true,
      installationStatus: "active" as const,
    };
    const providerInstanceId = `codex-rotating:${raceGithubRepositoryId}`;
    const createRepository = (client: PrismaClient) =>
      new PrismaCodexRotatingOAuthRepository(client, {
        actionOwnerRepo: "777genius/review-router",
      });
    const firstRepository = createRepository(concurrentPrisma[0]);
    const secondRepository = createRepository(concurrentPrisma[1]);

    try {
      await firstRepository.ensureVerifiedProviderBinding({
        repository: context,
        binding: {
          providerInstanceId,
          repositoryFullName: fullName,
          githubRepositoryId: raceGithubRepositoryId,
          actionRef: `777genius/review-router@${"a".repeat(40)}`,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 2,
        },
      });
      const legacyIdentityRace = await Promise.allSettled([
        prisma.$executeRawUnsafe(
          'UPDATE "CodexOAuthProviderInstance" SET "providerInstanceId" = $1 WHERE "providerInstanceId" = $2',
          "codex-rotating:999999999",
          providerInstanceId,
        ),
        secondRepository.ensureVerifiedProviderBinding({
          repository: context,
          binding: {
            providerInstanceId,
            repositoryFullName: fullName,
            githubRepositoryId: raceGithubRepositoryId,
            actionRef: `777genius/review-router@${"c".repeat(40)}`,
            workflowPath: ".github/workflows/reviewrouter-codex.yml",
            workflowSchemaVersion: 2,
          },
        }),
      ]);
      expect(legacyIdentityRace[0]!.status).toBe("rejected");
      expect(legacyIdentityRace[1]!.status).toBe("fulfilled");

      const runtimeNow = new Date("2026-06-01T12:00:00.000Z");
      const runtimeRace = await Promise.all([
        firstRepository.acquirePrelease({
          repository: context,
          providerInstanceId,
          githubRunId: "runtime-race-a",
          githubRunAttempt: "1",
          now: runtimeNow,
        }),
        secondRepository.acquirePrelease({
          repository: context,
          providerInstanceId,
          githubRunId: "runtime-race-b",
          githubRunAttempt: "1",
          now: runtimeNow,
        }),
      ]);
      expect(runtimeRace.map((result) => result.status).sort()).toEqual([
        "conflict",
        "preleased",
      ]);
      const runtimeWinner = runtimeRace.find(
        (result) => result.status === "preleased",
      )!;
      const finalized = await firstRepository.finalizeLease({
        leaseId: runtimeWinner.leaseId,
        providerInstanceId,
        restoredGenerationHash: "restored-generation-hash",
        now: runtimeNow,
      });
      await firstRepository.preflightWriteback({
        leaseId: runtimeWinner.leaseId,
        providerInstanceId,
        githubKeyId: "github-key",
        now: runtimeNow,
      });
      const writebackPreparation = {
        request: {
          protocolVersion: 1,
          leaseId: runtimeWinner.leaseId,
          providerInstanceId,
          generation: finalized.nextGeneration,
          latestGenerationHash: "latest-generation-hash-value-0123456789",
          encryptedValue: Buffer.from("ciphertext").toString("base64"),
          keyId: "github-key",
          idempotencyKey: "pending-after-expiry",
        },
        encryptedPayloadDigest: "encrypted-payload-digest",
        now: runtimeNow,
      } as const;
      const writebackRace = await Promise.all([
        firstRepository.prepareEncryptedWriteback(writebackPreparation),
        secondRepository.prepareEncryptedWriteback(writebackPreparation),
      ]);
      expect(writebackRace.map((result) => result.status).sort()).toEqual([
        "ready",
        "writeback_recovery_required",
      ]);
      await expect(
        prisma.codexOAuthWritebackIntent.findMany({
          where: {
            providerInstanceId,
            idempotencyKey: "pending-after-expiry",
          },
          select: { status: true, safeErrorCode: true },
        }),
      ).resolves.toEqual([
        { status: "pending", safeErrorCode: "runtime_write_claim_v1" },
      ]);
      await expect(
        issueCodexRotatingSetupCommand({
          prisma: concurrentPrisma[0],
          workspaceId,
          repositoryId: raceRepositoryId,
          repositoryFullName: fullName,
          githubRepositoryId: raceGithubRepositoryId,
          installer,
          setupManifestUrl:
            "https://reviewrouter.site/api/codex-rotating/setup-manifest",
          setupConfirmUrl:
            "https://reviewrouter.site/api/codex-rotating/setup-confirm",
          now: new Date(runtimeNow.getTime() + 60 * 60 * 1000),
        }),
      ).rejects.toThrow("codex_rotating_mutation_fence_conflict");

      await prisma.codexOAuthLease.deleteMany({
        where: { repositoryId: raceRepositoryId },
      });
      await prisma.codexOAuthProviderInstance.update({
        where: { providerInstanceId },
        data: {
          state: "setup_pending",
          activeLeaseId: null,
          activeLeaseExpiresAt: null,
          mutationEpoch: { increment: 1 },
          mutationOwner: "recovery",
          mutationOwnerId: "test-reset",
        },
      });
      await prisma.codexOAuthProviderInstance.delete({
        where: { providerInstanceId },
      });
      await firstRepository.ensureVerifiedProviderBinding({
        repository: context,
        binding: {
          providerInstanceId,
          repositoryFullName: fullName,
          githubRepositoryId: raceGithubRepositoryId,
          actionRef: `777genius/review-router@${"b".repeat(40)}`,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 2,
        },
      });

      const setupRuntimeRace = await Promise.allSettled([
        issueCodexRotatingSetupCommand({
          prisma: concurrentPrisma[0],
          workspaceId,
          repositoryId: raceRepositoryId,
          repositoryFullName: fullName,
          githubRepositoryId: raceGithubRepositoryId,
          installer,
          setupManifestUrl:
            "https://reviewrouter.site/api/codex-rotating/setup-manifest",
          setupConfirmUrl:
            "https://reviewrouter.site/api/codex-rotating/setup-confirm",
        }),
        secondRepository.acquirePrelease({
          repository: context,
          providerInstanceId,
          githubRunId: "setup-runtime-race",
          githubRunAttempt: "1",
          now: new Date(),
        }),
      ]);
      expect(
        setupRuntimeRace.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);

      await prisma.codexOAuthProviderInstance.deleteMany({
        where: { repositoryId: raceRepositoryId },
      });
      const fetchedAt = new Date("2026-06-02T12:00:00.000Z");
      const fetchedSetup = await issueCodexRotatingSetupCommand({
        prisma: concurrentPrisma[0],
        workspaceId,
        repositoryId: raceRepositoryId,
        repositoryFullName: fullName,
        githubRepositoryId: raceGithubRepositoryId,
        installer,
        setupManifestUrl:
          "https://reviewrouter.site/api/codex-rotating/setup-manifest",
        setupConfirmUrl:
          "https://reviewrouter.site/api/codex-rotating/setup-confirm",
        now: fetchedAt,
      });
      const fetchedManifest =
        await prisma.codexOAuthSetupManifest.findFirstOrThrow({
          where: { providerInstanceId: fetchedSetup.providerInstanceId },
          select: { setupNonce: true },
        });
      await withRotatingRepositoryAllowed(
        () =>
          resolveCodexRotatingSetupManifestForNonce({
            prisma: concurrentPrisma[0],
            setupNonce: fetchedManifest.setupNonce,
            now: new Date(fetchedAt.getTime() + 1_000),
          }),
        fullName,
      );
      await expect(
        secondRepository.acquirePrelease({
          repository: context,
          providerInstanceId,
          githubRunId: "runtime-after-fetched-expiry",
          githubRunAttempt: "1",
          now: new Date(fetchedAt.getTime() + 60 * 60 * 1000),
        }),
      ).rejects.toThrow("codex_rotating_mutation_fence_conflict");
    } finally {
      await prisma.repositoryConnection.delete({
        where: { id: raceRepositoryId },
      });
    }
  });

  it("reuses one issued manifest, fences fetched setup, and advances only confirmed generations", async () => {
    const issue = () =>
      issueCodexRotatingSetupCommand({
        prisma,
        workspaceId,
        repositoryId,
        repositoryFullName,
        githubRepositoryId,
        installer,
        setupManifestUrl:
          "https://reviewrouter.site/api/codex-rotating/setup-manifest",
        setupConfirmUrl:
          "https://reviewrouter.site/api/codex-rotating/setup-confirm",
      });

    const [first, duplicate] = await Promise.all([issue(), issue()]);
    expect(duplicate.command).toBe(first.command);

    const active = await prisma.codexOAuthSetupManifest.findMany({
      where: {
        repositoryId,
        status: {
          in: [
            CodexRotatingSetupManifestStatus.Issued,
            CodexRotatingSetupManifestStatus.Fetched,
          ],
        },
      },
      select: { setupNonce: true, status: true },
    });
    expect(active).toHaveLength(1);
    const firstNonce = active[0]!.setupNonce;

    const fetches = await withRotatingRepositoryAllowed(() =>
      Promise.allSettled(
        concurrentPrisma.map((client) =>
          resolveCodexRotatingSetupManifestForNonce({
            prisma: client,
            setupNonce: firstNonce,
          }),
        ),
      ),
    );
    expect(
      fetches.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failedFetches = fetches.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(failedFetches).toHaveLength(1);
    expect(failedFetches[0]!.reason).toEqual(
      expect.objectContaining({
        message: "codex_rotating_setup_manifest_reused",
      }),
    );
    await expect(issue()).rejects.toThrow(
      "codex_rotating_setup_recovery_required",
    );

    const firstConfirmation = confirmation(
      firstNonce,
      githubRepositoryId,
      "a".repeat(43),
    );
    const confirms = await withRotatingRepositoryAllowed(() =>
      Promise.all(
        concurrentPrisma.map((client) =>
          confirmCodexRotatingSetupManifest({
            prisma: client,
            payload: firstConfirmation,
          }),
        ),
      ),
    );
    expect(confirms).toEqual([{ status: "accepted" }, { status: "accepted" }]);
    await expect(
      withRotatingRepositoryDisabled(() =>
        confirmCodexRotatingSetupManifest({
          prisma,
          payload: firstConfirmation,
        }),
      ),
    ).resolves.toEqual({ status: "accepted" });
    await expect(
      withRotatingRepositoryDisabled(() =>
        confirmCodexRotatingSetupManifest({
          prisma,
          payload: {
            ...firstConfirmation,
            generationHash: "d".repeat(43),
          },
        }),
      ),
    ).rejects.toThrow("codex_rotating_setup_confirmation_mismatch");
    await expect(
      withRotatingRepositoryAllowed(() =>
        confirmCodexRotatingSetupManifest({
          prisma,
          payload: {
            ...firstConfirmation,
            accountFingerprint: "e".repeat(43),
          },
        }),
      ),
    ).rejects.toThrow("codex_rotating_setup_confirmation_mismatch");
    await expect(
      prisma.codexOAuthProviderInstance.findUniqueOrThrow({
        where: { providerInstanceId: `codex-rotating:${githubRepositoryId}` },
        select: { latestGeneration: true, latestGenerationHash: true },
      }),
    ).resolves.toEqual({
      latestGeneration: 1,
      latestGenerationHash: "a".repeat(43),
    });

    const next = await issue();
    expect(next.command).not.toBe(first.command);
    const nextManifest = await prisma.codexOAuthSetupManifest.findFirstOrThrow({
      where: {
        repositoryId,
        status: CodexRotatingSetupManifestStatus.Issued,
      },
      select: { setupNonce: true },
    });
    await withRotatingRepositoryAllowed(() =>
      resolveCodexRotatingSetupManifestForNonce({
        prisma,
        setupNonce: nextManifest.setupNonce,
      }),
    );
    await withRotatingRepositoryAllowed(() =>
      confirmCodexRotatingSetupManifest({
        prisma,
        payload: confirmation(
          nextManifest.setupNonce,
          githubRepositoryId,
          "b".repeat(43),
        ),
      }),
    );

    await expect(
      withRotatingRepositoryAllowed(() =>
        confirmCodexRotatingSetupManifest({
          prisma,
          payload: confirmation(firstNonce, githubRepositoryId, "c".repeat(43)),
        }),
      ),
    ).rejects.toThrow("codex_rotating_setup_confirmation_mismatch");
    await expect(
      prisma.codexOAuthProviderInstance.findUniqueOrThrow({
        where: { providerInstanceId: `codex-rotating:${githubRepositoryId}` },
        select: { latestGeneration: true, latestGenerationHash: true },
      }),
    ).resolves.toEqual({
      latestGeneration: 2,
      latestGenerationHash: "b".repeat(43),
    });

    const malformed = await issue();
    const malformedRow = await prisma.codexOAuthSetupManifest.findFirstOrThrow({
      where: {
        repositoryId,
        status: CodexRotatingSetupManifestStatus.Issued,
      },
      select: { id: true },
    });
    await prisma.codexOAuthSetupManifest.update({
      where: { id: malformedRow.id },
      data: { manifestJson: { protocolVersion: 999 } },
    });

    const recovered = await issue();

    expect(recovered.command).not.toBe(malformed.command);
    await expect(
      prisma.codexOAuthSetupManifest.findUniqueOrThrow({
        where: { id: malformedRow.id },
        select: { status: true },
      }),
    ).resolves.toEqual({
      status: CodexRotatingSetupManifestStatus.Superseded,
    });

    const incompatibleRow =
      await prisma.codexOAuthSetupManifest.findFirstOrThrow({
        where: {
          repositoryId,
          status: CodexRotatingSetupManifestStatus.Issued,
        },
        select: { id: true },
      });
    await prisma.$executeRaw`
      UPDATE "CodexOAuthSetupManifest"
      SET "manifestJson" = jsonb_set(
        "manifestJson",
        '{installer,version}',
        '"incompatible"'::jsonb
      )
      WHERE "id" = ${incompatibleRow.id}
    `;

    const compatible = await issue();

    expect(compatible.command).not.toBe(recovered.command);
    await expect(
      prisma.codexOAuthSetupManifest.findUniqueOrThrow({
        where: { id: incompatibleRow.id },
        select: { status: true },
      }),
    ).resolves.toEqual({
      status: CodexRotatingSetupManifestStatus.Superseded,
    });

    let releaseHeldLock!: () => void;
    let reportHeldLock!: () => void;
    const heldLockReady = new Promise<void>((resolve) => {
      reportHeldLock = resolve;
    });
    const heldLockRelease = new Promise<void>((resolve) => {
      releaseHeldLock = resolve;
    });
    const providerInstanceId = `codex-rotating:${githubRepositoryId}`;
    const heldLock = concurrentPrisma[0].$transaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`codex-rotating-setup:${providerInstanceId}`}, 0)
          )
        `;
        reportHeldLock();
        await heldLockRelease;
      },
      { timeout: 10_000 },
    );
    await heldLockReady;
    const lockAttemptStartedAt = Date.now();
    try {
      await expect(
        issueCodexRotatingSetupCommand({
          prisma: concurrentPrisma[1],
          workspaceId,
          repositoryId,
          repositoryFullName,
          githubRepositoryId,
          installer,
          setupManifestUrl:
            "https://reviewrouter.site/api/codex-rotating/setup-manifest",
          setupConfirmUrl:
            "https://reviewrouter.site/api/codex-rotating/setup-confirm",
        }),
      ).rejects.toThrow("codex_rotating_setup_lock_failed");
      expect(Date.now() - lockAttemptStartedAt).toBeGreaterThanOrEqual(4_500);
      expect(Date.now() - lockAttemptStartedAt).toBeLessThan(7_500);
    } finally {
      releaseHeldLock();
      await heldLock;
    }
  });

  it("explicitly recovers fetched setup once, pins its epoch, and redacts the audit", async () => {
    const recoveryRepositoryId = `codex-recovery-repository-${randomUUID()}`;
    const recoveryGithubRepositoryId = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
    const recoveryFullName = "777genius/review-router-recovery-proof";
    await prisma.repositoryConnection.create({
      data: {
        id: recoveryRepositoryId,
        workspaceId,
        provider: "github",
        externalRepositoryId: recoveryGithubRepositoryId,
        githubRepositoryId: BigInt(recoveryGithubRepositoryId),
        installationId,
        owner: "777genius",
        name: "review-router-recovery-proof",
        fullName: recoveryFullName,
        defaultBranch: "main",
        visibility: "private",
      },
    });
    try {
      const original = await issueCodexRotatingSetupCommand({
        prisma,
        workspaceId,
        repositoryId: recoveryRepositoryId,
        repositoryFullName: recoveryFullName,
        githubRepositoryId: recoveryGithubRepositoryId,
        installer,
        setupManifestUrl:
          "https://reviewrouter.site/api/codex-rotating/setup-manifest",
        setupConfirmUrl:
          "https://reviewrouter.site/api/codex-rotating/setup-confirm",
      });
      const originalManifest =
        await prisma.codexOAuthSetupManifest.findFirstOrThrow({
          where: {
            providerInstanceId: original.providerInstanceId,
            status: "issued",
          },
          select: { setupNonce: true },
        });
      await withRotatingRepositoryAllowed(
        () =>
          resolveCodexRotatingSetupManifestForNonce({
            prisma,
            setupNonce: originalManifest.setupNonce,
          }),
        recoveryFullName,
      );
      await expect(
        issueCodexRotatingSetupCommand({
          prisma,
          workspaceId,
          repositoryId: recoveryRepositoryId,
          repositoryFullName: recoveryFullName,
          githubRepositoryId: recoveryGithubRepositoryId,
          installer,
          setupManifestUrl:
            "https://reviewrouter.site/api/codex-rotating/setup-manifest",
          setupConfirmUrl:
            "https://reviewrouter.site/api/codex-rotating/setup-confirm",
        }),
      ).rejects.toThrow("codex_rotating_setup_recovery_required");

      const recoveryRequestId = `recovery:${randomUUID()}`;
      const recoveryAdapter = new PrismaCodexRotatingSetupRecovery(
        concurrentPrisma[0],
      );
      const runtimeRepository = new PrismaCodexRotatingOAuthRepository(
        concurrentPrisma[1],
        { actionOwnerRepo: "777genius/review-router" },
      );
      const recoverRuntimeRace = await Promise.allSettled([
        recoverCodexRotatingSetup(
          {
            workspaceId,
            repositoryId: recoveryRepositoryId,
            githubRepositoryId: recoveryGithubRepositoryId,
            recoveryRequestId,
            actor: "user:github:operator",
            acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
          },
          { recovery: recoveryAdapter },
        ),
        runtimeRepository.acquirePrelease({
          repository: {
            workspaceId,
            repositoryId: recoveryRepositoryId,
            githubRepositoryId: recoveryGithubRepositoryId,
            githubInstallationId: githubInstallationId.toString(),
            fullName: recoveryFullName,
            owner: "777genius",
            selected: true,
            installationStatus: "active",
          },
          providerInstanceId: original.providerInstanceId,
          githubRunId: "runtime-during-setup-recovery",
          githubRunAttempt: "1",
          now: new Date(),
        }),
      ]);
      if (recoverRuntimeRace[0]!.status === "rejected") {
        throw recoverRuntimeRace[0]!.reason;
      }
      expect(recoverRuntimeRace[1]!.status).toBe("rejected");
      const recovered = (
        recoverRuntimeRace[0] as PromiseFulfilledResult<{
          readonly status: "recovered" | "idempotent_replay";
          readonly recoveryEpoch: bigint;
        }>
      ).value;
      expect(recovered.status).toBe("recovered");
      const reseed = () =>
        issueCodexRotatingSetupCommand({
          prisma,
          workspaceId,
          repositoryId: recoveryRepositoryId,
          repositoryFullName: recoveryFullName,
          githubRepositoryId: recoveryGithubRepositoryId,
          installer,
          installerArguments: ["--force-reseed"],
          recovery: {
            requestId: recoveryRequestId,
            epoch: recovered.recoveryEpoch,
          },
          setupManifestUrl:
            "https://reviewrouter.site/api/codex-rotating/setup-manifest",
          setupConfirmUrl:
            "https://reviewrouter.site/api/codex-rotating/setup-confirm",
        });
      const [firstReseed, retryReseed] = await Promise.all([
        reseed(),
        reseed(),
      ]);
      expect(firstReseed.command).toBe(retryReseed.command);
      expect(firstReseed.command).toContain("--force-reseed");
      const replay = await recoverCodexRotatingSetup(
        {
          workspaceId,
          repositoryId: recoveryRepositoryId,
          githubRepositoryId: recoveryGithubRepositoryId,
          recoveryRequestId,
          actor: "user:github:operator",
          acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
        },
        { recovery: recoveryAdapter },
      );
      expect(replay).toEqual({
        status: "idempotent_replay",
        recoveryEpoch: recovered.recoveryEpoch,
      });
      await expect(
        prisma.codexOAuthSetupManifest.count({
          where: { repositoryId: recoveryRepositoryId, status: "issued" },
        }),
      ).resolves.toBe(1);
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: {
          targetId: recoveryRepositoryId,
          action: "codex_rotating.setup_recovered",
        },
      });
      const serializedAudit = JSON.stringify(audit.metadata);
      expect(serializedAudit).toContain(recoveryRequestId);
      expect(serializedAudit).not.toContain("AUTH_JSON");
      expect(serializedAudit).not.toContain("token");

      const reseedManifest =
        await prisma.codexOAuthSetupManifest.findFirstOrThrow({
          where: { repositoryId: recoveryRepositoryId, status: "issued" },
          select: { setupNonce: true },
        });
      await withRotatingRepositoryAllowed(
        () =>
          resolveCodexRotatingSetupManifestForNonce({
            prisma,
            setupNonce: reseedManifest.setupNonce,
          }),
        recoveryFullName,
      );
      const secondRecoveryRequestId = `recovery:${randomUUID()}`;
      const recoverConfirmRace = await withRotatingRepositoryAllowed(
        () =>
          Promise.allSettled([
            recoverCodexRotatingSetup(
              {
                workspaceId,
                repositoryId: recoveryRepositoryId,
                githubRepositoryId: recoveryGithubRepositoryId,
                recoveryRequestId: secondRecoveryRequestId,
                actor: "user:github:operator",
                acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
              },
              {
                recovery: new PrismaCodexRotatingSetupRecovery(
                  concurrentPrisma[0],
                ),
              },
            ),
            confirmCodexRotatingSetupManifest({
              prisma: concurrentPrisma[1],
              payload: confirmation(
                reseedManifest.setupNonce,
                recoveryGithubRepositoryId,
                "f".repeat(43),
              ),
            }),
          ]),
        recoveryFullName,
      );
      expect(
        recoverConfirmRace.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
    } finally {
      await prisma.repositoryConnection.delete({
        where: { id: recoveryRepositoryId },
      });
    }
  });
});

function confirmation(
  setupNonce: string,
  githubRepositoryId: string,
  generationHash: string,
) {
  return {
    protocolVersion: 1,
    repositoryId: githubRepositoryId,
    providerInstanceId: `codex-rotating:${githubRepositoryId}`,
    setupNonce,
    secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
    generationHash,
    accountFingerprint: "f".repeat(43),
    authByteSizeBucket: "0-4KiB",
    installerVersion: "serialization-test",
  } as const;
}

async function withRotatingRepositoryAllowed<T>(
  run: () => Promise<T>,
  allowedRepository = "777genius/review-router-saas-e2e",
): Promise<T> {
  const previousEnabled = process.env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH;
  const previousAllowlist =
    process.env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES;
  process.env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH = "1";
  process.env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES =
    allowedRepository;
  try {
    return await run();
  } finally {
    restoreEnvironment(
      "REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH",
      previousEnabled,
    );
    restoreEnvironment(
      "REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES",
      previousAllowlist,
    );
  }
}

async function withRotatingRepositoryDisabled<T>(
  run: () => Promise<T>,
): Promise<T> {
  const previousEnabled = process.env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH;
  const previousAllowlist =
    process.env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES;
  const previousSetupIssuance =
    process.env.REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED;
  process.env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH = "0";
  process.env.REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED = "0";
  delete process.env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES;
  try {
    return await run();
  } finally {
    restoreEnvironment(
      "REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH",
      previousEnabled,
    );
    restoreEnvironment(
      "REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES",
      previousAllowlist,
    );
    restoreEnvironment(
      "REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED",
      previousSetupIssuance,
    );
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
