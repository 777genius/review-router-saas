import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import {
  codexRotatingSetupRecoveryAcknowledgement,
  codexRotatingSetupManifestSchema,
  fingerprintDatabaseRecoveryWitness,
  recoverCodexRotatingSetup,
} from "@reviewrouter/features-provider-setup";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { issueCodexRotatingSetupForRepository } from "./codex-rotating-setup-command";
import {
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

  it("migrates historical ambiguous PUT outcomes into a permanent fence", () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../packages/platform/db/prisma/migrations/000062_codex_oauth_remote_outcome_unknown/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(migration).toContain("'remote_outcome_unknown'");
    expect(migration).toContain("'legacy_ambiguous_recovery'");
    expect(migration).not.toMatch(/grace|interval|expiresAt/i);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s';");
    expect(migration).toContain("SET LOCAL statement_timeout = '5min';");
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
  const actionCommitSha = "b".repeat(40);
  const installer = {
    url: `https://raw.githubusercontent.com/777genius/review-router/${actionCommitSha}/scripts/seed-codex-rotating-auth.sh`,
    version: "v1.0.0",
    sha256: "a".repeat(64),
  } as const;

  beforeAll(async () => {
    vi.stubEnv("REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED", "1");
    vi.stubEnv("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH", "1");
    vi.stubEnv("REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES", "");
    vi.stubEnv(
      "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF",
      `777genius/review-router@${actionCommitSha}`,
    );
    prisma = createPrismaClient({ databaseUrl: databaseUrl! });
    concurrentPrisma = [
      createPrismaClient({ databaseUrl: databaseUrl! }),
      createPrismaClient({ databaseUrl: databaseUrl! }),
    ];
    const postgresVersion = await prisma.$queryRaw<
      Array<{ readonly major: number }>
    >`
      SELECT current_setting('server_version_num')::int / 10000 AS "major"
    `;
    expect(postgresVersion).toEqual([{ major: 17 }]);
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
    try {
      if (prisma) {
        // Claims and recovery records are deliberately deletion-proof evidence.
        // The required real-test database is disposable and owns suite cleanup.
        await Promise.all(
          concurrentPrisma.map((client) => client.$disconnect()),
        );
        await prisma.$disconnect();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("consumes production admission exactly once before first setup allocation", async () => {
    const admittedRepositoryId = `codex-admitted-repository-${randomUUID()}`;
    const admittedGithubRepositoryId = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
    const admittedFullName = "777genius/review-router-admitted-proof";
    await prisma.repositoryConnection.create({
      data: {
        id: admittedRepositoryId,
        workspaceId,
        provider: "github",
        externalRepositoryId: admittedGithubRepositoryId,
        githubRepositoryId: BigInt(admittedGithubRepositoryId),
        installationId,
        owner: "777genius",
        name: "review-router-admitted-proof",
        fullName: admittedFullName,
        defaultBranch: "main",
        visibility: "private",
      },
    });
    vi.stubEnv("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS", "w".repeat(43));
    vi.stubEnv("REVIEW_ROUTER_PUBLIC_WEB_URL", "https://reviewrouter.site");
    vi.stubEnv("REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL", installer.url);
    vi.stubEnv(
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION",
      installer.version,
    );
    vi.stubEnv(
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256",
      installer.sha256,
    );

    await issueCodexRotatingSetupForRepository({
      prisma,
      repository: {
        id: admittedRepositoryId,
        workspaceId,
        provider: "github",
        githubRepositoryId: BigInt(admittedGithubRepositoryId),
        fullName: admittedFullName,
        selected: true,
        archived: false,
        installation: { status: "active" },
      },
    });

    const rateLimitKey = [
      "dashboard",
      "review_config_save",
      encodeURIComponent(workspaceId),
      encodeURIComponent(`codex-rotating-setup:${admittedRepositoryId}`),
    ].join(":");
    await expect(
      prisma.$queryRaw<Array<{ count: number; manifests: bigint }>>`
        SELECT bucket."count",
               (SELECT count(*) FROM "CodexOAuthSetupManifest" manifest
                JOIN "CodexOAuthProviderInstance" provider
                  ON provider."id" = manifest."providerInstanceRowId"
                WHERE provider."repositoryId" = ${admittedRepositoryId})::bigint
                 AS manifests
        FROM "RateLimitBucket" bucket
        WHERE bucket."key" = ${rateLimitKey}
      `,
    ).resolves.toEqual([{ count: 1, manifests: 1n }]);
  });

  it("blocks concurrent dashboard and CLI issuance across W1 to W2 with zero allocation", async () => {
    const fencedRepositoryId = `codex-witness-repository-${randomUUID()}`;
    const fencedGithubRepositoryId = `${Date.now()}${Math.floor(Math.random() * 1_000)}`;
    const fencedFullName = "777genius/review-router-witness-fence";
    const firstRecoveryWitness = "v".repeat(43);
    await prisma.repositoryConnection.create({
      data: {
        id: fencedRepositoryId,
        workspaceId,
        provider: "github",
        externalRepositoryId: fencedGithubRepositoryId,
        githubRepositoryId: BigInt(fencedGithubRepositoryId),
        installationId,
        owner: "777genius",
        name: "review-router-witness-fence",
        fullName: fencedFullName,
        defaultBranch: "main",
        visibility: "private",
      },
    });
    await issueCodexRotatingSetupCommand({
      prisma,
      workspaceId,
      repositoryId: fencedRepositoryId,
      repositoryFullName: fencedFullName,
      githubRepositoryId: fencedGithubRepositoryId,
      installer,
      databaseRecoveryWitness: firstRecoveryWitness,
      setupManifestUrl:
        "https://reviewrouter.site/api/codex-rotating/setup-manifest",
    });
    const issued = await prisma.$queryRaw<
      Array<{
        id: string;
        providerInstanceRowId: string;
        mutationEpoch: bigint;
        expiresAt: Date;
        setupNonce: string;
        databaseRecoveryWitness: string | null;
      }>
    >`
        SELECT "id", "providerInstanceRowId", "mutationEpoch", "expiresAt",
               "setupNonce", "databaseRecoveryWitness"
        FROM "CodexOAuthSetupManifest"
        WHERE "repositoryId" = ${fencedRepositoryId}
        ORDER BY "createdAt" DESC LIMIT 1
      `;
    const manifest = issued[0]!;
    expect(manifest.databaseRecoveryWitness).toBe(
      fingerprintDatabaseRecoveryWitness(firstRecoveryWitness),
    );
    await expect(
      prisma.$executeRaw`
        UPDATE "CodexOAuthSetupManifest"
        SET "databaseRecoveryWitness" = ${fingerprintDatabaseRecoveryWitness("w".repeat(43))}
        WHERE "id" = ${manifest.id}
      `,
    ).rejects.toThrow();
    const terminalAt = new Date(manifest.expiresAt.getTime() - 1_000);
    await withRotatingRepositoryAllowed(
      () =>
        resolveCodexRotatingSetupManifestForNonce({
          prisma,
          setupNonce: manifest.setupNonce,
          databaseRecoveryWitness: firstRecoveryWitness,
          now: terminalAt,
        }),
      fencedFullName,
    );
    const terminalClaimId = `claim:${randomUUID()}`;
    await prisma.$executeRaw`
        INSERT INTO "CodexOAuthSetupPayloadClaim" (
          "id", "providerInstanceRowId", "workspaceId", "repositoryId",
          "githubRepositoryId", "manifestId", "manifestDigest", "recoveryEpoch",
          "operationId", "payloadVersion", "canonicalizationVersion", "generationHash",
          "accountIdentityHash", "accountIdentityAlgorithm", "authByteSize",
          "installerVersion", "installerDigest", "databaseIncarnation",
          "databaseRecoveryWitness", "status", "prepareReplayExpiresAt",
          "recoveryExpiresAt", "createdAt", "updatedAt"
        ) VALUES (
          ${terminalClaimId}, ${manifest.providerInstanceRowId}, ${workspaceId},
          ${fencedRepositoryId}, ${fencedGithubRepositoryId}, ${manifest.id},
          ${"d".repeat(64)}, ${manifest.mutationEpoch}, ${`operation:${randomUUID()}`},
          2, 1, ${"g".repeat(43)}, ${"i".repeat(43)},
          'provider_issuer_subject_account_v1', 100, ${installer.version},
          ${installer.sha256}, '7612345678901234567',
          ${fingerprintDatabaseRecoveryWitness(firstRecoveryWitness)},
          'prepared', ${terminalAt},
          ${new Date(terminalAt.getTime() + 60_000)}, ${terminalAt}, ${terminalAt}
        )
      `;
    await prisma.$executeRaw`
        UPDATE "CodexOAuthSetupPayloadClaim"
        SET "status" = 'superseded_predispatch', "updatedAt" = ${terminalAt}
        WHERE "id" = ${terminalClaimId} AND "status" = 'prepared'
      `;

    const allocationState = () =>
      prisma.$queryRaw<
        Array<{
          mutationEpoch: bigint;
          manifestCount: bigint;
          claimCount: bigint;
          namespaceCount: bigint;
          recoveryCount: bigint;
          rateLimitCount: bigint;
        }>
      >`
          SELECT provider."mutationEpoch",
                 (SELECT count(*) FROM "CodexOAuthSetupManifest"
                  WHERE "providerInstanceRowId" = provider."id")::bigint AS "manifestCount",
                 (SELECT count(*) FROM "CodexOAuthSetupPayloadClaim"
                  WHERE "providerInstanceRowId" = provider."id")::bigint AS "claimCount",
                 (SELECT count(*) FROM "CodexOAuthSecretNamespace"
                  WHERE "providerInstanceRowId" = provider."id")::bigint AS "namespaceCount",
                 (SELECT count(*) FROM "CodexOAuthSetupRecoveryRequest"
                  WHERE "providerInstanceRowId" = provider."id")::bigint AS "recoveryCount",
                 (SELECT count(*) FROM "RateLimitBucket"
                  WHERE "key" = ${[
                    "dashboard",
                    "review_config_save",
                    encodeURIComponent(workspaceId),
                    encodeURIComponent(
                      `codex-rotating-setup:${fencedRepositoryId}`,
                    ),
                  ].join(":")})::bigint AS "rateLimitCount"
          FROM "CodexOAuthProviderInstance" provider
          WHERE provider."id" = ${manifest.providerInstanceRowId}
        `;
    const before = await allocationState();
    vi.stubEnv("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS", "w".repeat(43));
    vi.stubEnv("REVIEW_ROUTER_PUBLIC_WEB_URL", "https://reviewrouter.site");
    vi.stubEnv("REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL", installer.url);
    vi.stubEnv(
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION",
      installer.version,
    );
    vi.stubEnv(
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256",
      installer.sha256,
    );
    const fencedRepository = {
      id: fencedRepositoryId,
      workspaceId,
      provider: "github",
      githubRepositoryId: BigInt(fencedGithubRepositoryId),
      fullName: fencedFullName,
      selected: true,
      archived: false,
      installation: { status: "active" },
    } as const;
    vi.stubEnv("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS", "malformed");
    await expect(
      issueCodexRotatingSetupForRepository({
        prisma: concurrentPrisma[0],
        repository: fencedRepository,
      }),
    ).rejects.toThrow("invalid_env:REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS");
    await expect(allocationState()).resolves.toEqual(before);
    vi.stubEnv("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS", "w".repeat(43));
    const attempts = await Promise.allSettled([
      issueCodexRotatingSetupForRepository({
        prisma: concurrentPrisma[0],
        repository: fencedRepository,
      }),
      issueCodexRotatingSetupForRepository({
        prisma: concurrentPrisma[1],
        repository: fencedRepository,
        installerArguments: ["--force-reseed"],
      }),
    ]);
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt.status).toBe("rejected");
      if (attempt.status === "rejected") {
        expect(attempt.reason).toEqual(
          expect.objectContaining({
            message: "codex_rotating_setup_recovery_required",
          }),
        );
      }
    }
    await expect(allocationState()).resolves.toEqual(before);

    const staleRecoveryRequestId = `recovery:${randomUUID()}`;
    const staleRecoveryEpoch = manifest.mutationEpoch + 1n;
    const staleRecoveryRowId = `codex_recovery_${randomUUID()}`;
    await prisma.codexOAuthProviderInstance.update({
      where: { id: manifest.providerInstanceRowId },
      data: {
        mutationEpoch: staleRecoveryEpoch,
        mutationOwner: "recovery",
        mutationOwnerId: `setup-recovery:${staleRecoveryRequestId}`,
      },
    });
    await prisma.$executeRaw`
      INSERT INTO "CodexOAuthSetupRecoveryRequest" (
        "id", "providerInstanceRowId", "recoveryRequestId", "actor",
        "acknowledgement", "mutationEpoch", "databaseRecoveryWitness",
        "mode", "state", "requestedAt", "activatedAt", "updatedAt"
      ) VALUES (
        ${staleRecoveryRowId}, ${manifest.providerInstanceRowId},
        ${staleRecoveryRequestId}, 'user:old-writer',
        ${codexRotatingSetupRecoveryAcknowledgement}, ${staleRecoveryEpoch},
        ${fingerprintDatabaseRecoveryWitness(firstRecoveryWitness)},
        'forced_reseed', 'active', ${terminalAt}, ${terminalAt}, ${terminalAt}
      )
    `;

    const currentRecoveryRequestId = `recovery:${randomUUID()}`;
    const currentRecovery = await recoverCodexRotatingSetup(
      {
        workspaceId,
        repositoryId: fencedRepositoryId,
        githubRepositoryId: fencedGithubRepositoryId,
        recoveryRequestId: currentRecoveryRequestId,
        actor: "user:current-writer",
        acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
        now: new Date(manifest.expiresAt.getTime() + 1),
      },
      {
        recovery: new PrismaCodexRotatingSetupRecovery(
          concurrentPrisma[0],
          "w".repeat(43),
        ),
      },
    );
    await expect(
      prisma.codexOAuthSetupRecoveryRequest.findMany({
        where: { providerInstanceRowId: manifest.providerInstanceRowId },
        orderBy: { requestedAt: "asc" },
        select: {
          recoveryRequestId: true,
          state: true,
          databaseRecoveryWitness: true,
        },
      }),
    ).resolves.toEqual([
      {
        recoveryRequestId: staleRecoveryRequestId,
        state: "superseded",
        databaseRecoveryWitness:
          fingerprintDatabaseRecoveryWitness(firstRecoveryWitness),
      },
      {
        recoveryRequestId: currentRecoveryRequestId,
        state: "active",
        databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
          "w".repeat(43),
        ),
      },
    ]);
    await expect(
      issueCodexRotatingSetupCommand({
        prisma: concurrentPrisma[1],
        workspaceId,
        repositoryId: fencedRepositoryId,
        repositoryFullName: fencedFullName,
        githubRepositoryId: fencedGithubRepositoryId,
        installer,
        databaseRecoveryWitness: "w".repeat(43),
        installerArguments: ["--force-reseed"],
        recovery: {
          requestId: currentRecoveryRequestId,
          epoch: currentRecovery.recoveryEpoch,
        },
        setupManifestUrl:
          "https://reviewrouter.site/api/codex-rotating/setup-manifest",
      }),
    ).resolves.toMatchObject({ providerInstanceId: expect.any(String) });
  });

  it("replays a fetched forced manifest but never recovers its secret namespace", async () => {
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
    const original = await issueCodexRotatingSetupCommand({
      prisma,
      workspaceId,
      repositoryId: recoveryRepositoryId,
      repositoryFullName: recoveryFullName,
      githubRepositoryId: recoveryGithubRepositoryId,
      installer,
      databaseRecoveryWitness: "v".repeat(43),
      setupManifestUrl:
        "https://reviewrouter.site/api/codex-rotating/setup-manifest",
    });
    const originalManifest =
      await prisma.codexOAuthSetupManifest.findFirstOrThrow({
        where: { repositoryId: recoveryRepositoryId, status: "issued" },
        select: {
          id: true,
          setupNonce: true,
          mutationEpoch: true,
          expiresAt: true,
        },
      });
    await withRotatingRepositoryAllowed(
      () =>
        resolveCodexRotatingSetupManifestForNonce({
          prisma,
          setupNonce: originalManifest.setupNonce,
          databaseRecoveryWitness: "v".repeat(43),
          now: new Date(originalManifest.expiresAt.getTime() - 1),
        }),
      recoveryFullName,
    );
    const provider = await prisma.codexOAuthProviderInstance.findFirstOrThrow({
      where: { repositoryId: recoveryRepositoryId },
      select: { id: true },
    });
    await prisma.providerSetupState.create({
      data: {
        workspaceId,
        repositoryId: recoveryRepositoryId,
        targetKey: `repo:${recoveryRepositoryId}`,
        providerKind: "codex",
        authMode: "codex_subscription_oauth_rotating",
        state: "configured",
      },
    });
    const claimId = `claim:${randomUUID()}`;
    const attemptId = `attempt:${randomUUID()}`;
    const namespaceId = `namespace:${randomUUID()}`;
    const confirmedAt = new Date(originalManifest.expiresAt.getTime() - 1);
    await prisma.$executeRaw`
        INSERT INTO "CodexOAuthSetupPayloadClaim" (
          "id", "providerInstanceRowId", "workspaceId", "repositoryId",
          "githubRepositoryId", "manifestId", "manifestDigest", "recoveryEpoch",
          "operationId", "payloadVersion", "canonicalizationVersion", "generationHash",
          "accountIdentityHash", "accountIdentityAlgorithm", "authByteSize",
          "installerVersion", "installerDigest", "databaseIncarnation",
          "databaseRecoveryWitness", "status", "prepareReplayExpiresAt",
          "recoveryExpiresAt", "createdAt", "updatedAt"
        ) VALUES (
          ${claimId}, ${provider.id}, ${workspaceId}, ${recoveryRepositoryId},
          ${recoveryGithubRepositoryId}, ${originalManifest.id}, ${"d".repeat(64)},
          ${originalManifest.mutationEpoch!}, ${`operation:${randomUUID()}`}, 2, 1,
          ${"g".repeat(43)}, ${"i".repeat(43)},
          'provider_issuer_subject_account_v1', 100, ${installer.version},
          ${installer.sha256}, '7612345678901234567',
          ${fingerprintDatabaseRecoveryWitness("v".repeat(43))},
          'prepared', ${originalManifest.expiresAt},
          ${new Date(originalManifest.expiresAt.getTime() + 86_400_000)},
          ${confirmedAt}, ${confirmedAt}
        )
      `;
    const secretName = `REVIEWROUTER_CODEX_AUTH_JSON_R${recoveryGithubRepositoryId}_P0123456789abcdef_E1_${"b".repeat(32)}`;
    await prisma.$executeRaw`
        INSERT INTO "CodexOAuthSecretNamespace" (
          "id", "providerInstanceRowId", "githubRepositoryId", "namespaceEpoch",
          "secretName", "databaseRecoveryWitness", "status"
        ) VALUES (
          ${namespaceId}, ${provider.id}, ${recoveryGithubRepositoryId}, 1,
          ${secretName}, ${fingerprintDatabaseRecoveryWitness("v".repeat(43))},
          'dispatch_authorized'
        )
      `;
    await prisma.$executeRaw`
        INSERT INTO "CodexOAuthSetupDispatchAttempt" (
          "id", "claimId", "namespaceId", "ordinal", "idempotencyKey", "status",
          "authorizedAt", "dispatchExpiresAt"
        ) VALUES (
          ${attemptId}, ${claimId}, ${namespaceId}, 1, ${`dispatch:${randomUUID()}`},
          'dispatch_authorized', ${confirmedAt},
          ${new Date(originalManifest.expiresAt.getTime() + 600_000)}
        )
      `;
    await prisma.$executeRaw`
        UPDATE "CodexOAuthSetupDispatchAttempt"
        SET "status" = 'confirmed', "definiteResponseCode" = 204,
            "confirmedAt" = ${confirmedAt}, "updatedAt" = ${confirmedAt}
        WHERE "id" = ${attemptId} AND "status" = 'dispatch_authorized'
      `;
    await prisma.$executeRaw`
        UPDATE "CodexOAuthSecretNamespace"
        SET "status" = 'confirmed_candidate', "confirmedAt" = ${confirmedAt}
        WHERE "id" = ${namespaceId} AND "status" = 'dispatch_authorized'
      `;
    await prisma.$executeRaw`
        UPDATE "CodexOAuthSetupPayloadClaim"
        SET "status" = 'confirmed_candidate', "confirmedAttemptId" = ${attemptId},
            "confirmedAt" = ${confirmedAt}, "updatedAt" = ${confirmedAt}
        WHERE "id" = ${claimId} AND "status" = 'prepared'
      `;
    const recoveryRequestId = `recovery:${randomUUID()}`;
    const recoveryNow = new Date(new Date(original.expiresAt).getTime() + 1);
    const recoveryAdapter = new PrismaCodexRotatingSetupRecovery(
      concurrentPrisma[0],
      "w".repeat(43),
    );
    const safeRecovery = await recoverCodexRotatingSetup(
      {
        workspaceId,
        repositoryId: recoveryRepositoryId,
        githubRepositoryId: recoveryGithubRepositoryId,
        recoveryRequestId,
        actor: "user:github:operator",
        acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
        now: recoveryNow,
      },
      { recovery: recoveryAdapter },
    );
    await expect(
      prisma.providerSetupState.findFirstOrThrow({
        where: {
          workspaceId,
          repositoryId: recoveryRepositoryId,
          targetKey: `repo:${recoveryRepositoryId}`,
          providerKind: "codex",
          authMode: "codex_subscription_oauth_rotating",
        },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: "stale_or_invalid" });
    await expect(
      prisma.$executeRaw`
        UPDATE "CodexOAuthSetupRecoveryRequest"
        SET "databaseRecoveryWitness" = ${fingerprintDatabaseRecoveryWitness("x".repeat(43))}
        WHERE "providerInstanceRowId" = ${provider.id}
          AND "recoveryRequestId" = ${recoveryRequestId}
      `,
    ).rejects.toThrow();
    const recoveryAllocationState = () =>
      prisma.$queryRaw<Array<{ mutationEpoch: bigint; manifestCount: bigint }>>`
          SELECT provider."mutationEpoch",
                 (SELECT count(*) FROM "CodexOAuthSetupManifest"
                  WHERE "providerInstanceRowId" = provider."id")::bigint AS "manifestCount"
          FROM "CodexOAuthProviderInstance" provider
          WHERE provider."id" = ${provider.id}
        `;
    const beforeStaleAttempts = await recoveryAllocationState();
    const forcedIssuance = (
      client: PrismaClient,
      options: {
        readonly witness?: string;
        readonly epoch?: bigint;
      } = {},
    ) =>
      issueCodexRotatingSetupCommand({
        prisma: client,
        workspaceId,
        repositoryId: recoveryRepositoryId,
        repositoryFullName: recoveryFullName,
        githubRepositoryId: recoveryGithubRepositoryId,
        installer,
        databaseRecoveryWitness: options.witness ?? "w".repeat(43),
        installerArguments: ["--force-reseed"],
        recovery: {
          requestId: recoveryRequestId,
          epoch: options.epoch ?? safeRecovery.recoveryEpoch,
        },
        setupManifestUrl:
          "https://reviewrouter.site/api/codex-rotating/setup-manifest",
        now: recoveryNow,
      });
    await expect(
      forcedIssuance(prisma, { witness: "x".repeat(43) }),
    ).rejects.toThrow("codex_rotating_setup_recovery_required");
    await expect(
      forcedIssuance(prisma, { epoch: safeRecovery.recoveryEpoch + 1n }),
    ).rejects.toThrow("codex_rotating_setup_recovery_required");
    await expect(recoveryAllocationState()).resolves.toEqual(
      beforeStaleAttempts,
    );

    const [forced, retriedForcedIssuance] = await Promise.all([
      forcedIssuance(concurrentPrisma[0]),
      forcedIssuance(concurrentPrisma[1]),
    ] as const);
    expect(retriedForcedIssuance.command).toBe(forced.command);
    const forcedManifest =
      await prisma.codexOAuthSetupManifest.findFirstOrThrow({
        where: { repositoryId: recoveryRepositoryId, status: "issued" },
        select: { setupNonce: true },
      });
    const fetchForced = () =>
      withRotatingRepositoryAllowed(
        () =>
          resolveCodexRotatingSetupManifestForNonce({
            prisma,
            setupNonce: forcedManifest.setupNonce,
            databaseRecoveryWitness: "w".repeat(43),
            now: recoveryNow,
          }),
        recoveryFullName,
      );
    const firstFetched = await fetchForced();
    const replayedFetch = await fetchForced();
    expect(replayedFetch).toEqual(firstFetched);
    const routedManifest = codexRotatingSetupManifestSchema.parse(
      JSON.parse(
        Buffer.from(firstFetched.manifestBase64, "base64url").toString("utf8"),
      ),
    );
    expect(routedManifest).not.toHaveProperty("secretName");
    expect(forced.command).toContain("--force-reseed");
    const recoveryLedger = await prisma.$queryRaw<
      Array<{
        actor: string;
        acknowledgement: string;
        databaseRecoveryWitness: string | null;
        state: string;
        latestManifestId: string | null;
      }>
    >`
        SELECT "actor", "acknowledgement", "databaseRecoveryWitness", "state", "latestManifestId"
        FROM "CodexOAuthSetupRecoveryRequest"
        WHERE "providerInstanceRowId" = (
          SELECT "id" FROM "CodexOAuthProviderInstance"
          WHERE "providerInstanceId" = ${original.providerInstanceId}
        )
          AND "recoveryRequestId" = ${recoveryRequestId}
      `;
    expect(recoveryLedger).toEqual([
      {
        actor: "user:github:operator",
        acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
        databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
          "w".repeat(43),
        ),
        state: "manifest_issued",
        latestManifestId: expect.any(String),
      },
    ]);
    expect(JSON.stringify(recoveryLedger)).not.toMatch(
      /AUTH_JSON|access.token|refresh.token/i,
    );
    const retiredAuthority = await prisma.$queryRaw<
      Array<{
        claimStatus: string;
        attemptStatus: string;
        namespaceStatus: string;
        liveCount: bigint;
      }>
    >`
        SELECT claim."status" AS "claimStatus",
               attempt."status" AS "attemptStatus",
               namespace."status" AS "namespaceStatus",
               ((SELECT count(*) FROM "CodexOAuthSetupPayloadClaim"
                 WHERE "providerInstanceRowId" = ${provider.id}
                   AND "status" IN ('prepared','confirmed_candidate','active')) +
                (SELECT count(*) FROM "CodexOAuthSetupDispatchAttempt" a
                 JOIN "CodexOAuthSetupPayloadClaim" c ON c."id" = a."claimId"
                 WHERE c."providerInstanceRowId" = ${provider.id}
                   AND a."status" IN ('dispatch_authorized','confirmed')) +
                (SELECT count(*) FROM "CodexOAuthSecretNamespace"
                 WHERE "providerInstanceRowId" = ${provider.id}
                   AND "status" IN ('dispatch_authorized','confirmed_candidate','active')))::bigint
                 AS "liveCount"
        FROM "CodexOAuthSetupPayloadClaim" claim
        JOIN "CodexOAuthSetupDispatchAttempt" attempt ON attempt."claimId" = claim."id"
        JOIN "CodexOAuthSecretNamespace" namespace ON namespace."id" = attempt."namespaceId"
        WHERE claim."id" = ${claimId}
      `;
    expect(retiredAuthority).toEqual([
      {
        claimStatus: "retired_confirmed",
        attemptStatus: "retired_confirmed",
        namespaceStatus: "retired_ambiguous",
        liveCount: 0n,
      },
    ]);
    await expect(
      prisma.$executeRaw`
          UPDATE "CodexOAuthSetupPayloadClaim"
          SET "status" = 'active', "updatedAt" = ${new Date()}
          WHERE "id" = ${claimId}
        `,
    ).rejects.toThrow();
    await expect(
      recoverCodexRotatingSetup(
        {
          workspaceId,
          repositoryId: recoveryRepositoryId,
          githubRepositoryId: recoveryGithubRepositoryId,
          recoveryRequestId: `recovery:${randomUUID()}`,
          actor: "user:github:operator",
          acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
          now: new Date("2036-08-09T12:00:00.000Z"),
        },
        { recovery: recoveryAdapter },
      ),
    ).rejects.toThrow("codex_rotating_setup_recovery_request_conflict");
    await expect(
      recoveryAdapter.inspectStatus({
        workspaceId,
        repositoryId: recoveryRepositoryId,
        issuanceEnabled: true,
      }),
    ).resolves.toEqual({
      status: "recovery_required",
    });
  });
});

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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
