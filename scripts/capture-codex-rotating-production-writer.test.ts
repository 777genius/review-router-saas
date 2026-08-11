import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertProductionWriterCaptureConfiguration,
  codexRotatingProductionWriterBaseObservationSql,
  captureProductionWriterObservation,
} from "./capture-codex-rotating-production-writer.mjs";
import {
  codexRotatingFunctionBodyDigests,
  codexRotatingCatalogForeignKeyNames,
} from "./codex-rotating-production-writer-schema.mjs";
import { canonicalProviderJson } from "./codex-rotating-provider-provenance.mjs";
import { createHash } from "node:crypto";

const renderObservationPath = join(
  mkdtempSync(join(tmpdir(), "rr-render-observation-")),
  "render.json",
);
const renderObservation = {
  observationVersion: 2,
  source: "render-api",
  captureIdentity: {
    authenticated: true,
    apiHost: "api.render.com",
    rawResponsesSha256: "",
  },
  rawResponses: [
    {
      url: "https://api.render.com/v1/services/srv-migration/jobs/job-migration",
      status: 200,
      bodySha256: "0".repeat(64),
      body: { id: "job-migration" },
    },
  ],
  runtimeWitness: { sha256: "f".repeat(64) },
};
renderObservation.captureIdentity.rawResponsesSha256 = createHash("sha256")
  .update(canonicalProviderJson(renderObservation.rawResponses))
  .digest("hex");
writeFileSync(renderObservationPath, JSON.stringify(renderObservation));

const validEnv = {
  REVIEW_ROUTER_PRODUCTION_WRITER_OBSERVATION: "1",
  REVIEW_ROUTER_PRODUCTION_WRITER_DATABASE_URL:
    "postgresql://release:secret@writer.internal:5432/review_router",
  REVIEW_ROUTER_RENDER_OBSERVATION_PATH: renderObservationPath,
  REVIEW_ROUTER_ROLLOUT_EVIDENCE_ROLLOUT_ID: "rollout-1",
  REVIEW_ROUTER_DRAIN_OBSERVATION_INTERVAL_MS: "15000",
};

