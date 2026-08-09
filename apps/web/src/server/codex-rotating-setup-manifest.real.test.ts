import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CodexRotatingSetupManifestStatus,
  confirmCodexRotatingSetupManifest,
  issueCodexRotatingSetupCommand,
  resolveCodexRotatingSetupManifestForNonce,
} from "./codex-rotating-setup-manifest";

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
    expect(migration).toContain(
      'LOCK TABLE "CodexOAuthSetupManifest" IN ACCESS EXCLUSIVE MODE;',
    );
    expect(migration).toContain('ADD COLUMN "confirmationJson" JSONB;');
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
    await prisma.repositoryConnection.create({
      data: {
        id: repositoryId,
        workspaceId,
        provider: "github",
        externalRepositoryId: githubRepositoryId,
        githubRepositoryId: BigInt(githubRepositoryId),
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
    await expect(issue()).rejects.toThrow("codex_rotating_setup_in_progress");

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
): Promise<T> {
  const previousEnabled = process.env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH;
  const previousAllowlist =
    process.env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES;
  process.env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH = "1";
  process.env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES =
    "777genius/review-router-saas-e2e";
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
