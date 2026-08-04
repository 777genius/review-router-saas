import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  Prisma,
  ProviderExecutionProfileV2,
  ReviewContextGatewaySessionStateV1,
  ReviewProviderKindV2,
} from "@prisma/client";
import dotenv from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "../packages/platform/db/src/index.js";
import { ContextAttestationPersistenceStatus } from "../packages/features/review-context-attestation/src/application/ports/context-attestation-ports";
import {
  ContextProviderKind,
  activateGatewaySession,
  openGatewaySession,
  type GatewaySession,
} from "../packages/features/review-context-attestation/src/domain/gateway-session";
import {
  legacyContextGatewayOpeningIntentHash,
  PrismaContextAttestationStore,
} from "../packages/features/review-context-attestation/src/infrastructure/prisma/prisma-context-attestation-store";

if (existsSync(".env.local")) {
  dotenv.config({ path: ".env.local", override: false });
}
if (existsSync(".env")) {
  dotenv.config({ path: ".env", override: false });
}

const enabled =
  process.env.REVIEW_ROUTER_REVIEW_INVESTIGATION_MIGRATION_REHEARSAL === "1";
const describeRehearsal = enabled ? describe.sequential : describe.skip;
const prismaRoot = resolve("packages/platform/db/prisma");
const legacyOpenedAtMs = Date.now();
const sessionLifetimeMs = 120_000;
const legacySession = Object.freeze({
  sessionId: "mixed-version-legacy-session",
  workspaceId: "mixed-version-workspace",
  repositoryConnectionId: "mixed-version-connection",
  scmRepositoryIdentityId: "mixed-version-repository",
  pullRequestNumber: 42,
  sourceBaseSha: "a".repeat(40),
  sourceMergeBaseSha: "b".repeat(40),
  sourceHeadSha: "c".repeat(40),
  sourceReviewRevisionHash: digest("mixed-version-revision"),
  checkoutTreeOid: "d".repeat(40),
  sourceExecutionId: "mixed-version-execution",
  sourceWorkSlotId: "mixed-version-slot",
  attemptId: "mixed-version-legacy-attempt",
  sourceLeaseId: "mixed-version-lease",
  sourceFencingToken: "1",
  requestedModel: "gpt-migration-test",
  trustedCapabilityProfile: "context-gateway-v2",
  gatewayBinaryHash: digest("mixed-version-gateway"),
  gatewayPolicyVersion: "context-gateway-v2",
  producerReleaseId: "mixed-version-release",
  selectedProtocolVersion: "review-action-v2",
  confinementProofHash: digest("mixed-version-confinement"),
  eventChainSeedHash: digest("mixed-version-seed"),
});