describe("production-writer rollout observation capture", () => {
  it("reads database generation metadata from the shared-object catalog", () => {
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "shobj_description(d.oid, 'pg_database')",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).not.toContain(
      "WHEN obj_description(d.oid, 'pg_database')",
    );
  });

  it("observes every exact rotating-writer foreign key", () => {
    const foreignKeysStart =
      codexRotatingProductionWriterBaseObservationSql.indexOf(
        "'foreignKeys', coalesce((",
        codexRotatingProductionWriterBaseObservationSql.indexOf("'catalog'"),
      );
    const foreignKeysEnd =
      codexRotatingProductionWriterBaseObservationSql.indexOf(
        "\n    'primaryKeys', coalesce((",
        foreignKeysStart,
      );
    const foreignKeysSql =
      codexRotatingProductionWriterBaseObservationSql.slice(
        foreignKeysStart,
        foreignKeysEnd,
      );
    const observedNames = [...foreignKeysSql.matchAll(/'([^']+_fkey)'/gu)].map(
      ([, name]) => name,
    );

    expect(foreignKeysStart).toBeGreaterThan(0);
    expect(foreignKeysEnd).toBeGreaterThan(foreignKeysStart);
    expect(observedNames.sort()).toEqual(
      [...codexRotatingCatalogForeignKeyNames].sort(),
    );
    expect(foreignKeysSql).toContain("'table', c.relname");
    expect(foreignKeysSql).toContain("pg_get_constraintdef(con.oid)");
  });

  it("captures normalized SHA-256 identities for complete function bodies", () => {
    const functionsStart =
      codexRotatingProductionWriterBaseObservationSql.indexOf(
        "'functions', coalesce((",
        codexRotatingProductionWriterBaseObservationSql.indexOf(
          "\n    'columns', coalesce((",
        ),
      );
    const functionsEnd =
      codexRotatingProductionWriterBaseObservationSql.indexOf(
        "\n    'checks', coalesce((",
        functionsStart,
      );
    const functionsSql = codexRotatingProductionWriterBaseObservationSql.slice(
      functionsStart,
      functionsEnd,
    );

    expect(codexRotatingFunctionBodyDigests).toHaveLength(22);
    expect(functionsSql).toContain("'bodySha256'");
    expect(functionsSql).toContain("'owner', owner.rolname");
    expect(functionsSql).toContain("p.prosrc");
    expect(functionsSql).toContain("sha256(convert_to(btrim(");
    expect(functionsSql).toContain("'prokind', p.prokind");
    expect(functionsSql).toContain("'proretset', p.proretset");
    expect(functionsSql).toContain("'prosupport', CASE");
    expect(functionsSql).toContain("p.prosupport = 0::oid");
    expect(functionsSql).toContain("'procost', p.procost");
    expect(functionsSql).toContain("'prorows', p.prorows");
    expect(functionsSql).not.toContain("pg_get_functiondef");
  });

  it("uses the complete trigger-table inventory for detailed observations", () => {
    const triggersStart =
      codexRotatingProductionWriterBaseObservationSql.indexOf(
        "\n    'triggers', coalesce((",
        codexRotatingProductionWriterBaseObservationSql.indexOf(
          "\n    'columns', coalesce((",
        ),
      );
    const triggersEnd = codexRotatingProductionWriterBaseObservationSql.indexOf(
      "\n    'functions', coalesce((",
      triggersStart,
    );
    const triggersSql = codexRotatingProductionWriterBaseObservationSql.slice(
      triggersStart,
      triggersEnd,
    );

    expect(triggersSql).toContain("'CodexOAuthProviderIdentityQuarantine'");
    expect(triggersSql).toContain("'CodexOAuthChildIdentityQuarantine'");
  });

  it("observes function ownership and the config-table privilege contract", () => {
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "'owner', owner.rolname",
    );
    for (const privilege of ["Select", "Insert", "Update", "Delete"]) {
      expect(codexRotatingProductionWriterBaseObservationSql).toContain(
        `'repositoryConnection${privilege}'`,
      );
    }
    for (const privilege of ["Select", "Insert", "Update", "References"]) {
      expect(codexRotatingProductionWriterBaseObservationSql).toContain(
        `'repositoryConnectionColumn${privilege}'`,
      );
    }
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "has_column_privilege",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "'ownsRepositoryConnection'",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "FROM pg_auth_members m",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "'grantor', grantor.rolname",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "JOIN pg_roles grantor ON grantor.oid = m.grantor",
    );
  });

  it("guards sequence privilege checks from planner predicate reordering", () => {
    const allSequenceUsageStart =
      codexRotatingProductionWriterBaseObservationSql.indexOf(
        "'allSequenceUsage', NOT EXISTS (",
      );
    const anySequenceSelectOrUpdateStart =
      codexRotatingProductionWriterBaseObservationSql.indexOf(
        "'anySequenceSelectOrUpdate', EXISTS (",
        allSequenceUsageStart,
      );
    const sequenceChecksEnd =
      codexRotatingProductionWriterBaseObservationSql.indexOf(
        "'authorityTablePrivileges'",
        anySequenceSelectOrUpdateStart,
      );
    const allSequenceUsageSql =
      codexRotatingProductionWriterBaseObservationSql.slice(
        allSequenceUsageStart,
        anySequenceSelectOrUpdateStart,
      );
    const anySequenceSelectOrUpdateSql =
      codexRotatingProductionWriterBaseObservationSql.slice(
        anySequenceSelectOrUpdateStart,
        sequenceChecksEnd,
      );

    expect(allSequenceUsageStart).toBeGreaterThan(0);
    expect(anySequenceSelectOrUpdateStart).toBeGreaterThan(
      allSequenceUsageStart,
    );
    expect(sequenceChecksEnd).toBeGreaterThan(anySequenceSelectOrUpdateStart);
    expect(allSequenceUsageSql).toMatch(
      /CASE WHEN sequence\.relkind = 'S' THEN\s+NOT has_sequence_privilege\(r\.rolname, sequence\.oid, 'USAGE'\)\s+ELSE FALSE END/u,
    );
    expect(anySequenceSelectOrUpdateSql).toMatch(
      /CASE WHEN sequence\.relkind = 'S' THEN \(\s+has_sequence_privilege\(r\.rolname, sequence\.oid, 'SELECT'\)\s+OR has_sequence_privilege\(r\.rolname, sequence\.oid, 'UPDATE'\)\s+\) ELSE FALSE END/u,
    );
    expect(`${allSequenceUsageSql}${anySequenceSelectOrUpdateSql}`).not.toMatch(
      /WHERE[\s\S]*sequence\.relkind = 'S'\s+AND[\s\S]*has_sequence_privilege/u,
    );
  });

  it("captures an unfiltered rotating-OAuth catalog inventory", () => {
    const inventoryStart =
      codexRotatingProductionWriterBaseObservationSql.indexOf(
        "'inventory', jsonb_build_object",
      );
    const inventoryEnd =
      codexRotatingProductionWriterBaseObservationSql.indexOf(
        "\n    'columns', coalesce((",
        inventoryStart + "'inventory', jsonb_build_object".length,
      );
    const inventorySql = codexRotatingProductionWriterBaseObservationSql.slice(
      inventoryStart,
      inventoryEnd,
    );

    expect(inventoryStart).toBeGreaterThan(0);
    expect(inventoryEnd).toBeGreaterThan(inventoryStart);
    expect(inventorySql).toContain("con.contype = 'c'");
    expect(inventorySql).toContain("con.contype = 'f'");
    expect(inventorySql).toContain("FROM pg_index i");
    expect(inventorySql).toContain("FROM pg_attribute a");
    expect(inventorySql).toContain("FROM pg_trigger t");
    expect(inventorySql).toContain("FROM pg_proc p");
    expect(inventorySql).toContain("t.tgfoid");
    expect(inventorySql).toContain("referenced.relname IN");
    expect(inventorySql).not.toContain("con.conname IN");
    expect(inventorySql).not.toContain("index_class.relname IN");
    expect(inventorySql).not.toContain("t.tgname IN");
    expect(inventorySql).not.toContain("p.proname IN");
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "NOT EXISTS (\n          SELECT 1 FROM pg_constraint primary_constraint",
    );
  });

  it("captures database-enforced role, ownership, and exact-definition evidence", () => {
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "current_user",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "pg_auth_members",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "pg_has_role",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "nonReleaseOwnedCatalogObjects",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "databaseGenerationBinding",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "definitionSha256",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "predicateSha256",
    );
  });

  it("requires the exact migration rollout receipt selector", () => {
    expect(() =>
      assertProductionWriterCaptureConfiguration({
        ...validEnv,
        REVIEW_ROUTER_ROLLOUT_EVIDENCE_ROLLOUT_ID: "",
      }),
    ).toThrow("migration rollout ID is required");
  });

  it.each([
    [{}, "acknowledgement is required"],
    [
      { REVIEW_ROUTER_PRODUCTION_WRITER_OBSERVATION: "1" },
      "database URL is required",
    ],
    ...["localhost", "127.1", "[::1]", "[::ffff:127.0.0.1]"].map((hostname) => [
      {
        ...validEnv,
        REVIEW_ROUTER_PRODUCTION_WRITER_DATABASE_URL: `postgresql://release:secret@${hostname}:5432/review_router`,
      },
      "cannot use a loopback database",
    ]),
    [
      { ...validEnv, REVIEW_ROUTER_RENDER_OBSERVATION_PATH: "" },
      "trusted Render observation path is required",
    ],
  ])("rejects unsafe capture configuration", (env, message) => {
    expect(() => assertProductionWriterCaptureConfiguration(env)).toThrow(
      message,
    );
  });

  it("captures DB identity, caller identity, catalog/history, and two stable drain queries", async () => {
    const base = {
      databaseIdentity: {
        currentDatabase: "review_router",
        currentSchema: "public",
        serverAddress: "10.0.0.2:5432",
        systemIdentifier: "7612345678901234567",
      },
      databaseCaller: {
        databaseRole: "reviewrouter_release_migration",
        sessionUser: "reviewrouter_release_migration",
      },
      databaseGenerationBinding: {
        version: 4,
        systemIdentifier: "7612345678901234567",
        recoveryWitnessSha256: "f".repeat(64),
        consumedMigrationEvidence: [
          {
            artifactDigest: `sha256:${"c".repeat(64)}`,
            artifactId: "301",
            rolloutId: "rollout-historical",
            runId: "99",
            claimedAt: "2026-08-09T00:00:00.000Z",
          },
          {
            receiptVersion: 4,
            artifactDigest: `sha256:${"a".repeat(64)}`,
            artifactId: "303",
            rolloutId: "rollout-1",
            runId: "101",
            runAttempt: 1,
            jobId: "202",
            workflowPath:
              ".github/workflows/codex-rotating-release-migration.yml",
            commit: "a".repeat(40),
            imageDigest: `sha256:${"b".repeat(64)}`,
            systemIdentifier: "7612345678901234567",
            recoveryWitnessSha256: "f".repeat(64),
            claimedAt: "2026-08-10T00:00:00.000Z",
          },
        ],
      },
      admittedRecoveryEvidence: {
        witnessFingerprints: ["f".repeat(64)],
        databaseIncarnations: ["7612345678901234567"],
      },
      databaseAuthorization: { roles: [] },
      isWriter: true,
      postgresVersion: "17.6",
      unsafeWork: {
        activeLeasesWithoutPositiveEpoch: 0,
        activeManifestsWithoutPositiveEpoch: 0,
        pendingIntents: 0,
        pendingIntentsWithoutPositiveEpoch: 0,
      },
      recoveryOwnerId: "setup-recovery:fetched",
      history: [],
      catalog: { triggers: [], functions: [], checks: [], indexes: [] },
    };
    const firstDrain = {
      databaseIdentity: base.databaseIdentity,
      isWriter: true,
      activeLeases: 0,
      fetchedSetups: 0,
      pendingIntents: 0,
      writerInFlight: 0,
      observedAt: "2026-08-09T00:00:00.000Z",
    };
    const secondDrain = {
      ...firstDrain,
      observedAt: "2026-08-09T00:00:15.000Z",
    };
    const query = vi
      .fn()
      .mockReturnValueOnce(base)
      .mockReturnValueOnce(firstDrain)
      .mockReturnValueOnce(secondDrain);
    const sleep = vi.fn(async () => undefined);

    await expect(
      captureProductionWriterObservation(validEnv, { query, sleep }),
    ).resolves.toMatchObject({
      source: "production-postgresql-writer",
      rehearsal: false,
      databaseIdentity: base.databaseIdentity,
      isWriter: true,
      recoveryWitnessSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      databaseGenerationBinding: {
        consumedMigrationEvidence: expect.arrayContaining([
          expect.objectContaining({
            receiptVersion: 2,
            rolloutId: "rollout-historical",
          }),
          expect.objectContaining({
            receiptVersion: 4,
            rolloutId: "rollout-1",
          }),
        ]),
      },
      callerIdentity: {
        id: "release-migration",
        platform: "github-actions",
        rolloutId: "rollout-1",
        jobId: "202",
        receiptVersion: 4,
        systemIdentifier: "7612345678901234567",
        recoveryWitnessSha256: "f".repeat(64),
      },
      recoveryOwnerId: "setup-recovery:fetched",
      drainObservations: [
        {
          ...firstDrain,
          recoveryWitnessSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          ...secondDrain,
          recoveryWitnessSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
      migrationSources: [
        {
          id: "000060_codex_oauth_setup_serialization",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          id: "000061_codex_oauth_provider_mutation_fence",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          id: "000062_codex_oauth_remote_outcome_unknown",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          id: "000063_codex_oauth_setup_payload_claim",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          id: "000064_codex_oauth_versioned_secret_namespaces",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          id: "000065_codex_oauth_authority_acl_hardening",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          id: "000066_codex_oauth_rotating_cascade_authority",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(15_000);

    await expect(
      captureProductionWriterObservation(validEnv, {
        query: vi.fn().mockReturnValue({
          ...base,
          databaseGenerationBinding: {
            ...base.databaseGenerationBinding,
            consumedMigrationEvidence:
              base.databaseGenerationBinding.consumedMigrationEvidence.map(
                (receipt) =>
                  "receiptVersion" in receipt
                    ? { ...receipt, systemIdentifier: "7611111111111111111" }
                    : receipt,
              ),
          },
        }),
        sleep,
      }),
    ).rejects.toThrow(
      "database generation witness binding is absent or invalid",
    );

    await expect(
      captureProductionWriterObservation(validEnv, {
        query: vi.fn().mockReturnValue({
          ...base,
          databaseGenerationBinding: {
            ...base.databaseGenerationBinding,
            consumedMigrationEvidence:
              base.databaseGenerationBinding.consumedMigrationEvidence.map(
                (receipt, index) =>
                  index === 0 ? { ...receipt, unexpected: "field" } : receipt,
              ),
          },
        }),
        sleep,
      }),
    ).rejects.toThrow(
      "database generation witness binding is absent or invalid",
    );

    await expect(
      captureProductionWriterObservation(validEnv, {
        query: vi.fn().mockReturnValue({
          ...base,
          admittedRecoveryEvidence: {
            witnessFingerprints: [],
            databaseIncarnations: [],
          },
        }),
        sleep,
      }),
    ).rejects.toThrow("admitted recovery evidence does not match");

    await expect(
      captureProductionWriterObservation(
        {
          ...validEnv,
          REVIEW_ROUTER_RENDER_OBSERVATION_PATH: (() => {
            const path = join(
              mkdtempSync(join(tmpdir(), "rr-render-witness-")),
              "render.json",
            );
            writeFileSync(
              path,
              JSON.stringify({
                ...renderObservation,
                runtimeWitness: { sha256: "e".repeat(64) },
              }),
            );
            return path;
          })(),
        },
        {
          query: vi.fn().mockReturnValue(base),
          sleep,
        },
      ),
    ).rejects.toThrow("independently bound to the Render runtime secret");
  });

  it("rejects forged application labels when the database role is not canonical", async () => {
    const query = vi.fn().mockReturnValue({
      databaseCaller: {
        databaseRole: "reviewrouter_api",
        sessionUser: "reviewrouter_api",
        applicationName: "reviewrouter-release-migration",
      },
      isWriter: true,
    });
    await expect(
      captureProductionWriterObservation(validEnv, {
        query,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(
      "database caller is not the canonical writer release-migration role",
    );
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects a recovery owner identity production cannot create", async () => {
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "setup-recovery:%",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).toContain(
      "versioned-namespace-cutover:%",
    );
    expect(codexRotatingProductionWriterBaseObservationSql).not.toContain(
      "LIKE 'setup:%'",
    );
  });
});