describeRehearsal("review investigation mixed-version migrations", () => {
  let adminDatabase: PostgresConnection;
  let rehearsalDatabase: PostgresConnection;
  let rehearsalDatabaseUrl: string;
  let rehearsalDatabaseName: string;
  let prisma: PrismaClient;
  let store: PrismaContextAttestationStore;
  let databaseCreated = false;

  beforeAll(async () => {
    const baseUrlValue =
      process.env.REVIEW_ROUTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!baseUrlValue) {
      throw new Error(
        "REVIEW_ROUTER_TEST_DATABASE_URL or DATABASE_URL is required",
      );
    }
    const baseUrl = requireLocalPostgresUrl(baseUrlValue);
    requirePsql();
    rehearsalDatabaseName = `review_router_mixed_version_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    adminDatabase = postgresConnection(baseUrl, "postgres");
    rehearsalDatabase = postgresConnection(baseUrl, rehearsalDatabaseName);
    rehearsalDatabaseUrl = databaseUrl(baseUrl, rehearsalDatabaseName);
    runPsqlSql(
      adminDatabase,
      `CREATE DATABASE ${quoteIdentifier(rehearsalDatabaseName)}`,
    );
    databaseCreated = true;

    applyMigrationsThrough("000050_review_investigation_external_evaluation");
    runPsqlSql(rehearsalDatabase, preMigrationFixturesSql());
    applyMigration("000051_review_investigation_probe_search_policy");
    applyMigration("000052_context_gateway_multi_turn_opening");
    applyMigration("000053_review_run_authorization_investigation_snapshot");
    applyMigration("000054_review_config_investigation_rollout");

    prisma = createPrismaClient({
      databaseUrl: rehearsalDatabaseUrl,
      poolMax: 8,
    });
    store = new PrismaContextAttestationStore(prisma);
    await prisma.$queryRaw`SELECT 1`;
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (!databaseCreated) return;
    runPsqlSql(
      adminDatabase,
      `DROP DATABASE IF EXISTS ${quoteIdentifier(rehearsalDatabaseName)} WITH (FORCE)`,
    );
  });

  it("upgrades populated 000050 data and preserves legacy writer defaults", async () => {
    const upgradedInvestigations = await prisma.$queryRaw<
      Array<{
        investigationId: string;
        probePolicyVersion: string;
        searchPolicyVersion: string;
      }>
    >`
      SELECT
        "investigationId",
        "probePolicyVersion",
        "searchPolicyVersion"
      FROM "ReviewInvestigation"
      WHERE "investigationId" = 'mixed-version-investigation-before-000051'
    `;
    expect(upgradedInvestigations).toEqual([
      {
        investigationId: "mixed-version-investigation-before-000051",
        probePolicyVersion: "review-investigation-probe-policy.v1",
        searchPolicyVersion: "review-investigation-fixed-string-search.v1",
      },
    ]);

    const upgradedSessions = await prisma.$queryRaw<
      Array<{ sessionId: string; openingIntentHash: string }>
    >`
      SELECT "sessionId", "openingIntentHash"
      FROM "ReviewContextGatewaySession"
      WHERE "sessionId" = ${legacySession.sessionId}
    `;
    expect(upgradedSessions).toEqual([
      {
        sessionId: legacySession.sessionId,
        openingIntentHash: legacyContextGatewayOpeningIntentHash,
      },
    ]);

    const defaults = await prisma.$queryRaw<
      Array<{ column_name: string; column_default: string | null }>
    >`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'ReviewInvestigation'
            AND column_name IN ('probePolicyVersion', 'searchPolicyVersion'))
          OR
          (table_name = 'ReviewContextGatewaySession'
            AND column_name = 'openingIntentHash')
        )
      ORDER BY column_name
    `;
    expect(defaults).toHaveLength(3);
    expect(defaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column_name: "openingIntentHash",
          column_default: expect.stringContaining(
            legacyContextGatewayOpeningIntentHash,
          ),
        }),
        expect.objectContaining({
          column_name: "probePolicyVersion",
          column_default: expect.stringContaining(
            "review-investigation-probe-policy.v1",
          ),
        }),
        expect.objectContaining({
          column_name: "searchPolicyVersion",
          column_default: expect.stringContaining(
            "review-investigation-fixed-string-search.v1",
          ),
        }),
      ]),
    );

    runPsqlSql(
      rehearsalDatabase,
      `
        SET session_replication_role = replica;
        ${legacyInvestigationInsertSql(
          "mixed-version-investigation-after-000052",
          "mixed-version-natural-after-000052",
        )}
        SET session_replication_role = origin;
      `,
    );
    const oldWriterInvestigation =
      await prisma.reviewInvestigation.findUniqueOrThrow({
        where: {
          investigationId: "mixed-version-investigation-after-000052",
        },
        select: { probePolicyVersion: true, searchPolicyVersion: true },
      });
    expect(oldWriterInvestigation).toEqual({
      probePolicyVersion: "review-investigation-probe-policy.v1",
      searchPolicyVersion: "review-investigation-fixed-string-search.v1",
    });

    const oldWriterAttemptId = "mixed-version-old-writer-attempt";
    runPsqlSql(
      rehearsalDatabase,
      legacySessionInsertSql({
        sessionId: "mixed-version-old-writer-session",
        attemptId: oldWriterAttemptId,
      }),
    );
    const duplicate = runPsqlSql(
      rehearsalDatabase,
      legacySessionInsertSql({
        sessionId: "mixed-version-old-writer-retry",
        attemptId: oldWriterAttemptId,
      }),
      false,
    );
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain(
      "duplicate legacy context gateway attempt",
    );
    await expect(
      prisma.reviewContextGatewaySession.create({
        data: legacySessionCreateInput({
          sessionId: "mixed-version-old-prisma-retry",
          attemptId: oldWriterAttemptId,
        }),
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.reviewContextGatewaySession.count({
        where: { attemptId: oldWriterAttemptId },
      }),
    ).resolves.toBe(1);
  });

  it("adopts a legacy row on a new-server retry before allowing another intent", async () => {
    const retryHash = digest("mixed-version-legacy-idempotency-key");
    const retry = activeSession({
      sessionId: "mixed-version-new-server-retry",
      attemptId: legacySession.attemptId,
      openingIntentHash: retryHash,
    });
    await expect(store.openSession(retry)).resolves.toMatchObject({
      status: ContextAttestationPersistenceStatus.Idempotent,
      value: {
        sessionId: legacySession.sessionId,
        openingIntentHash: retryHash,
      },
    });
    await expect(
      prisma.reviewContextGatewaySession.findMany({
        where: { attemptId: legacySession.attemptId },
        select: { sessionId: true, openingIntentHash: true },
      }),
    ).resolves.toEqual([
      {
        sessionId: legacySession.sessionId,
        openingIntentHash: retryHash,
      },
    ]);

    const nextIntentHash = digest("mixed-version-next-opening-intent");
    await expect(
      store.openSession(
        activeSession({
          sessionId: "mixed-version-next-turn-session",
          attemptId: legacySession.attemptId,
          openingIntentHash: nextIntentHash,
        }),
      ),
    ).resolves.toMatchObject({
      status: ContextAttestationPersistenceStatus.Created,
      value: { openingIntentHash: nextIntentHash },
    });
    await expect(
      prisma.reviewContextGatewaySession.count({
        where: { attemptId: legacySession.attemptId },
      }),
    ).resolves.toBe(2);
  });

  it("serializes concurrent natural identities without collapsing distinct intents", async () => {
    const sameAttemptId = `mixed-version-same-${randomUUID()}`;
    const sameIntentHash = digest("mixed-version-concurrent-same-intent");
    const sameResults = await Promise.all([
      store.openSession(
        activeSession({
          sessionId: `mixed-version-same-a-${randomUUID()}`,
          attemptId: sameAttemptId,
          openingIntentHash: sameIntentHash,
        }),
      ),
      store.openSession(
        activeSession({
          sessionId: `mixed-version-same-b-${randomUUID()}`,
          attemptId: sameAttemptId,
          openingIntentHash: sameIntentHash,
        }),
      ),
    ]);
    expect(sameResults.map(({ status }) => status).sort()).toEqual([
      ContextAttestationPersistenceStatus.Created,
      ContextAttestationPersistenceStatus.Idempotent,
    ]);
    expect(
      new Set(
        sameResults.flatMap((result) =>
          "value" in result ? [result.value.sessionId] : [],
        ),
      ).size,
    ).toBe(1);
    await expect(
      prisma.reviewContextGatewaySession.count({
        where: { attemptId: sameAttemptId },
      }),
    ).resolves.toBe(1);

    const distinctAttemptId = `mixed-version-distinct-${randomUUID()}`;
    const distinctResults = await Promise.all([
      store.openSession(
        activeSession({
          sessionId: `mixed-version-distinct-a-${randomUUID()}`,
          attemptId: distinctAttemptId,
          openingIntentHash: digest("mixed-version-distinct-intent-a"),
        }),
      ),
      store.openSession(
        activeSession({
          sessionId: `mixed-version-distinct-b-${randomUUID()}`,
          attemptId: distinctAttemptId,
          openingIntentHash: digest("mixed-version-distinct-intent-b"),
        }),
      ),
    ]);
    expect(distinctResults.map(({ status }) => status)).toEqual([
      ContextAttestationPersistenceStatus.Created,
      ContextAttestationPersistenceStatus.Created,
    ]);
    await expect(
      prisma.reviewContextGatewaySession.count({
        where: { attemptId: distinctAttemptId },
      }),
    ).resolves.toBe(2);
  });

  function applyMigrationsThrough(lastMigration: string): void {
    for (const directory of readdirSync(
      join(prismaRoot, "migrations"),
    ).sort()) {
      if (!/^\d{6}_/u.test(directory) || directory > lastMigration) continue;
      applyMigration(directory);
    }
  }

  function applyMigration(directory: string): void {
    runPsqlFile(
      rehearsalDatabase,
      join(prismaRoot, "migrations", directory, "migration.sql"),
    );
  }
});

function activeSession(input: {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly openingIntentHash: string;
}): GatewaySession {
  return activateGatewaySession(
    openGatewaySession({
      sessionId: input.sessionId,
      scope: {
        workspaceId: legacySession.workspaceId,
        repositoryConnectionId: legacySession.repositoryConnectionId,
        scmRepositoryIdentityId: legacySession.scmRepositoryIdentityId,
        pullRequestNumber: legacySession.pullRequestNumber,
      },
      sourceRevision: {
        baseSha: legacySession.sourceBaseSha,
        mergeBaseSha: legacySession.sourceMergeBaseSha,
        headSha: legacySession.sourceHeadSha,
        reviewRevisionHash: legacySession.sourceReviewRevisionHash,
        checkoutTreeOid: legacySession.checkoutTreeOid,
      },
      sourceExecutionId: legacySession.sourceExecutionId,
      sourceWorkSlotId: legacySession.sourceWorkSlotId,
      attemptId: input.attemptId,
      openingIntentHash: input.openingIntentHash,
      sourceLeaseId: legacySession.sourceLeaseId,
      sourceFencingToken: legacySession.sourceFencingToken,
      providerKind: ContextProviderKind.Codex,
      requestedModel: legacySession.requestedModel,
      trustedCapabilityProfile: legacySession.trustedCapabilityProfile,
      gatewayBinaryHash: legacySession.gatewayBinaryHash,
      gatewayPolicyVersion: legacySession.gatewayPolicyVersion,
      producerReleaseId: legacySession.producerReleaseId,
      selectedProtocolVersion: legacySession.selectedProtocolVersion,
      confinementProofHash: legacySession.confinementProofHash,
      eventChainSeedHash: legacySession.eventChainSeedHash,
      openedAtMs: legacyOpenedAtMs,
      expiresAtMs: legacyOpenedAtMs + sessionLifetimeMs,
    }),
    legacyOpenedAtMs + 1,
  );
}

function preMigrationFixturesSql(): string {
  return `
    SET session_replication_role = replica;
    ${legacyInvestigationInsertSql(
      "mixed-version-investigation-before-000051",
      "mixed-version-natural-before-000051",
    )}
    SET session_replication_role = origin;
    ${legacySessionInsertSql({
      sessionId: legacySession.sessionId,
      attemptId: legacySession.attemptId,
    })}
  `;
}

function legacyInvestigationInsertSql(
  investigationId: string,
  naturalIdentitySeed: string,
): string {
  const hash = digest(naturalIdentitySeed);
  const now = new Date(legacyOpenedAtMs).toISOString();
  const retainUntil = new Date(
    legacyOpenedAtMs + 24 * 60 * 60 * 1_000,
  ).toISOString();
  return `
    INSERT INTO "ReviewInvestigation" (
      "investigationId", "naturalIdentityHash", "workspaceId",
      "repositoryConnectionId", "scmRepositoryIdentityId", "pullRequestNumber",
      "trustDomain", "baseSha", "mergeBaseSha", "headSha",
      "reviewRevisionHash", "executionId", "workSlotId",
      "stableReviewUnitKey", "providerVoteLaneId", "providerStrategyId",
      "runtimeProfile", "coverageContractVersion", "expansionRulesVersion",
      "criticPolicyVersion", "gatewayPolicyVersion", "producerReleaseId",
      "runtimeProfileVersion", "policy", "state", "findings",
      "dossierDigest", "createdAt", "updatedAt", "retainUntil"
    ) VALUES (
      ${sqlLiteral(investigationId)}, ${sqlLiteral(hash)},
      'mixed-version-workspace', 'mixed-version-connection',
      'mixed-version-repository', 42, 'hosted_control_plane',
      '${"a".repeat(40)}', '${"b".repeat(40)}', '${"c".repeat(40)}',
      ${sqlLiteral(digest("mixed-version-investigation-revision"))},
      ${sqlLiteral(`${investigationId}-execution`)},
      'mixed-version-investigation-slot',
      'mixed-version-review-unit', 'mixed-version-vote-lane',
      'mixed-version-provider-strategy', 'gateway_attested_agent_v1',
      'review-investigation-coverage.v1', 'review-investigation-expansion.v1',
      'review-investigation-critic.v1', 'context-gateway-v2',
      'mixed-version-release', 'review-investigation-runtime.v1',
      '{}'::jsonb, 'provisional', '[]'::jsonb,
      ${sqlLiteral(digest("mixed-version-dossier"))},
      ${sqlLiteral(now)}::timestamptz, ${sqlLiteral(now)}::timestamptz,
      ${sqlLiteral(retainUntil)}::timestamptz
    );
  `;
}

function legacySessionInsertSql(input: {
  readonly sessionId: string;
  readonly attemptId: string;
}): string {
  const openedAt = new Date(legacyOpenedAtMs).toISOString();
  const expiresAt = new Date(
    legacyOpenedAtMs + sessionLifetimeMs,
  ).toISOString();
  return `
    INSERT INTO "ReviewContextGatewaySession" (
      "sessionId", "workspaceId", "repositoryConnectionId",
      "scmRepositoryIdentityId", "pullRequestNumber", "sourceBaseSha",
      "sourceMergeBaseSha", "sourceHeadSha", "sourceReviewRevisionHash",
      "checkoutTreeOid", "sourceExecutionId", "sourceWorkSlotId", "attemptId",
      "sourceLeaseId", "sourceFencingToken", "providerKind", "requestedModel",
      "trustedCapabilityProfile", "executionProfile", "gatewayBinaryHash",
      "gatewayPolicyVersion", "producerReleaseId", "selectedProtocolVersion",
      "confinementProofHash", "eventChainSeedHash", "state", "eventCount",
      "openedAt", "expiresAt"
    ) VALUES (
      ${sqlLiteral(input.sessionId)}, ${sqlLiteral(legacySession.workspaceId)},
      ${sqlLiteral(legacySession.repositoryConnectionId)},
      ${sqlLiteral(legacySession.scmRepositoryIdentityId)},
      ${legacySession.pullRequestNumber}, ${sqlLiteral(legacySession.sourceBaseSha)},
      ${sqlLiteral(legacySession.sourceMergeBaseSha)},
      ${sqlLiteral(legacySession.sourceHeadSha)},
      ${sqlLiteral(legacySession.sourceReviewRevisionHash)},
      ${sqlLiteral(legacySession.checkoutTreeOid)},
      ${sqlLiteral(legacySession.sourceExecutionId)},
      ${sqlLiteral(legacySession.sourceWorkSlotId)}, ${sqlLiteral(input.attemptId)},
      ${sqlLiteral(legacySession.sourceLeaseId)},
      ${sqlLiteral(legacySession.sourceFencingToken)}::bigint, 'codex',
      ${sqlLiteral(legacySession.requestedModel)},
      ${sqlLiteral(legacySession.trustedCapabilityProfile)},
      'context_gateway_v1', ${sqlLiteral(legacySession.gatewayBinaryHash)},
      ${sqlLiteral(legacySession.gatewayPolicyVersion)},
      ${sqlLiteral(legacySession.producerReleaseId)},
      ${sqlLiteral(legacySession.selectedProtocolVersion)},
      ${sqlLiteral(legacySession.confinementProofHash)},
      ${sqlLiteral(legacySession.eventChainSeedHash)}, 'active', 0,
      ${sqlLiteral(openedAt)}::timestamptz,
      ${sqlLiteral(expiresAt)}::timestamptz
    );
  `;
}

function legacySessionCreateInput(input: {
  readonly sessionId: string;
  readonly attemptId: string;
}): Prisma.ReviewContextGatewaySessionUncheckedCreateInput {
  return {
    sessionId: input.sessionId,
    workspaceId: legacySession.workspaceId,
    repositoryConnectionId: legacySession.repositoryConnectionId,
    scmRepositoryIdentityId: legacySession.scmRepositoryIdentityId,
    pullRequestNumber: legacySession.pullRequestNumber,
    sourceBaseSha: legacySession.sourceBaseSha,
    sourceMergeBaseSha: legacySession.sourceMergeBaseSha,
    sourceHeadSha: legacySession.sourceHeadSha,
    sourceReviewRevisionHash: legacySession.sourceReviewRevisionHash,
    checkoutTreeOid: legacySession.checkoutTreeOid,
    sourceExecutionId: legacySession.sourceExecutionId,
    sourceWorkSlotId: legacySession.sourceWorkSlotId,
    attemptId: input.attemptId,
    sourceLeaseId: legacySession.sourceLeaseId,
    sourceFencingToken: BigInt(legacySession.sourceFencingToken),
    providerKind: ReviewProviderKindV2.codex,
    requestedModel: legacySession.requestedModel,
    trustedCapabilityProfile: legacySession.trustedCapabilityProfile,
    executionProfile: ProviderExecutionProfileV2.context_gateway_v1,
    gatewayBinaryHash: legacySession.gatewayBinaryHash,
    gatewayPolicyVersion: legacySession.gatewayPolicyVersion,
    producerReleaseId: legacySession.producerReleaseId,
    selectedProtocolVersion: legacySession.selectedProtocolVersion,
    confinementProofHash: legacySession.confinementProofHash,
    eventChainSeedHash: legacySession.eventChainSeedHash,
    state: ReviewContextGatewaySessionStateV1.active,
    eventCount: 0,
    openedAt: new Date(legacyOpenedAtMs),
    expiresAt: new Date(legacyOpenedAtMs + sessionLifetimeMs),
  };
}

type PostgresConnection = Readonly<{
  env: NodeJS.ProcessEnv;
}>;

function requireLocalPostgresUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("migration rehearsal database URL is invalid");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("migration rehearsal requires PostgreSQL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (
    hostname !== "localhost" &&
    hostname !== "127.0.0.1" &&
    hostname !== "::1"
  ) {
    throw new Error("migration rehearsal only accepts a local PostgreSQL host");
  }
  return url;
}

function postgresConnection(
  url: URL,
  databaseName: string,
): PostgresConnection {
  const sslMode = url.searchParams.get("sslmode");
  return {
    env: {
      ...process.env,
      PGHOST: url.hostname.replace(/^\[|\]$/gu, ""),
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: databaseName,
      ...(sslMode ? { PGSSLMODE: sslMode } : {}),
    },
  };
}

function databaseUrl(baseUrl: URL, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function requirePsql(): void {
  const result = spawnSync("psql", ["--version"], { stdio: "ignore" });
  if (result.status !== 0) throw new Error("psql is required");
}

function runPsqlFile(
  connection: PostgresConnection,
  path: string,
): ReturnType<typeof spawnSync> {
  return runPsql(connection, ["-f", path]);
}

function runPsqlSql(
  connection: PostgresConnection,
  sql: string,
  requireSuccess = true,
): ReturnType<typeof spawnSync> {
  return runPsql(connection, ["-c", sql], requireSuccess);
}

function runPsql(
  connection: PostgresConnection,
  args: readonly string[],
  requireSuccess = true,
): ReturnType<typeof spawnSync> {
  const result = spawnSync(
    "psql",
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...args],
    {
      env: connection.env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (requireSuccess && result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(value)) {
    throw new Error("unsafe database identifier");
  }
  return `"${value}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
