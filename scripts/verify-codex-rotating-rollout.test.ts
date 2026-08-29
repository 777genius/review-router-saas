import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  runCodexRotatingRolloutVerifierCli,
  verifyCodexRotatingDatabaseCatalog,
  inspectCodexRotatingRolloutStructure as verifyCodexRotatingRollout,
} from "./verify-codex-rotating-rollout.mjs";
import {
  codexRotatingCatalogCheckNames,
  codexRotatingCheckDefinitions,
  codexRotatingCatalogColumnKeys,
  codexRotatingCatalogForeignKeyNames,
  codexRotatingCatalogForeignKeys,
  codexRotatingCatalogIndexNames,
  codexRotatingCatalogTables,
  codexRotatingFunctionBodyDigests,
  codexRotatingFunctionIdentityArguments,
  codexRotatingIndexDefinitions,
  codexRotatingPartialIndexPredicates,
  codexRotatingFunctions,
  codexRotatingTriggers,
  codexRotatingCatalogColumns,
  codexRotatingPrimaryKeys,
  codexRotatingProviderRuntimeUpdateColumns,
} from "./codex-rotating-production-writer-schema.mjs";

const atomicSetupPayloadClaimReleaseChecksum =
  "33100d6f5f3f59cd9a4c22f041d19caba6a0e0be88de4a0ee4d543af50619481";
const versionedSecretNamespaceForwardChecksum =
  "4da4352108efd684a8bc6ddefa19353181a8a74758c32ed890527c2aec2ae666";
const authorityAclHardeningForwardChecksum =
  "ca8d554dd71cbdeaf0a66e007aa7ef391627c0a9d97b10a27e1113308087342c";
const rotatingCascadeAuthorityForwardChecksum =
  "3b9b6385fde3120793aff052ba00c1afbd09011585d73a8184d0e73de8934af8";
const v4V5WorkflowReattestationForwardChecksum =
  "d443e366de64879b1d6c32f4edba3648d8e8da160f804b6ec87bede581343109";

describe("observation-backed Codex rotating rollout verifier", () => {
  it("keeps the exhaustive column inventory synchronized with Prisma", () => {
    const schema = readFileSync(
      join(process.cwd(), "packages/platform/db/prisma/schema.prisma"),
      "utf8",
    );
    const scalarTypes =
      "(?:String|Int|BigInt|Boolean|DateTime|Json|Bytes|Float|Decimal)";
    const schemaColumnKeys = codexRotatingCatalogTables.flatMap((table) => {
      const body = new RegExp(`model ${table} \\{([\\s\\S]*?)\\n\\}`, "u").exec(
        schema,
      )?.[1];
      expect(body, `missing Prisma model ${table}`).toBeDefined();
      return [
        ...body!.matchAll(
          new RegExp(`^\\s+(\\w+)\\s+${scalarTypes}[?\\[\\]]*`, "gmu"),
        ),
      ].map((match) => `${table}.${match[1]}`);
    });

    expect([...codexRotatingCatalogColumnKeys].sort()).toEqual(
      schemaColumnKeys.sort(),
    );
  });

  it("keeps canonical function-body digests synchronized with final migration definitions", () => {
    const finalBodies = new Map<string, string>();
    for (const migration of [
      "000060_codex_oauth_setup_serialization",
      "000061_codex_oauth_provider_mutation_fence",
      "000062_codex_oauth_remote_outcome_unknown",
      "000063_codex_oauth_setup_payload_claim",
      "000064_codex_oauth_versioned_secret_namespaces",
      "000065_codex_oauth_authority_acl_hardening",
      "000066_codex_oauth_rotating_cascade_authority",
      "000073_codex_oauth_active_namespace_refresh",
      "000079_codex_oauth_v4_v5_workflow_reattestation",
      "000080_codex_oauth_reattestation_mutation_owner_fence",
    ]) {
      const sql = readFileSync(
        join(
          process.cwd(),
          `packages/platform/db/prisma/migrations/${migration}/migration.sql`,
        ),
        "utf8",
      );
      for (const match of sql.matchAll(
        /CREATE (?:OR REPLACE )?FUNCTION "([^"]+)"\s*\([\s\S]*?\)\s*RETURNS?\s+[\s\S]*?LANGUAGE plpgsql[\s\S]*?AS \$\$([\s\S]*?)\$\$;|DROP FUNCTION "([^"]+)"\s*\([^;]*\);/gu,
      )) {
        if (match[3]) finalBodies.delete(match[3]);
        else finalBodies.set(match[1]!, match[2]!);
      }
    }

    expect(
      [...finalBodies]
        .map(([name, body]) => ({
          name,
          bodySha256: digest(
            Buffer.from(body.replace(/\r\n?/gu, "\n").trim(), "utf8"),
          ),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([...codexRotatingFunctionBodyDigests]);
  });

  it("accepts digested executable/database observations", () => {
    const fixture = observedFixture();
    expect(
      verifyCodexRotatingRollout(fixture.evidence, fixture.options),
    ).toMatchObject({ ok: true, failures: [] });
  });

  it("rejects vacuous database evidence and unpaginated GitHub cohorts", () => {
    const fixture = observedFixture();
    fixture.artifacts.database.admittedRecoveryEvidence.sources[0].witnessPresentRows = 0;
    fixture.artifacts.workflowRuns.observations[0].rawResponses.find(
      (entry: any) => entry.body?.workflow_runs,
    ).nextUrl = "https://api.github.com/unbound-page";
    const failures = verifyCodexRotatingRollout(
      fixture.evidence,
      fixture.options,
    ).failures;
    expect(failures).toContain(
      "admitted recovery evidence is incomplete or not source-bound to this database generation",
    );
    expect(failures).toContain(
      "workflow-run inventory does not prove exact repository/workflow cohort pagination",
    );
  });

  it("rejects positive recovery row counts with vacuous source aggregates", () => {
    const fixture = observedFixture();
    fixture.artifacts.database.admittedRecoveryEvidence.sources[0].witnessFingerprints =
      [];
    fixture.artifacts.database.admittedRecoveryEvidence.sources[2].databaseIncarnations =
      [];

    expect(
      verifyCodexRotatingRollout(fixture.evidence, fixture.options).failures,
    ).toContain(
      "admitted recovery evidence is incomplete or not source-bound to this database generation",
    );
  });

  it("rejects substituted per-source incarnation requirements", () => {
    const fixture = observedFixture();
    const source =
      fixture.artifacts.database.admittedRecoveryEvidence.sources.find(
        (entry: any) => entry.source === "CodexOAuthSetupPayloadClaim",
      );
    source.incarnationRequired = false;
    source.incarnationPresentRows = 0;
    source.databaseIncarnations = [];

    expect(
      verifyCodexRotatingRollout(fixture.evidence, fixture.options).failures,
    ).toContain(
      "admitted recovery evidence is incomplete or not source-bound to this database generation",
    );
  });

  it("rejects a rewritten 000064 even when observed source and history agree with the rewrite", () => {
    const fixture = observedFixture();
    const sourcePath =
      "packages/platform/db/prisma/migrations/000064_codex_oauth_versioned_secret_namespaces/migration.sql";
    const rewritten = Buffer.from(
      "SELECT 'rewritten unpublished migration';\n",
    );
    const rewrittenDigest = digest(rewritten);
    const observedSource = fixture.artifacts.database.migrationSources.find(
      (entry: { id: string }) =>
        entry.id === "000064_codex_oauth_versioned_secret_namespaces",
    );
    const history = fixture.artifacts.database.history.find(
      (entry: { migration_name: string }) =>
        entry.migration_name ===
        "000064_codex_oauth_versioned_secret_namespaces",
    );
    observedSource.sha256 = rewrittenDigest;
    history.checksum = rewrittenDigest;
    fixture.options.readSource = (path: string) =>
      path.endsWith(sourcePath) ? rewritten : readFileSync(path);

    const result = verifyCodexRotatingRollout(
      fixture.evidence,
      fixture.options,
    );
    expect(result.failures).toContain(
      "000064_codex_oauth_versioned_secret_namespaces checked-in forward migration digest mismatched",
    );
    expect(versionedSecretNamespaceForwardChecksum).not.toBe(rewrittenDigest);
  });

  it("rejects stale 000079 digest evidence even when source and history agree", () => {
    const fixture = observedFixture();
    const sourcePath =
      "packages/platform/db/prisma/migrations/000079_codex_oauth_v4_v5_workflow_reattestation/migration.sql";
    const staleBytes = Buffer.from(
      readFileSync(sourcePath, "utf8").replace(
        "NOT IN (4, 5)",
        "NOT BETWEEN 1 AND 5",
      ),
    );
    const staleDigest = digest(staleBytes);
    expect(staleDigest).not.toBe(v4V5WorkflowReattestationForwardChecksum);
    const observedSource = fixture.artifacts.database.migrationSources.find(
      (entry: { id: string }) =>
        entry.id === "000079_codex_oauth_v4_v5_workflow_reattestation",
    );
    const history = fixture.artifacts.database.history.find(
      (entry: { migration_name: string }) =>
        entry.migration_name ===
        "000079_codex_oauth_v4_v5_workflow_reattestation",
    );
    observedSource.sha256 = staleDigest;
    history.checksum = staleDigest;
    fixture.options.readSource = (path: string) =>
      path.endsWith(sourcePath) ? staleBytes : readFileSync(path);

    expect(
      verifyCodexRotatingRollout(fixture.evidence, fixture.options).failures,
    ).toContain(
      "000079_codex_oauth_v4_v5_workflow_reattestation checked-in forward migration digest mismatched",
    );
  });

  it("reuses the exact production catalog verifier for PostgreSQL rehearsal", () => {
    const fixture = observedFixture();
    expect(
      verifyCodexRotatingDatabaseCatalog(fixture.artifacts.database.catalog),
    ).toEqual({ ok: true, failures: [] });
  });

  it("can isolate structural migration checks from externally provisioned role ACLs", () => {
    const fixture = observedFixture();
    fixture.artifacts.database.catalog.privileges = {
      functions: [],
      tables: [],
    };
    expect(
      verifyCodexRotatingDatabaseCatalog(fixture.artifacts.database.catalog, {
        verifyPrivileges: false,
      }),
    ).toEqual({ ok: true, failures: [] });
    expect(
      verifyCodexRotatingDatabaseCatalog(fixture.artifacts.database.catalog).ok,
    ).toBe(false);
  });

  it("rejects fully invented legacy self-reported evidence", () => {
    const invented = {
      version: 1,
      targetCommit: "a".repeat(40),
      migration: {
        id: "000060_codex_oauth_setup_serialization",
        succeeded: true,
      },
      applications: [{ name: "api", commit: "a".repeat(40) }],
      compatibilityProbe: { result: { cases: [] } },
    };
    const result = verifyCodexRotatingRollout(invented);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      "evidence must use receipt-bound version 3",
    );
    expect(result.failures).toContain(
      "top-level self-reported rollout fields are prohibited",
    );
  });

  it("rejects a fully invented v2 bundle even when its artifact byte digests match", () => {
    const artifacts = Object.fromEntries(
      [
        "database",
        "deployments",
        "compatibilityProbe",
        "events",
        "canaryRuntime",
        "workflowRuns",
      ].map((name) => [name, { succeeded: true, passed: true }]),
    );
    const evidence: any = { version: 2, artifacts: {} };
    for (const [name, value] of Object.entries(artifacts)) {
      evidence.artifacts[name] = {
        path: `artifacts/${name}.json`,
        sha256: digest(Buffer.from(JSON.stringify(value))),
        ...(name === "compatibilityProbe"
          ? {
              sourceFile:
                "apps/web/src/server/codex-rotating-one-shot-curl.real.test.ts",
              sourceFileSha256: digest(
                readFileSync(
                  join(
                    process.cwd(),
                    "apps/web/src/server/codex-rotating-one-shot-curl.real.test.ts",
                  ),
                ),
              ),
            }
          : {}),
      };
    }
    const result = verifyCodexRotatingRollout(evidence, {
      readArtifact: (path: string) =>
        Buffer.from(
          JSON.stringify(artifacts[path.match(/([^/]+)\.json$/u)![1]]),
        ),
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        "database observation must come from the actual production writer",
        "deployments must be captured from the Render API",
        "compatibility probe did not execute successfully",
        "events artifact source is invalid",
      ]),
    );
  });

  it("rejects forged digests, missing migration history, unsafe work, and old rollback floor", () => {
    const fixture = observedFixture();
    fixture.evidence.artifacts.database.sha256 = "0".repeat(64);
    fixture.artifacts.database.history.pop();
    fixture.artifacts.database.unsafeWork.pendingIntents = 1;
    fixture.artifacts.deployments.services[0].preDeployCommand =
      "pnpm db:migrate";
    fixture.artifacts.deployments.services[0].serviceMigrationCallerEnabled = true;
    fixture.artifacts.compatibilityProbe.cases[0].observations.replayStatus = 500;
    fixture.artifacts.events.events.find(
      (entry: any) => entry.type === "workflow_v2_published",
    ).v2IssuanceCount = 1;
    fixture.artifacts.events.rollbackFloorCommit = "e642d1ed";
    const result = verifyCodexRotatingRollout(
      fixture.evidence,
      fixture.options,
    );
    expect(result.failures).toEqual(
      expect.arrayContaining([
        "database artifact digest mismatched",
        "database observation has unsafe active work",
        "Render services still expose independent migration callers",
        "compatibility probe cases are missing executable observations or derived digests",
        "v2 issuance was observed before v1/v2 installer and workflow publication",
        "000080_codex_oauth_reattestation_mutation_owner_fence migration history is not exactly one current success",
        "rollback floor must be the fence-aware deployed commit",
      ]),
    );
  });

  it("refuses local artifact paths at the authorizing CLI boundary", async () => {
    const fixture = observedFixture();
    const directory = mkdtempSync(join(tmpdir(), "rr-observed-rollout-"));
    mkdirSync(join(directory, "artifacts"));
    for (const [name, value] of Object.entries(fixture.artifacts))
      writeFileSync(
        join(directory, `artifacts/${name}.json`),
        JSON.stringify(value),
      );
    const evidencePath = join(directory, "evidence.json");
    writeFileSync(evidencePath, JSON.stringify(fixture.evidence));
    let output = "";
    let errors = "";
    expect(
      await runCodexRotatingRolloutVerifierCli([evidencePath], {
        stdout: { write: (v: string) => (output += v) },
        stderr: { write: (v: string) => (errors += v) },
      }),
      errors,
    ).toBe(1);
    expect(output).toBe("");
    expect(errors).toContain("REVIEW_ROUTER_ROLLOUT");
    writeFileSync(join(directory, "artifacts/database.json"), "{}\n");
    expect(
      await runCodexRotatingRolloutVerifierCli([evidencePath], {
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      }),
    ).toBe(1);
  });

  it.each([
    [
      "canary with one flag off",
      (fixture: any) => {
        fixture.artifacts.canaryRuntime.flags.newWorkAdmission = "0";
      },
      "canary runtime did not observe all cutover flags enabled",
    ],
    [
      "canary with setup issuance off",
      (fixture: any) => {
        fixture.artifacts.canaryRuntime.flags.setupIssuance = "0";
      },
      "canary runtime did not observe all cutover flags enabled",
    ],
    [
      "canary allowlist wider than one target",
      (fixture: any) => {
        fixture.artifacts.canaryRuntime.approvedRepositories.push(
          "reviewrouter/other",
        );
      },
      "canary runtime was not restricted to exactly one disposable target",
    ],
    [
      "allowlist deletion before flags close",
      (fixture: any) => {
        const entry = fixture.artifacts.events.events.find(
          (candidate: any) => candidate.type === "canary_allowlist_deleted",
        );
        entry.runtimeFlag = "1";
      },
      "clearing the canary allowlist while admission is on is prohibited",
    ],
    [
      "empty widening cohort",
      (fixture: any) => {
        const entry = fixture.artifacts.events.events.find(
          (candidate: any) => candidate.type === "widening_approved",
        );
        entry.approvedRepositories = [];
      },
      "widening requires a nonempty explicit approved cohort",
    ],
    [
      "new v3 workflow arrival",
      (fixture: any) => {
        fixture.artifacts.workflowRuns.observations[1].runs.push({
          runId: "101",
          status: "queued",
          workflowSchemaVersion: 3,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          headSha: "6".repeat(40),
        });
      },
      "new queued/in-progress supported workflow-schema work arrived between observations",
    ],
    [
      "new v4 workflow arrival",
      (fixture: any) => {
        fixture.artifacts.workflowRuns.observations[1].runs.push({
          runId: "102",
          status: "in_progress",
          workflowSchemaVersion: 4,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          headSha: "7".repeat(40),
        });
      },
      "new queued/in-progress supported workflow-schema work arrived between observations",
    ],
    [
      "new v5 workflow arrival",
      (fixture: any) => {
        fixture.artifacts.workflowRuns.observations[1].runs.push({
          runId: "103",
          status: "queued",
          workflowSchemaVersion: 5,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          headSha: "8".repeat(40),
        });
      },
      "new queued/in-progress supported workflow-schema work arrived between observations",
    ],
    [
      "unknown future workflow schema",
      (fixture: any) => {
        fixture.artifacts.workflowRuns.observations[0].runs.push({
          runId: "104",
          status: "queued",
          workflowSchemaVersion: 6,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          headSha: "8".repeat(40),
        });
      },
      "queued/in-progress supported workflow-schema inventory is incomplete",
    ],
    [
      "omitted v5 schema inventory",
      (fixture: any) => {
        fixture.artifacts.workflowRuns.observations[1].inventoriedWorkflowSchemaVersions =
          [1, 2, 3, 4];
      },
      "queued/in-progress supported workflow-schema inventory is incomplete",
    ],
    [
      "non-production database artifact",
      (fixture: any) => {
        fixture.artifacts.database.rehearsal = true;
      },
      "database observation must come from the actual production writer",
    ],
    [
      "operator-authored database artifact generator",
      (fixture: any) => {
        fixture.evidence.artifacts.database.sourceFile =
          "scripts/check-codex-rotating-migration-rehearsal.mjs";
      },
      "production database capture executable source digest mismatched",
    ],
    [
      "unidentified database caller",
      (fixture: any) => {
        fixture.artifacts.database.callerIdentity.applicationName = "psql";
      },
      "production migration caller is not the canonical database role and trusted GitHub receipt",
    ],
    [
      "forged release application label on a runtime role",
      (fixture: any) => {
        fixture.artifacts.database.callerIdentity.databaseRole =
          "reviewrouter_api";
        fixture.artifacts.database.callerIdentity.sessionUser =
          "reviewrouter_api";
      },
      "production migration caller is not the canonical database role and trusted GitHub receipt",
    ],
    [
      "relationally spliced caller and receipt",
      (fixture: any) => {
        fixture.artifacts.database.callerIdentity.artifactId = "999";
      },
      "production migration caller must match exactly one unspliced database receipt",
    ],
    [
      "missing caller receipt for the trusted rollout",
      (fixture: any) => {
        fixture.artifacts.database.callerIdentity.rolloutId = "rollout-other";
      },
      "release-migration caller is not derived from the exact rollout receipt",
    ],
    [
      "receipt commit does not match deployed services",
      (fixture: any) => {
        const commit = "c".repeat(40);
        fixture.artifacts.database.callerIdentity.commit = commit;
        fixture.artifacts.database.databaseGenerationBinding.consumedMigrationEvidence[0].commit =
          commit;
      },
      "release-migration caller is not bound to the deployed immutable release",
    ],
    [
      "receipt image does not match deployed services",
      (fixture: any) => {
        const imageDigest = `sha256:${"c".repeat(64)}`;
        fixture.artifacts.database.callerIdentity.imageDigest = imageDigest;
        fixture.artifacts.database.databaseGenerationBinding.consumedMigrationEvidence[0].imageDigest =
          imageDigest;
      },
      "release-migration caller is not bound to the deployed immutable release",
    ],
    [
      "runtime role with DDL privilege",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_api",
        ).schemaCreate = true;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "role replication attribute drift",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_api",
        ).replication = true;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "canonical schema ownership changed",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.schemaOwner =
          "reviewrouter_release_migration";
      },
      "database bootstrap ownership, schema DDL ownership, and canonical role inventory are not exclusive",
    ],
    [
      "runtime role can update repository configuration",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_api",
        ).repositoryConnectionUpdate = true;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "runtime role lost repository read access",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_api",
        ).repositoryConnectionSelect = false;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "runtime role lost ordinary application table access",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_web",
        ).providerSetupStateSelect = false;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "runtime role lost sequence usage",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_worker",
        ).allSequenceUsage = false;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "runtime role can access authority tables",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_api",
        ).authorityTablePrivileges = true;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "effect authority gained sequence usage",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_codex_effect_authority",
        ).allSequenceUsage = true;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "runtime role can insert repository configuration",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_api",
        ).repositoryConnectionInsert = true;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "runtime role can delete repository configuration",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_api",
        ).repositoryConnectionDelete = true;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "runtime role can set the release owner role",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_api",
        ).canSetReleaseRole = true;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "effect authority can read repository configuration",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_codex_effect_authority",
        ).repositoryConnectionSelect = true;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "runtime role has column-level repository update",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_api",
        ).repositoryConnectionColumnUpdate = ["updatedAt"];
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "release migration role gains repository update columns",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_release_migration",
        ).repositoryConnectionColumnUpdate = ["id"];
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "canonical memberships have more than one external grantor authority",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.memberships[0].grantor =
          "second_platform_role_authority";
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "bootstrap has an extra membership edge to an unrelated role",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.memberships.push({
          role: "unrelated_role",
          member: "reviewrouter_role_bootstrap",
          grantor: "platform_role_authority",
          adminOption: true,
          inheritOption: false,
          setOption: false,
        });
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "runtime role inherits the release role",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.memberships.push({
          role: "reviewrouter_release_migration",
          member: "reviewrouter_api",
          grantor: "reviewrouter_release_migration",
          adminOption: false,
          inheritOption: true,
          setOption: false,
        });
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "runtime role can forge migration history",
      (fixture: any) => {
        fixture.artifacts.database.databaseAuthorization.roles.find(
          (role: any) => role.name === "reviewrouter_api",
        ).migrationHistoryPrivileges = true;
      },
      "runtime database roles can perform DDL or assume the release-migration role",
    ],
    [
      "PostgreSQL major mismatch",
      (fixture: any) => {
        fixture.artifacts.database.postgresVersion = "16.9";
      },
      "database observation is not PostgreSQL 17",
    ],
    [
      "Render PostgreSQL major mismatch",
      (fixture: any) => {
        fixture.artifacts.deployments.database.version = "16";
      },
      "Render database observation is not PostgreSQL 17",
    ],
    [
      "obsolete Render migration caller observation",
      (fixture: any) => {
        fixture.artifacts.deployments.migrationCallers = [];
      },
      "deployments must be captured from the Render API",
    ],
    [
      "duplicate migration receipt for the rollout",
      (fixture: any) => {
        fixture.artifacts.database.databaseGenerationBinding.consumedMigrationEvidence.push(
          {
            ...fixture.artifacts.database.databaseGenerationBinding
              .consumedMigrationEvidence[0],
            artifactDigest: `sha256:${"c".repeat(64)}`,
            artifactId: "304",
            jobId: "203",
          },
        );
      },
      "production migration caller must match exactly one unspliced database receipt",
    ],
    [
      "read replica database artifact",
      (fixture: any) => {
        fixture.artifacts.database.isWriter = false;
      },
      "database observation is not from a writer",
    ],
    [
      "drain sample from another database incarnation",
      (fixture: any) => {
        fixture.artifacts.database.drainObservations[1].databaseIdentity.systemIdentifier =
          "7699999999999999999";
      },
      "drain observations are not bound to one database incarnation and recovery witness",
    ],
    [
      "drain sample from another recovery witness",
      (fixture: any) => {
        fixture.artifacts.database.drainObservations[1].recoveryWitnessSha256 =
          "0".repeat(64);
      },
      "drain observations are not bound to one database incarnation and recovery witness",
    ],
    [
      "fabricated legacy setup owner",
      (fixture: any) => {
        fixture.artifacts.database.recoveryOwnerId = "setup:fabricated";
      },
      "production recovery owner identity is invalid",
    ],
    [
      "deployment without immutable Render IDs",
      (fixture: any) => {
        fixture.artifacts.deployments.services[0].deployId = null;
      },
      "Render deployment service names, roles, or immutable IDs are invalid",
    ],
    [
      "substituted deployment commit fact",
      (fixture: any) => {
        fixture.artifacts.deployments.services[0].commit = "0".repeat(40);
      },
      "Render deployment facts are not derivable from immutable raw API responses",
    ],
    [
      "duplicate Render runtime service identity",
      (fixture: any) => {
        fixture.artifacts.deployments.services[1].serviceId =
          fixture.artifacts.deployments.services[0].serviceId;
      },
      "Render deployment service identities are not unique",
    ],
    [
      "omitted after-phase runtime witness observation",
      (fixture: any) => {
        fixture.artifacts.deployments.runtimeWitness.observations.pop();
      },
      "Render runtime witness observation is absent, mixed, or not source-bound",
    ],
  ])("rejects terminal transition: %s", (_name, mutate, expected) => {
    const fixture = observedFixture();
    mutate(fixture);
    expect(
      verifyCodexRotatingRollout(
        fixture.evidence,
        fixture.options,
      ).failures.some(
        (failure) => failure === expected || failure.startsWith(`${expected}:`),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "missing table",
      (catalog: any) => catalog.tables.pop(),
      "database owned table catalog is not exact",
    ],
    [
      "unexpected table",
      (catalog: any) =>
        catalog.tables.push({
          name: "UnexpectedNamespaceLedger",
          kind: "r",
          persistence: "p",
          rowSecurity: false,
          forceRowSecurity: false,
        }),
      "database owned table catalog is not exact",
    ],
    [
      "altered column type",
      (catalog: any) => (catalog.columns[0].type = "integer"),
      "database owned column catalog is not exact",
    ],
    [
      "unexpected column omitted by the detailed manifest",
      (catalog: any) =>
        catalog.inventory.columns.push("CodexOAuthLease.unexpectedFenceGap"),
      "database rotating OAuth catalog inventory is not exact",
    ],
    [
      "unexpected check omitted by the detailed manifest",
      (catalog: any) => catalog.inventory.checks.push("unexpected_check"),
      "database rotating OAuth catalog inventory is not exact",
    ],
    [
      "unexpected index omitted by the detailed manifest",
      (catalog: any) => catalog.inventory.indexes.push("unexpected_index"),
      "database rotating OAuth catalog inventory is not exact",
    ],
    [
      "unexpected foreign key omitted by the detailed manifest",
      (catalog: any) =>
        catalog.inventory.foreignKeys.push("unexpected_foreign_key"),
      "database rotating OAuth catalog inventory is not exact",
    ],
    [
      "unexpected trigger",
      (catalog: any) => catalog.inventory.triggers.push("unexpected_trigger"),
      "database rotating OAuth catalog inventory is not exact",
    ],
    [
      "unexpected function",
      (catalog: any) => catalog.inventory.functions.push("codex_oauth_rogue"),
      "database rotating OAuth catalog inventory is not exact",
    ],
    [
      "duplicate catalog object",
      (catalog: any) =>
        catalog.inventory.indexes.push(catalog.inventory.indexes[0]),
      "database rotating OAuth catalog inventory is not exact",
    ],
    [
      "missing foreign key",
      (catalog: any) => catalog.foreignKeys.pop(),
      "database recovery-ledger foreign keys are not exact",
    ],
    [
      "invalid check",
      (catalog: any) =>
        (catalog.checks[0].validated = !catalog.checks[0].validated),
      "database check definitions/validation flags are not exact",
    ],
    [
      "same-token check weakened with AND false",
      (catalog: any) => {
        const check = catalog.checks.find(
          (entry: any) =>
            entry.name === "CodexOAuthProviderInstance_mutation_fence_check",
        );
        check.definition = `${check.definition} AND false`;
        check.definitionSha256 = digest(Buffer.from(check.definition));
      },
      "database check definitions/validation flags are not exact",
    ],
    [
      "missing unique index",
      (catalog: any) => catalog.indexes.pop(),
      "database index catalog is not exact",
    ],
    [
      "altered partial predicate",
      (catalog: any) => {
        const index = catalog.indexes.find(
          (entry: any) =>
            entry.name ===
            "CodexOAuthSetupRecoveryRequest_one_active_provider_key",
        );
        index.predicate = "state = 'completed'";
        index.definition = index.definition.replace(
          /WHERE .+$/u,
          "WHERE state = 'completed'",
        );
        index.predicateSha256 = digest(Buffer.from(index.predicate));
        index.definitionSha256 = digest(Buffer.from(index.definition));
      },
      "database index definitions/flags are not exact",
    ],
    [
      "same-token partial predicate weakened with AND false",
      (catalog: any) => {
        const index = catalog.indexes.find(
          (entry: any) =>
            entry.name ===
            "CodexOAuthSetupRecoveryRequest_one_active_provider_key",
        );
        index.predicate = `${index.predicate} AND false`;
        index.predicateSha256 = digest(Buffer.from(index.predicate));
        index.definition = `${index.definition} AND false`;
        index.definitionSha256 = digest(Buffer.from(index.definition));
      },
      "database index definitions/flags are not exact",
    ],
    [
      "altered trigger binding",
      (catalog: any) => (catalog.triggers[0].function = "wrong_guard"),
      "database trigger bindings are not exact",
    ],
    [
      "trigger definition gains a conditional bypass",
      (catalog: any) => {
        catalog.triggers[0].definition += " WHEN (false)";
        catalog.triggers[0].whenExpression = "false";
      },
      "database trigger bindings are not exact",
    ],
    [
      "reattestation routine is dropped",
      (catalog: any) => {
        catalog.functions = catalog.functions.filter(
          (entry: any) =>
            entry.name !== "codex_oauth_reattest_active_namespace_v4_to_v5",
        );
        catalog.inventory.functions = catalog.inventory.functions.filter(
          (name: string) =>
            name !== "codex_oauth_reattest_active_namespace_v4_to_v5",
        );
      },
      "database rotating OAuth catalog inventory is not exact",
    ],
    [
      "reattestation routine body is replaced",
      (catalog: any) => {
        catalog.functions.find(
          (entry: any) =>
            entry.name === "codex_oauth_reattest_active_namespace_v4_to_v5",
        ).bodySha256 = digest(Buffer.from("BEGIN RETURN; END"));
      },
      "database trigger function definitions are not exact",
    ],
    [
      "reattestation routine owner is changed",
      (catalog: any) => {
        catalog.functions.find(
          (entry: any) =>
            entry.name === "codex_oauth_reattest_active_namespace_v4_to_v5",
        ).owner = "reviewrouter_web";
      },
      "database trigger function definitions are not exact",
    ],
    [
      "same-token weakened function body",
      (catalog: any) => {
        catalog.functions.find(
          (entry: any) =>
            entry.name === "codex_oauth_child_identity_fence_guard",
        ).bodySha256 = digest(
          Buffer.from("BEGIN\n  PERFORM 'mutationOwner';\n  RETURN NEW;\nEND"),
        );
      },
      "database trigger function definitions are not exact",
    ],
    [
      "function changed to a non-function pg_proc kind",
      (catalog: any) => (catalog.functions[0].prokind = "p"),
      "database trigger function definitions are not exact",
    ],
    [
      "locking guard owner changed",
      (catalog: any) =>
        (catalog.functions.find(
          (entry: any) => entry.name === "codex_oauth_provider_identity_guard",
        ).owner = "reviewrouter_api"),
      "database trigger function definitions are not exact",
    ],
    [
      "function changed to return a set",
      (catalog: any) => (catalog.functions[0].proretset = true),
      "database trigger function definitions are not exact",
    ],
    [
      "function attached to planner support code",
      (catalog: any) =>
        (catalog.functions[0].prosupport = "malicious_planner_support"),
      "database trigger function definitions are not exact",
    ],
    [
      "function planner cost changed",
      (catalog: any) => (catalog.functions[0].procost = 1),
      "database trigger function definitions are not exact",
    ],
    [
      "function planner row estimate changed",
      (catalog: any) => (catalog.functions[0].prorows = 1),
      "database trigger function definitions are not exact",
    ],
    [
      "same-name foreign key with wrong local columns",
      (catalog: any) => {
        const foreignKey = catalog.foreignKeys.find(
          (entry: any) =>
            entry.name === "CodexOAuthSetupPayloadClaim_provider_fkey",
        );
        foreignKey.definition = foreignKey.definition.replace(
          'FOREIGN KEY ("providerInstanceRowId")',
          'FOREIGN KEY ("repositoryId")',
        );
      },
      "database recovery-ledger foreign keys are not exact",
    ],
    [
      "same-name foreign key with wrong target",
      (catalog: any) => {
        const foreignKey = catalog.foreignKeys.find(
          (entry: any) =>
            entry.name === "CodexOAuthSetupPayloadClaim_provider_fkey",
        );
        foreignKey.definition = foreignKey.definition.replace(
          'REFERENCES "CodexOAuthProviderInstance"(id)',
          'REFERENCES "Workspace"(id)',
        );
      },
      "database recovery-ledger foreign keys are not exact",
    ],
    [
      "same-name foreign key with wrong update action",
      (catalog: any) => {
        const foreignKey = catalog.foreignKeys.find(
          (entry: any) =>
            entry.name ===
            "CodexOAuthSetupRecoveryRequest_providerInstanceRowId_fkey",
        );
        foreignKey.definition = foreignKey.definition.replace(
          "ON UPDATE CASCADE",
          "ON UPDATE NO ACTION",
        );
      },
      "database recovery-ledger foreign keys are not exact",
    ],
    [
      "same-name legacy foreign key with weakened delete action",
      (catalog: any) => {
        const foreignKey = catalog.foreignKeys.find(
          (entry: any) => entry.name === "CodexOAuthLease_repositoryId_fkey",
        );
        foreignKey.definition = foreignKey.definition.replace(
          "ON DELETE CASCADE",
          "ON DELETE SET NULL",
        );
      },
      "database recovery-ledger foreign keys are not exact",
    ],
    [
      "same-name weakened lease uniqueness barrier",
      (catalog: any) => {
        const index = catalog.indexes.find(
          (entry: any) => entry.name === "CodexOAuthLease_leaseKey_key",
        );
        index.unique = false;
      },
      "database index definitions/flags are not exact",
    ],
    [
      "same-name weakened idempotency uniqueness barrier",
      (catalog: any) => {
        const index = catalog.indexes.find(
          (entry: any) =>
            entry.name ===
            "CodexOAuthWritebackIntent_providerInstanceId_idempotencyKey_key",
        );
        index.keys = ["providerInstanceId"];
        index.keyCount = 1;
      },
      "database index definitions/flags are not exact",
    ],
    [
      "unexpected PUBLIC table grant",
      (catalog: any) =>
        catalog.privileges.tables.push({
          name: "CodexOAuthProviderInstance",
          grantee: "PUBLIC",
          grantor: "reviewrouter_release_migration",
          privilege: "UPDATE",
          grantable: false,
        }),
      "database owned table privileges are not exact",
    ],
    [
      "broadened function privilege",
      (catalog: any) =>
        (catalog.privileges.functions.find((entry: any) =>
          entry.name.includes("tombstone_guard"),
        ).publicExecute = true),
      "database owned function privileges are not exact",
    ],
    [
      "runtime role can invoke isolated effect signer",
      (catalog: any) =>
        catalog.privileges.functions.push({
          name: "codex_oauth_sign_database_authority",
          grantee: "reviewrouter_api",
          grantor: "reviewrouter_release_migration",
          privilege: "EXECUTE",
          grantable: false,
        }),
      "database owned function privileges are not exact",
    ],
    [
      "runtime role can invoke provider identity guard directly",
      (catalog: any) =>
        catalog.privileges.functions.push({
          name: "codex_oauth_provider_identity_guard",
          grantee: "reviewrouter_api",
          grantor: "reviewrouter_release_migration",
          privilege: "EXECUTE",
          grantable: false,
        }),
      "database owned function privileges are not exact",
    ],
    [
      "reattestation routine is executable by the API role",
      (catalog: any) =>
        catalog.privileges.functions.push({
          name: "codex_oauth_reattest_active_namespace_v4_to_v5",
          identityArguments:
            codexRotatingFunctionIdentityArguments[
              "codex_oauth_reattest_active_namespace_v4_to_v5"
            ],
          grantee: "reviewrouter_api",
          grantor: "reviewrouter_release_schema_owner",
          privilege: "EXECUTE",
          grantable: false,
        }),
      "database owned function privileges are not exact",
    ],
    [
      "effect authority can read signing key",
      (catalog: any) =>
        catalog.privileges.tables.push({
          name: "CodexOAuthDatabaseAuthorityKey",
          grantee: "reviewrouter_codex_effect_authority",
          grantor: "reviewrouter_release_migration",
          privilege: "SELECT",
          grantable: false,
        }),
      "database owned table privileges are not exact",
    ],
  ])("rejects catalog mutation: %s", (_name, mutate, expected) => {
    const fixture = observedFixture();
    mutate(fixture.artifacts.database.catalog);
    expect(
      verifyCodexRotatingRollout(
        fixture.evidence,
        fixture.options,
      ).failures.some(
        (failure) => failure === expected || failure.startsWith(`${expected}:`),
      ),
    ).toBe(true);
  });
});

function observedFixture(): any {
  const commit = "a".repeat(40);
  const imageDigest = `sha256:${"b".repeat(64)}`;
  const sourceDigest = (path: string) =>
    digest(readFileSync(join(process.cwd(), path)));
  const checkDefinitionDigests = new Map(
    codexRotatingCheckDefinitions.map((entry) => [
      entry.name,
      entry.definitionSha256,
    ]),
  );
  const indexDefinitionDigests = new Map(
    codexRotatingIndexDefinitions.map((entry) => [
      entry.name,
      entry.definitionSha256,
    ]),
  );
  const predicateDigests = new Map(
    codexRotatingPartialIndexPredicates.map((entry) => [
      entry.name,
      entry.predicateSha256,
    ]),
  );
  const artifacts: any = {
    database: {
      observationVersion: 6,
      source: "production-postgresql-writer",
      captureKind: "database-query",
      rehearsal: false,
      effectivePrincipalInventory: {
        version: 1,
        database: "review_router",
        sessionPrincipal: "reviewrouter_release_migration",
        roles: [],
        memberships: [],
        grants: [],
      },
      effectivePrincipalDecision: {
        accepted: true,
        inventorySha256: `sha256:${"8".repeat(64)}`,
        policySha256: `sha256:${"9".repeat(64)}`,
        violations: [],
        effectivePermissions: {},
      },
      databaseIdentity: {
        currentDatabase: "review_router",
        currentSchema: "public",
        serverAddress: "10.0.0.10:5432",
        systemIdentifier: "7612345678901234567",
      },
      isWriter: true,
      recoveryWitnessSha256: "f".repeat(64),
      databaseGenerationBinding: {
        version: 4,
        systemIdentifier: "7612345678901234567",
        recoveryWitnessSha256: "f".repeat(64),
        consumedMigrationEvidence: [
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
            commit,
            imageDigest,
            systemIdentifier: "7612345678901234567",
            recoveryWitnessSha256: "f".repeat(64),
            claimedAt: "2026-08-10T00:00:00.000Z",
          },
          {
            artifactDigest: `sha256:${"c".repeat(64)}`,
            artifactId: "300",
            rolloutId: "rollout-historical",
            runId: "99",
            claimedAt: "2026-08-09T00:00:00.000Z",
          },
        ],
      },
      admittedRecoveryEvidence: {
        sources: [
          ["CodexOAuthSecretNamespace", false],
          ["CodexOAuthSetupManifest", false],
          ["CodexOAuthSetupPayloadClaim", true],
          ["CodexOAuthSetupRecoveryRequest", false],
          ["CodexOAuthWritebackIntent", true],
        ].map(([source, incarnationRequired]) => ({
          source,
          totalRows: 1,
          witnessPresentRows: 1,
          incarnationRequired,
          incarnationPresentRows: incarnationRequired ? 1 : 0,
          witnessFingerprints: ["f".repeat(64)],
          databaseIncarnations: incarnationRequired
            ? ["7612345678901234567"]
            : [],
        })),
      },
      databaseAuthorization: {
        databaseOwner: "reviewrouter_role_bootstrap",
        schemaOwner: "reviewrouter_release_schema_owner",
        roles: [
          "reviewrouter_release_migration",
          "reviewrouter_codex_effect_authority",
          "reviewrouter_api",
          "reviewrouter_web",
          "reviewrouter_worker",
        ].map((name) => {
          const release = name === "reviewrouter_release_migration";
          const runtime = [
            "reviewrouter_api",
            "reviewrouter_web",
            "reviewrouter_worker",
          ].includes(name);
          const repositoryColumns = [
            "archived",
            "createdAt",
            "defaultBranch",
            "externalRepositoryId",
            "fullName",
            "githubRepositoryId",
            "id",
            "installationId",
            "provider",
            "updatedAt",
            "workspaceId",
          ];
          return {
            name,
            allSequenceUsage: runtime,
            anySequenceSelectOrUpdate: false,
            authorityTablePrivileges: false,
            canLogin: true,
            superuser: false,
            createDatabase: false,
            createRole: false,
            replication: false,
            bypassRls: false,
            databaseCreate: false,
            schemaCreate: false,
            schemaUsage: true,
            canSetReleaseRole: release,
            ownsCatalogObject: false,
            ownsRepositoryConnection: false,
            ddlTablePrivileges: false,
            migrationHistoryPrivileges: release,
            providerSetupStateSelect: runtime,
            providerSetupStateInsert: runtime,
            providerSetupStateUpdate: runtime,
            providerSetupStateDelete: runtime,
            repositoryConnectionSelect: runtime,
            repositoryConnectionInsert: false,
            repositoryConnectionUpdate: false,
            repositoryConnectionDelete: false,
            repositoryConnectionColumnSelect: runtime ? repositoryColumns : [],
            repositoryConnectionColumnInsert: [],
            repositoryConnectionColumnUpdate: [],
            repositoryConnectionColumnReferences: [],
          };
        }),
        memberships: [
          "reviewrouter_api",
          "reviewrouter_codex_effect_authority",
          "reviewrouter_release_migration",
          "reviewrouter_web",
          "reviewrouter_worker",
        ].map((role) => ({
          role,
          member: "reviewrouter_role_bootstrap",
          grantor: "platform_role_authority",
          adminOption: true,
          inheritOption: false,
          setOption: false,
        })),
        releaseRoleSettableByLoginRoles: ["reviewrouter_release_migration"],
        nonReleaseOwnedCatalogObjects: [],
        nonReleaseOwnedFunctions: [],
      },
      callerIdentity: {
        id: "release-migration",
        kind: "trusted-github-release-migration",
        commit,
        imageDigest,
        platform: "github-actions",
        receiptVersion: 4,
        artifactDigest: `sha256:${"a".repeat(64)}`,
        artifactId: "303",
        rolloutId: "rollout-1",
        runId: "101",
        runAttempt: 1,
        jobId: "202",
        workflowPath: ".github/workflows/codex-rotating-release-migration.yml",
        claimedAt: "2026-08-10T00:00:00.000Z",
        systemIdentifier: "7612345678901234567",
        recoveryWitnessSha256: "f".repeat(64),
        databaseRole: "reviewrouter_release_migration",
        sessionUser: "reviewrouter_release_migration",
      },
      drainObservations: [
        {
          databaseIdentity: {
            currentDatabase: "review_router",
            currentSchema: "public",
            serverAddress: "10.0.0.10:5432",
            systemIdentifier: "7612345678901234567",
          },
          isWriter: true,
          recoveryWitnessSha256: "f".repeat(64),
          activeLeases: 0,
          fetchedSetups: 0,
          pendingIntents: 0,
          writerInFlight: 0,
          observedAt: "2026-08-09T00:03:10Z",
        },
        {
          databaseIdentity: {
            currentDatabase: "review_router",
            currentSchema: "public",
            serverAddress: "10.0.0.10:5432",
            systemIdentifier: "7612345678901234567",
          },
          isWriter: true,
          recoveryWitnessSha256: "f".repeat(64),
          activeLeases: 0,
          fetchedSetups: 0,
          pendingIntents: 0,
          writerInFlight: 0,
          observedAt: "2026-08-09T00:03:40Z",
        },
      ],
      postgresVersion: "17.6",
      unsafeWork: {
        activeLeasesWithoutPositiveEpoch: 0,
        activeManifestsWithoutPositiveEpoch: 0,
        pendingIntents: 0,
        pendingIntentsWithoutPositiveEpoch: 0,
      },
      recoveryOwnerId: "setup-recovery:fetched-new",
      catalogManifest: {
        sourceFile: "scripts/codex-rotating-production-writer-schema.mjs",
        sha256: sourceDigest(
          "scripts/codex-rotating-production-writer-schema.mjs",
        ),
      },
      migrationSources: [
        {
          id: "000060_codex_oauth_setup_serialization",
          sha256: sourceDigest(
            "packages/platform/db/prisma/migrations/000060_codex_oauth_setup_serialization/migration.sql",
          ),
        },
        {
          id: "000061_codex_oauth_provider_mutation_fence",
          sha256: sourceDigest(
            "packages/platform/db/prisma/migrations/000061_codex_oauth_provider_mutation_fence/migration.sql",
          ),
        },
        {
          id: "000062_codex_oauth_remote_outcome_unknown",
          sha256: sourceDigest(
            "packages/platform/db/prisma/migrations/000062_codex_oauth_remote_outcome_unknown/migration.sql",
          ),
        },
        {
          id: "000063_codex_oauth_setup_payload_claim",
          sha256: atomicSetupPayloadClaimReleaseChecksum,
        },
        {
          id: "000064_codex_oauth_versioned_secret_namespaces",
          sha256: sourceDigest(
            "packages/platform/db/prisma/migrations/000064_codex_oauth_versioned_secret_namespaces/migration.sql",
          ),
        },
        {
          id: "000065_codex_oauth_authority_acl_hardening",
          sha256: authorityAclHardeningForwardChecksum,
        },
        {
          id: "000066_codex_oauth_rotating_cascade_authority",
          sha256: rotatingCascadeAuthorityForwardChecksum,
        },
        {
          id: "000073_codex_oauth_active_namespace_refresh",
          sha256: sourceDigest(
            "packages/platform/db/prisma/migrations/000073_codex_oauth_active_namespace_refresh/migration.sql",
          ),
        },
        {
          id: "000079_codex_oauth_v4_v5_workflow_reattestation",
          sha256: sourceDigest(
            "packages/platform/db/prisma/migrations/000079_codex_oauth_v4_v5_workflow_reattestation/migration.sql",
          ),
        },
        {
          id: "000080_codex_oauth_reattestation_mutation_owner_fence",
          sha256: sourceDigest(
            "packages/platform/db/prisma/migrations/000080_codex_oauth_reattestation_mutation_owner_fence/migration.sql",
          ),
        },
      ],
      history: [
        {
          migration_name: "000060_codex_oauth_setup_serialization",
          checksum: sourceDigest(
            "packages/platform/db/prisma/migrations/000060_codex_oauth_setup_serialization/migration.sql",
          ),
          finished: true,
          current: true,
          applied_steps_count: 1,
        },
        {
          migration_name: "000061_codex_oauth_provider_mutation_fence",
          checksum: sourceDigest(
            "packages/platform/db/prisma/migrations/000061_codex_oauth_provider_mutation_fence/migration.sql",
          ),
          finished: true,
          current: true,
          applied_steps_count: 1,
        },
        {
          migration_name: "000062_codex_oauth_remote_outcome_unknown",
          checksum: sourceDigest(
            "packages/platform/db/prisma/migrations/000062_codex_oauth_remote_outcome_unknown/migration.sql",
          ),
          finished: true,
          current: true,
          applied_steps_count: 1,
        },
        {
          migration_name: "000063_codex_oauth_setup_payload_claim",
          checksum: atomicSetupPayloadClaimReleaseChecksum,
          finished: true,
          current: true,
          applied_steps_count: 1,
        },
        {
          migration_name: "000064_codex_oauth_versioned_secret_namespaces",
          checksum: sourceDigest(
            "packages/platform/db/prisma/migrations/000064_codex_oauth_versioned_secret_namespaces/migration.sql",
          ),
          finished: true,
          current: true,
          applied_steps_count: 1,
        },
        {
          migration_name: "000065_codex_oauth_authority_acl_hardening",
          checksum: authorityAclHardeningForwardChecksum,
          finished: true,
          current: true,
          applied_steps_count: 1,
        },
        {
          migration_name: "000066_codex_oauth_rotating_cascade_authority",
          checksum: rotatingCascadeAuthorityForwardChecksum,
          finished: true,
          current: true,
          applied_steps_count: 1,
        },
        {
          migration_name: "000073_codex_oauth_active_namespace_refresh",
          checksum: sourceDigest(
            "packages/platform/db/prisma/migrations/000073_codex_oauth_active_namespace_refresh/migration.sql",
          ),
          finished: true,
          current: true,
          applied_steps_count: 1,
        },
        {
          migration_name: "000079_codex_oauth_v4_v5_workflow_reattestation",
          checksum: sourceDigest(
            "packages/platform/db/prisma/migrations/000079_codex_oauth_v4_v5_workflow_reattestation/migration.sql",
          ),
          finished: true,
          current: true,
          applied_steps_count: 1,
        },
        {
          migration_name:
            "000080_codex_oauth_reattestation_mutation_owner_fence",
          checksum: sourceDigest(
            "packages/platform/db/prisma/migrations/000080_codex_oauth_reattestation_mutation_owner_fence/migration.sql",
          ),
          finished: true,
          current: true,
          applied_steps_count: 1,
        },
      ],
      catalog: {
        tables: codexRotatingCatalogTables.map((name) => ({
          name,
          kind: "r",
          persistence: "p",
          rowSecurity: false,
          forceRowSecurity: false,
          owner: "reviewrouter_release_schema_owner",
        })),
        inventory: {
          columns: [...codexRotatingCatalogColumnKeys],
          checks: [...codexRotatingCatalogCheckNames],
          indexes: [...codexRotatingCatalogIndexNames],
          foreignKeys: [...codexRotatingCatalogForeignKeyNames],
          triggers: [...codexRotatingTriggers],
          functions: [...codexRotatingFunctions],
        },
        columns: codexRotatingCatalogColumns.map((column, index) => ({
          ...column,
          ordinal: index + 1,
          identity: "",
          generated: "",
        })),
        primaryKeys: codexRotatingPrimaryKeys.map((key) => ({ ...key })),
        privileges: {
          columns: [
            "reviewrouter_api",
            "reviewrouter_web",
            "reviewrouter_worker",
          ].flatMap((grantee) =>
            codexRotatingProviderRuntimeUpdateColumns.map((column) => ({
              name: `CodexOAuthProviderInstance.${column}`,
              grantee,
              grantor: "reviewrouter_release_schema_owner",
              privilege: "UPDATE",
              grantable: false,
            })),
          ),
          functions: codexRotatingFunctions.flatMap((name) =>
            [
              "reviewrouter_release_schema_owner",
              ...(name === "codex_oauth_consume_database_authority"
                ? [
                    "reviewrouter_api",
                    "reviewrouter_web",
                    "reviewrouter_worker",
                  ]
                : name === "codex_oauth_database_authority_challenge"
                  ? [
                      "reviewrouter_api",
                      "reviewrouter_web",
                      "reviewrouter_worker",
                    ]
                  : name === "codex_oauth_sign_database_authority"
                    ? ["reviewrouter_codex_effect_authority"]
                    : name === "codex_oauth_authorize_setup_confirmation"
                      ? ["reviewrouter_web"]
                      : name ===
                            "codex_oauth_provider_identity_repair_challenge" ||
                          name === "codex_oauth_repair_quarantined_provider" ||
                          name ===
                            "codex_oauth_reattest_active_namespace_v4_to_v5"
                        ? ["reviewrouter_web"]
                        : name ===
                              "codex_oauth_authorize_runtime_confirmation" ||
                            name === "codex_oauth_authorize_runtime_completion"
                          ? ["reviewrouter_api"]
                          : []),
            ].map((grantee) => ({
              name,
              identityArguments:
                codexRotatingFunctionIdentityArguments[name] ?? "",
              grantee,
              grantor: "reviewrouter_release_schema_owner",
              privilege: "EXECUTE",
              grantable: false,
            })),
          ),
          tables: codexRotatingCatalogTables.flatMap((name) =>
            [
              "reviewrouter_release_schema_owner",
              "reviewrouter_codex_effect_authority",
              "reviewrouter_api",
              "reviewrouter_web",
              "reviewrouter_worker",
            ].flatMap((grantee) =>
              (grantee === "reviewrouter_release_schema_owner"
                ? [
                    "DELETE",
                    "INSERT",
                    "MAINTAIN",
                    "REFERENCES",
                    "SELECT",
                    "TRIGGER",
                    "TRUNCATE",
                    "UPDATE",
                  ]
                : grantee === "reviewrouter_codex_effect_authority" ||
                    name === "CodexOAuthDatabaseAuthorityKey" ||
                    name === "CodexOAuthDatabaseAuthorityReceipt"
                  ? []
                  : name === "CodexOAuthChildIdentityQuarantine" ||
                      name === "CodexOAuthProviderIdentityQuarantine"
                    ? ["SELECT"]
                    : name === "CodexOAuthProviderInstance"
                      ? ["INSERT", "SELECT"]
                      : ["INSERT", "SELECT", "UPDATE"]
              ).map((privilege) => ({
                name,
                grantee,
                grantor: "reviewrouter_release_schema_owner",
                privilege,
                grantable: false,
              })),
            ),
          ),
        },
        triggers: [
          ...[
            "CodexOAuthChildIdentityQuarantine",
            "CodexOAuthLease",
            "CodexOAuthProviderIdentityQuarantine",
            "CodexOAuthProviderInstance",
            "CodexOAuthSecretNamespace",
            "CodexOAuthSetupDispatchAttempt",
            "CodexOAuthSetupManifest",
            "CodexOAuthSetupPayloadClaim",
            "CodexOAuthSetupRecoveryRequest",
            "CodexOAuthWritebackIntent",
          ].map((table) => [
            `${table}_cascade_guard`,
            table,
            "codex_oauth_runtime_referential_action_guard",
            11,
          ]),
          [
            "CodexOAuthDatabaseAuthorityReceipt_one_shot_guard",
            "CodexOAuthDatabaseAuthorityReceipt",
            "codex_oauth_database_authority_receipt_guard",
            27,
          ],
          [
            "CodexOAuthLease_identity_fence_guard",
            "CodexOAuthLease",
            "codex_oauth_child_identity_fence_guard",
            23,
          ],
          [
            "CodexOAuthProviderInstance_identity_guard",
            "CodexOAuthProviderInstance",
            "codex_oauth_provider_identity_guard",
            23,
          ],
          [
            "CodexOAuthProviderInstance_mutation_transition_guard",
            "CodexOAuthProviderInstance",
            "codex_oauth_provider_mutation_transition_guard",
            19,
          ],
          [
            "CodexOAuthSetupManifest_identity_fence_guard",
            "CodexOAuthSetupManifest",
            "codex_oauth_child_identity_fence_guard",
            23,
          ],
          [
            "CodexOAuthSetupManifest_evidence_guard",
            "CodexOAuthSetupManifest",
            "codex_oauth_setup_manifest_evidence_guard",
            31,
          ],
          [
            "CodexOAuthSecretNamespace_tombstone_guard",
            "CodexOAuthSecretNamespace",
            "codex_oauth_secret_namespace_tombstone_guard",
            31,
          ],
          [
            "CodexOAuthSetupPayloadClaim_evidence_guard",
            "CodexOAuthSetupPayloadClaim",
            "codex_oauth_setup_claim_evidence_guard",
            31,
          ],
          [
            "CodexOAuthSetupDispatchAttempt_evidence_guard",
            "CodexOAuthSetupDispatchAttempt",
            "codex_oauth_setup_attempt_evidence_guard",
            31,
          ],
          [
            "CodexOAuthSetupRecoveryRequest_evidence_guard",
            "CodexOAuthSetupRecoveryRequest",
            "codex_oauth_setup_recovery_evidence_guard",
            31,
          ],
          [
            "CodexOAuthWritebackIntent_identity_fence_guard",
            "CodexOAuthWritebackIntent",
            "codex_oauth_child_identity_fence_guard",
            23,
          ],
          [
            "CodexOAuthWritebackIntent_runtime_evidence_guard",
            "CodexOAuthWritebackIntent",
            "codex_oauth_runtime_writeback_evidence_guard",
            31,
          ],
          [
            "RepositoryConnection_codex_oauth_identity_guard",
            "RepositoryConnection",
            "codex_oauth_repository_identity_guard",
            17,
          ],
          [
            "RepositoryConnection_runtime_referential_action_guard",
            "RepositoryConnection",
            "codex_oauth_runtime_referential_action_guard",
            27,
          ],
        ].map(([name, table, fn, type]) => ({
          name,
          table,
          function: fn,
          type,
          enabled: "O",
          definition: `CREATE ${name === "RepositoryConnection_codex_oauth_identity_guard" ? "CONSTRAINT " : ""}TRIGGER "${name}" ON ${table}`,
          updateColumns:
            name === "RepositoryConnection_runtime_referential_action_guard"
              ? [
                  "id",
                  "workspaceId",
                  "installationId",
                  "gitlabInstallationId",
                  "scmRepositoryIdentityId",
                ]
              : [],
          whenExpression: null,
          arguments: "",
          constraint:
            name === "RepositoryConnection_codex_oauth_identity_guard",
          deferrable:
            name === "RepositoryConnection_codex_oauth_identity_guard",
          initiallyDeferred: false,
        })),
        functions: codexRotatingFunctionBodyDigests.map(
          ({ name, bodySha256 }) => ({
            name,
            identityArguments:
              codexRotatingFunctionIdentityArguments[name] ?? "",
            owner: "reviewrouter_release_schema_owner",
            bodySha256,
            prokind: "f",
            proretset: false,
            prosupport: null,
            procost: 100,
            prorows: 0,
            securityDefiner:
              name.startsWith("codex_oauth_authorize_") ||
              name === "codex_oauth_consume_database_authority" ||
              name === "codex_oauth_provider_identity_repair_challenge" ||
              name === "codex_oauth_provider_identity_guard" ||
              name === "codex_oauth_runtime_referential_action_guard" ||
              name === "codex_oauth_repair_quarantined_provider" ||
              name === "codex_oauth_reattest_active_namespace_v4_to_v5" ||
              name === "codex_oauth_secret_namespace_tombstone_guard" ||
              name === "codex_oauth_sign_database_authority",
            config:
              name.startsWith("codex_oauth_authorize_") ||
              name === "codex_oauth_consume_database_authority" ||
              name === "codex_oauth_database_authority_challenge" ||
              name === "codex_oauth_database_authority_receipt_guard" ||
              name === "codex_oauth_provider_identity_guard" ||
              name === "codex_oauth_runtime_referential_action_guard" ||
              name === "codex_oauth_provider_identity_transition" ||
              name === "codex_oauth_provider_identity_repair_challenge" ||
              name === "codex_oauth_repair_quarantined_provider" ||
              name === "codex_oauth_reattest_active_namespace_v4_to_v5" ||
              name === "codex_oauth_secret_namespace_tombstone_guard" ||
              name === "codex_oauth_v4_v5_reattestation_transition" ||
              name === "codex_oauth_sign_database_authority"
                ? ["search_path=pg_catalog, public"]
                : null,
            language: "plpgsql",
            volatility: "v",
            parallel: "u",
            leakproof: false,
            strict: false,
            resultType: name.startsWith("codex_oauth_authorize_")
              ? "void"
              : name === "codex_oauth_consume_database_authority"
                ? "boolean"
                : name === "codex_oauth_database_authority_challenge" ||
                    name === "codex_oauth_sign_database_authority" ||
                    name === "codex_oauth_provider_identity_transition" ||
                    name === "codex_oauth_provider_identity_repair_challenge" ||
                    name === "codex_oauth_v4_v5_reattestation_transition"
                  ? "text"
                  : name === "codex_oauth_reattest_active_namespace_v4_to_v5"
                    ? "void"
                    : name.includes("repair")
                      ? "void"
                      : "trigger",
            arguments:
              name === "codex_oauth_authorize_runtime_completion"
                ? "target_intent_id text, target_signature text"
                : name === "codex_oauth_authorize_runtime_confirmation"
                  ? "target_intent_id text, target_executor_owner text, target_response_code integer, target_signature text"
                  : name === "codex_oauth_authorize_setup_confirmation"
                    ? "target_attempt_id text, target_response_code integer, target_signature text"
                    : name === "codex_oauth_consume_database_authority"
                      ? "target_effect text, target_owner_id text, target_effect_code integer"
                      : name === "codex_oauth_database_authority_challenge"
                        ? "target_effect text, target_owner_id text, target_effect_code integer"
                        : name === "codex_oauth_provider_identity_transition"
                          ? "provider_row_id text, old_workspace_id text, old_repository_id text, old_provider_instance_id text, old_auth_mode text, old_secret_name text, new_workspace_id text, new_repository_id text, new_provider_instance_id text, new_auth_mode text, new_secret_name text"
                          : name ===
                              "codex_oauth_provider_identity_repair_challenge"
                            ? "provider_row_id text, old_workspace_id text, old_repository_id text, old_provider_instance_id text, old_auth_mode text, old_secret_name text, old_repository_provider text, old_github_repository_id bigint, old_external_repository_id text, new_workspace_id text, new_repository_id text, new_provider_instance_id text, new_auth_mode text, new_secret_name text, new_github_repository_id bigint"
                            : name === "codex_oauth_sign_database_authority"
                              ? "target_challenge text"
                              : name === "codex_oauth_repair_quarantined_child"
                                ? "target_kind text, target_id text, replacement_lease_id text DEFAULT NULL::text"
                                : name ===
                                    "codex_oauth_repair_quarantined_provider"
                                  ? "provider_row_id text, old_workspace_id text, old_repository_id text, old_provider_instance_id text, old_auth_mode text, old_secret_name text, old_repository_provider text, old_github_repository_id bigint, old_external_repository_id text, new_workspace_id text, new_repository_id text, new_provider_instance_id text, new_auth_mode text, new_secret_name text, new_github_repository_id bigint, target_signature text"
                                  : name ===
                                      "codex_oauth_reattest_active_namespace_v4_to_v5"
                                    ? "target_provider_row_id text, target_claim_id text, target_attempt_id text, target_namespace_id text, target_namespace_epoch bigint, target_secret_name text, target_repository_id text, target_generation_hash text, target_workflow_path text, target_source_trust text, expected_schema_version integer, target_schema_version integer, old_commit_sha text, old_blob_sha text, old_source_sha256 text, old_semantic_sha256 text, new_commit_sha text, new_blob_sha text, new_source_sha256 text, new_semantic_sha256 text"
                                    : name ===
                                        "codex_oauth_v4_v5_reattestation_transition"
                                      ? "target_provider_row_id text, target_namespace_id text, target_namespace_epoch bigint, target_secret_name text, target_repository_id text, target_workflow_path text, target_source_trust text, old_commit_sha text, old_blob_sha text, old_source_sha256 text, old_semantic_sha256 text, new_commit_sha text, new_blob_sha text, new_source_sha256 text, new_semantic_sha256 text"
                                      : "",
          }),
        ),
        checks: [
          ["CodexOAuthDatabaseAuthorityKey_singleton_check", "singleton", true],
          [
            "CodexOAuthWritebackIntent_executor_lease_check",
            "dispatchAttemptId executorOwner executorLeaseExpiresAt dispatchAuthorizedAt",
            true,
          ],
          [
            "CodexOAuthLease_pullRequestNumber_check",
            "pullRequestNumber",
            true,
          ],
          [
            "CodexOAuthLease_epoch_check",
            "status preleased finalized mutationEpoch",
            false,
          ],
          [
            "CodexOAuthProviderInstance_mutation_fence_check",
            "mutationEpoch mutationOwner mutationOwnerId runtime setup recovery",
            true,
          ],
          [
            "CodexOAuthSetupManifest_epoch_check",
            "status issued fetched mutationEpoch",
            false,
          ],
          [
            "CodexOAuthWritebackIntent_epoch_check",
            "status pending mutationEpoch",
            false,
          ],
          ["CodexOAuthSetupRecoveryRequest_epoch_check", "mutationEpoch", true],
          [
            "CodexOAuthSetupRecoveryRequest_contract_check",
            "forced_reseed forced_reseed_account_switch account_switch_is_intended manifest_issued completed",
            true,
          ],
          [
            "CodexOAuthSetupRecoveryRequest_database_recovery_witness_check",
            "databaseRecoveryWitness",
            true,
          ],
          [
            "CodexOAuthSetupManifest_payload_claim_complete_check",
            "payloadVersion payloadGenerationHash payloadAccountFingerprint payloadByteSize payloadClaimedAt",
            true,
          ],
          [
            "CodexOAuthSetupManifest_recovery_expiry_check",
            "recoveryExpiresAt lastFetchedAt",
            true,
          ],
          [
            "CodexOAuthSetupManifest_database_recovery_witness_check",
            "databaseRecoveryWitness",
            true,
          ],
          [
            "CodexOAuthSetupPayloadClaim_payload_check",
            "payloadVersion canonicalizationVersion accountIdentityAlgorithm databaseRecoveryWitness prepared retired_confirmed retired_active",
            true,
          ],
          [
            "CodexOAuthSecretNamespace_lifecycle_check",
            "retired_ambiguous permanentlyRetired workflowSourceCommitSha workflowSourceBlobSha workflowSemanticSha256 trusted_default_branch_revision attestedRepositoryId",
            true,
          ],
          [
            "CodexOAuthSecretNamespace_name_check",
            "secretName REVIEWROUTER_CODEX_AUTH_JSON_R",
            true,
          ],
          [
            "CodexOAuthSecretNamespace_recovery_witness_check",
            "databaseRecoveryWitness",
            true,
          ],
          [
            "CodexOAuthSetupDispatchAttempt_lifecycle_check",
            "dispatch_authorized retired_ambiguous retired_confirmed definiteResponseCode",
            true,
          ],
          [
            "CodexOAuthProviderInstance_active_namespace_pair_check",
            "activeSecretNamespaceId activeSecretNamespaceEpoch activeSecretNamespaceName",
            true,
          ],
          [
            "CodexOAuthLease_secret_namespace_pair_check",
            "secretNamespaceId secretNamespaceEpoch",
            true,
          ],
          [
            "CodexOAuthWritebackIntent_versioned_dispatch_check",
            "dispatchAttemptId secretNamespaceId dispatchAuthorizedAt",
            true,
          ],
          [
            "CodexOAuthWritebackIntent_provider_response_check",
            "providerResponseCode 201 204",
            true,
          ],
          [
            "CodexOAuthWritebackIntent_database_incarnation_check",
            "databaseIncarnation",
            true,
          ],
          [
            "CodexOAuthWritebackIntent_database_recovery_witness_check",
            "databaseRecoveryWitness",
            true,
          ],
          [
            "CodexOAuthWritebackIntent_account_identity_check",
            "accountIdentityHash accountIdentityAlgorithm provider_issuer_subject_account_v1",
            true,
          ],
          [
            "CodexOAuthWritebackIntent_recovery_resolution_check",
            "recoveryRequestRowId recoveryResolvedAt",
            true,
          ],
        ].map(([name, definition, validated]) => ({
          name,
          table: String(name).split("_", 1)[0],
          definition,
          definitionSha256: checkDefinitionDigests.get(String(name)),
          validated,
        })),
        indexes: [
          ["CodexOAuthLease_expiresAt_idx", "expiresAt", false],
          [
            "CodexOAuthLease_providerInstanceId_status_idx",
            "providerInstanceId status",
            false,
          ],
          [
            "CodexOAuthLease_repositoryId_status_idx",
            "repositoryId status",
            false,
          ],
          [
            "CodexOAuthLease_workspaceId_status_idx",
            "workspaceId status",
            false,
          ],
          [
            "CodexOAuthProviderInstance_activeLeaseExpiresAt_idx",
            "activeLeaseExpiresAt",
            false,
          ],
          [
            "CodexOAuthProviderInstance_providerInstanceId_key",
            "providerInstanceId",
            true,
          ],
          [
            "CodexOAuthProviderInstance_repositoryId_authMode_key",
            "repositoryId authMode",
            true,
          ],
          [
            "CodexOAuthProviderInstance_repositoryId_state_idx",
            "repositoryId state",
            false,
          ],
          [
            "CodexOAuthProviderInstance_workspaceId_state_idx",
            "workspaceId state",
            false,
          ],
          ["CodexOAuthSetupManifest_expiresAt_idx", "expiresAt", false],
          [
            "CodexOAuthSetupManifest_providerInstanceId_status_idx",
            "providerInstanceId status",
            false,
          ],
          [
            "CodexOAuthSetupManifest_repositoryId_status_idx",
            "repositoryId status",
            false,
          ],
          ["CodexOAuthSetupManifest_setupNonce_key", "setupNonce", true],
          [
            "CodexOAuthWritebackIntent_leaseId_status_idx",
            "leaseId status",
            false,
          ],
          [
            "CodexOAuthWritebackIntent_providerInstanceId_status_idx",
            "providerInstanceId status",
            false,
          ],
          ["CodexOAuthLease_leaseKey_key", "leaseKey", true],
          [
            "CodexOAuthWritebackIntent_providerInstanceId_idempotencyKey_key",
            "providerInstanceId idempotencyKey",
            true,
          ],
          [
            "CodexOAuthChildIdentityQuarantine_provider_idx",
            "providerInstanceRowId resolvedAt",
            false,
          ],
          [
            "CodexOAuthLease_provider_epoch_idx",
            "providerInstanceRowId mutationEpoch",
            false,
          ],
          [
            "CodexOAuthProviderInstance_mutation_owner_idx",
            "mutationOwner mutationEpoch",
            false,
          ],
          [
            "CodexOAuthSetupManifest_one_active_provider_key",
            "providerInstanceRowId",
            true,
          ],
          [
            "CodexOAuthSetupManifest_provider_epoch_idx",
            "providerInstanceRowId mutationEpoch",
            false,
          ],
          [
            "CodexOAuthWritebackIntent_provider_epoch_idx",
            "providerInstanceRowId mutationEpoch",
            false,
          ],
          [
            "CodexOAuthSetupRecoveryRequest_provider_request_key",
            "providerInstanceRowId recoveryRequestId",
            true,
          ],
          [
            "CodexOAuthSetupRecoveryRequest_latestManifestId_key",
            "latestManifestId",
            true,
          ],
          [
            "CodexOAuthSetupRecoveryRequest_provider_state_idx",
            "providerInstanceRowId state",
            false,
          ],
          [
            "CodexOAuthSetupRecoveryRequest_one_active_provider_key",
            "providerInstanceRowId",
            true,
          ],
          [
            "CodexOAuthSetupManifest_recovery_expiry_idx",
            "status recoveryExpiresAt",
            false,
          ],
          [
            "CodexOAuthSetupPayloadClaim_provider_operation_key",
            "providerInstanceRowId operationId",
            true,
          ],
          [
            "CodexOAuthSetupPayloadClaim_provider_epoch_key",
            "providerInstanceRowId recoveryEpoch",
            true,
          ],
          [
            "CodexOAuthSetupPayloadClaim_confirmedAttemptId_key",
            "confirmedAttemptId",
            true,
          ],
          [
            "CodexOAuthSetupPayloadClaim_one_active_per_provider_key",
            "providerInstanceRowId",
            true,
          ],
          [
            "CodexOAuthSetupPayloadClaim_provider_status_idx",
            "providerInstanceRowId status",
            false,
          ],
          ["CodexOAuthSecretNamespace_secretName_key", "secretName", true],
          [
            "CodexOAuthSecretNamespace_provider_epoch_key",
            "providerInstanceRowId namespaceEpoch",
            true,
          ],
          [
            "CodexOAuthSecretNamespace_provider_status_idx",
            "providerInstanceRowId status",
            false,
          ],
          ["CodexOAuthSecretNamespace_id_epoch_key", "id namespaceEpoch", true],
          [
            "CodexOAuthSecretNamespace_id_epoch_name_key",
            "id namespaceEpoch secretName",
            true,
          ],
          [
            "CodexOAuthSecretNamespace_provider_id_key",
            "providerInstanceRowId id",
            true,
          ],
          [
            "CodexOAuthSetupDispatchAttempt_namespaceId_key",
            "namespaceId",
            true,
          ],
          [
            "CodexOAuthSetupDispatchAttempt_claim_idempotency_key",
            "claimId idempotencyKey",
            true,
          ],
          [
            "CodexOAuthSetupDispatchAttempt_claim_ordinal_key",
            "claimId ordinal",
            true,
          ],
          [
            "CodexOAuthSetupDispatchAttempt_claim_status_idx",
            "claimId status",
            false,
          ],
          [
            "CodexOAuthProviderInstance_activeSecretNamespaceId_key",
            "activeSecretNamespaceId",
            true,
          ],
          [
            "CodexOAuthWritebackIntent_dispatchAttemptId_key",
            "dispatchAttemptId",
            true,
          ],
          [
            "CodexOAuthWritebackIntent_secretNamespaceId_idx",
            "secretNamespaceId",
            false,
          ],
          ["CodexOAuthWritebackIntent_versioned_lease_key", "leaseId", true],
        ].map(([name, definition, unique]) => ({
          name,
          definition,
          definitionSha256:
            indexDefinitionDigests.get(String(name)) ?? "0".repeat(64),
          predicate:
            name === "CodexOAuthSetupPayloadClaim_one_active_per_provider_key"
              ? "status = 'active'::text"
              : name === "CodexOAuthSetupManifest_one_active_provider_key"
                ? "status IN (issued, fetched)"
                : name ===
                    "CodexOAuthSetupRecoveryRequest_one_active_provider_key"
                  ? "state IN (active, manifest_issued)"
                  : name === "CodexOAuthWritebackIntent_versioned_lease_key"
                    ? "databaseIncarnation IS NOT NULL"
                    : "",
          predicateSha256: predicateDigests.get(String(name)) ?? null,
          unique,
          valid: true,
          ready: true,
          method: "btree",
          keyCount: String(definition).split(" ").length,
          includeCount: 0,
          keys: String(definition).split(" "),
          opclasses: String(definition)
            .split(" ")
            .map((key) =>
              ["mutationEpoch", "recoveryEpoch", "namespaceEpoch"].includes(key)
                ? "int8_ops"
                : key === "ordinal"
                  ? "int4_ops"
                  : [
                        "resolvedAt",
                        "expiresAt",
                        "activeLeaseExpiresAt",
                      ].includes(key)
                    ? "timestamp_ops"
                    : key === "recoveryExpiresAt"
                      ? "timestamptz_ops"
                      : "text_ops",
            ),
          options: String(definition)
            .split(" ")
            .map(() => 0),
        })),
        foreignKeys: codexRotatingCatalogForeignKeys.map((foreignKey) => ({
          ...foreignKey,
          validated: true,
        })),
      },
    },
    deployments: {
      observationVersion: 1,
      source: "render-api",
      database: {
        id: "dpg-reviewrouter",
        name: "reviewrouter-db",
        version: "17.6",
      },
      services: ["api", "web", "worker"].map((role) => ({
        name: `reviewrouter-${role}`,
        role,
        serviceId: `srv-${role}`,
        deployId: `dep-${role}`,
        commit,
        imageDigest,
        status: "live",
        rotatingMutationAdmission: "off",
        preDeployCommand: null,
        serviceMigrationCallerEnabled: false,
        observedAt: "2026-08-09T00:06:00Z",
      })),
    },
    compatibilityProbe: {
      observationVersion: 1,
      exitCode: 0,
      candidateCommit: commit,
      candidateImageDigest: imageDigest,
      bridgeCommit: "d".repeat(40),
      bridgeImageDigest: `sha256:${"e".repeat(64)}`,
      readerRestartCount: 1,
      cases: [
        {
          id: "legacy-consumed-confirmation-replay",
          conclusion: "pass",
          observations: {
            firstResponseSha256: "c".repeat(64),
            firstStatus: 200,
            readerProcessIds: [101, 202],
            replayResponseSha256: "c".repeat(64),
            replayStatus: 200,
          },
        },
        {
          id: "v1-workflow-after-v2-publication",
          conclusion: "pass",
          observations: {
            mutationCount: 0,
            publishedV2At: "2026-08-09T00:00:00Z",
            queuedWorkflowSha: "d".repeat(40),
            result: "rejected_before_oauth_mutation",
            startedAt: "2026-08-09T00:01:00Z",
            workflowSchemaVersion: 1,
          },
        },
        {
          id: "v2-workflow-fence-aware",
          conclusion: "pass",
          observations: {
            fenceObserved: true,
            mutationEpoch: 1,
            publishedWorkflowDigest: `sha256:${"e".repeat(64)}`,
            result: "success",
            workflowSchemaVersion: 2,
          },
        },
      ].map((entry) => ({
        ...entry,
        observationDigest: digest(
          Buffer.from(canonicalFixtureJson(entry.observations)),
        ),
      })),
    },
    canaryRuntime: {
      observationVersion: 1,
      source: "canary-runtime",
      disposable: true,
      repositoryFullName: "reviewrouter/disposable-canary",
      approvedRepositories: ["reviewrouter/disposable-canary"],
      flags: {
        runtime: "1",
        newWorkAdmission: "1",
        setupIssuance: "1",
      },
      runtimeCommit: commit,
      runtimeImageDigest: imageDigest,
      installerV1Digest: `sha256:${"1".repeat(64)}`,
      installerV2Digest: `sha256:${"2".repeat(64)}`,
      workflowV2Digest: `sha256:${"3".repeat(64)}`,
      runtimePublicationDigest: `sha256:${"4".repeat(64)}`,
    },
    workflowRuns: {
      observationVersion: 1,
      source: "github-actions-api",
      supportedWorkflowSchemaVersions: [1, 2, 3, 4, 5],
      observations: [
        {
          observedAt: "2026-08-09T00:03:05Z",
          inventoriedWorkflowSchemaVersions: [1, 2, 3, 4, 5],
          runs: [
            {
              runId: "100",
              status: "queued",
              workflowSchemaVersion: 1,
              workflowPath: ".github/workflows/reviewrouter.yml",
              headSha: "5".repeat(40),
            },
          ],
        },
        {
          observedAt: "2026-08-09T00:03:35Z",
          inventoriedWorkflowSchemaVersions: [1, 2, 3, 4, 5],
          runs: [
            {
              runId: "100",
              status: "in_progress",
              workflowSchemaVersion: 1,
              workflowPath: ".github/workflows/reviewrouter.yml",
              headSha: "5".repeat(40),
            },
          ],
        },
      ],
    },
    events: {
      observationVersion: 1,
      source: "operator-command-log",
      rollbackFloorCommit: commit,
      prohibitedRollbackCommit: "e642d1ed",
      events: [
        {
          type: "bridge_replay_ready",
          observedAt: "2026-08-09T00:00:00Z",
          commit: "d".repeat(40),
          imageDigest: `sha256:${"e".repeat(64)}`,
          databaseCompatibility: "pre-000061",
          exactConsumedReplayObserved: true,
        },
        {
          type: "workflow_v2_published",
          observedAt: "2026-08-09T00:01:00Z",
          installerV1Digest: `sha256:${"1".repeat(64)}`,
          installerV2Digest: `sha256:${"2".repeat(64)}`,
          workflowV2Digest: `sha256:${"3".repeat(64)}`,
          v2IssuanceCount: 0,
        },
        {
          type: "setup_issuance_disabled",
          observedAt: "2026-08-09T00:02:00Z",
          setupIssuance: "off",
          probe: {
            httpStatus: 503,
            code: "codex_rotating_setup_issuance_quiesced",
          },
        },
        {
          type: "pre_kill_switch_drain_zero",
          observedAt: "2026-08-09T00:03:00Z",
          activeLeases: 0,
          fetchedSetups: 0,
          pendingIntents: 0,
          queuedOldWorkflows: 0,
        },
        {
          type: "mutation_admission_disabled",
          observedAt: "2026-08-09T00:03:30Z",
          globalMutationAdmission: "off",
          setupIssuance: "off",
          exactConsumedReplayStillAvailable: true,
        },
        {
          type: "post_kill_switch_drain_zero",
          observedAt: "2026-08-09T00:03:45Z",
          activeLeases: 0,
          fetchedSetups: 0,
          pendingIntents: 0,
          queuedOldWorkflows: 0,
        },
        {
          type: "migrations_completed",
          observedAt: "2026-08-09T00:04:00Z",
          ids: [
            "000060_codex_oauth_setup_serialization",
            "000061_codex_oauth_provider_mutation_fence",
            "000062_codex_oauth_remote_outcome_unknown",
            "000063_codex_oauth_setup_payload_claim",
            "000064_codex_oauth_versioned_secret_namespaces",
            "000065_codex_oauth_authority_acl_hardening",
            "000066_codex_oauth_rotating_cascade_authority",
            "000073_codex_oauth_active_namespace_refresh",
            "000079_codex_oauth_v4_v5_workflow_reattestation",
            "000080_codex_oauth_reattestation_mutation_owner_fence",
          ],
          singleCaller: true,
          caller: "release-migration",
          databaseArtifactSha256: "set-below",
        },
        {
          type: "services_converged",
          observedAt: "2026-08-09T00:06:00Z",
          commit,
          imageDigest,
          mutationAdmission: "off",
        },
        {
          type: "canary_allowlisted",
          observedAt: "2026-08-09T00:07:00Z",
          globalMutationAdmission: "off",
          disposable: true,
        },
        {
          type: "canary_admission_opened",
          observedAt: "2026-08-09T00:08:00Z",
          scope: "single-disposable-repository",
          allowlistCount: 1,
          runtimeFlag: "1",
          newWorkAdmissionFlag: "1",
          setupIssuanceFlag: "1",
        },
        {
          type: "canary_passed",
          observedAt: "2026-08-09T00:09:00Z",
          compatibilityArtifactSha256: "set-below",
          runtimePublicationDigest: `sha256:${"4".repeat(64)}`,
        },
        {
          type: "canary_admission_closed",
          observedAt: "2026-08-09T00:09:10Z",
          runtimeFlag: "0",
          newWorkAdmissionFlag: "0",
          setupIssuanceFlag: "0",
          allowlistCount: 1,
        },
        {
          type: "canary_allowlist_deleted",
          observedAt: "2026-08-09T00:09:20Z",
          runtimeFlag: "0",
          newWorkAdmissionFlag: "0",
          setupIssuanceFlag: "0",
          allowlistCount: 0,
        },
        {
          type: "widening_approved",
          observedAt: "2026-08-09T00:10:00Z",
          approvedRepositories: ["reviewrouter/approved-one"],
        },
        {
          type: "widening_admission_opened",
          observedAt: "2026-08-09T00:10:10Z",
          runtimeFlag: "1",
          newWorkAdmissionFlag: "1",
          setupIssuanceFlag: "1",
          allowlistCount: 1,
        },
      ],
    },
  };
  const databaseSha256 = digest(
    Buffer.from(JSON.stringify(artifacts.database)),
  );
  const compatibilitySha256 = digest(
    Buffer.from(JSON.stringify(artifacts.compatibilityProbe)),
  );
  artifacts.events.events.find(
    (entry: any) => entry.type === "migrations_completed",
  ).databaseArtifactSha256 = databaseSha256;
  artifacts.events.events.find(
    (entry: any) => entry.type === "canary_passed",
  ).compatibilityArtifactSha256 = compatibilitySha256;
  const rawEntry = (url: string, body: any, extra: any = {}) => ({
    url,
    status: 200,
    bodySha256: digest(Buffer.from(canonicalJson(body).trimEnd())),
    body,
    ...extra,
  });
  artifacts.deployments.observationVersion = 3;
  artifacts.deployments.database.ownerId = "own-production";
  artifacts.deployments.runtimeWitness = {
    key: "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
    sha256: "f".repeat(64),
    observations: [],
  };
  const ownerRaw = rawEntry("https://api.render.com/v1/owners/own-production", {
    id: "own-production",
    name: "production",
  });
  const databaseRaw = rawEntry(
    `https://api.render.com/v1/postgres/${artifacts.deployments.database.id}`,
    { ...artifacts.deployments.database },
  );
  const serviceRaw = artifacts.deployments.services.flatMap((service: any) => [
    rawEntry(`https://api.render.com/v1/services/${service.serviceId}`, {
      id: service.serviceId,
      name: service.name,
      serviceDetails: { envSpecificDetails: { preDeployCommand: "" } },
    }),
    rawEntry(
      `https://api.render.com/v1/services/${service.serviceId}/deploys/${service.deployId}`,
      {
        id: service.deployId,
        commit: { id: service.commit },
        image: { digest: service.imageDigest },
        status: service.status,
        updatedAt: service.observedAt,
      },
    ),
    rawEntry(
      `https://api.render.com/v1/services/${service.serviceId}/env-vars/REVIEW_ROUTER_CODEX_ROTATING_MUTATION_ADMISSION`,
      { value: service.rotatingMutationAdmission },
    ),
  ]);
  const witnessObservations = ["before", "after"].flatMap((phase) =>
    [
      ["api", "srv-api"],
      ["web", "srv-web"],
      ["worker", "srv-worker"],
      ["witness", "srv-witness"],
    ].map(([role, serviceId]) => {
      const response = rawEntry(
        `https://api.render.com/v1/services/${serviceId}/env-vars/REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS`,
        {
          key: "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
          observationPhase: phase,
          valueSha256: "f".repeat(64),
        },
      );
      return { phase, role, serviceId, response };
    }),
  );
  artifacts.deployments.runtimeWitness.observations = witnessObservations.map(
    ({ phase, role, serviceId, response }) => ({
      phase,
      role,
      serviceId,
      sourceResponseSha256: response.bodySha256,
    }),
  );
  artifacts.deployments.rawResponses = [
    ownerRaw,
    databaseRaw,
    ...serviceRaw,
    ...witnessObservations.map(({ response }) => response),
  ];
  artifacts.deployments.captureIdentity = {
    ownerId: "own-production",
    ownerName: "production",
    authenticated: true,
    apiHost: "api.render.com",
    observedAt: "2026-08-09T00:04:01Z",
    rawResponsesSha256: digest(
      Buffer.from(canonicalJson(artifacts.deployments.rawResponses).trimEnd()),
    ),
  };

  artifacts.workflowRuns.observationVersion = 2;
  artifacts.workflowRuns.cohort = {
    repositoryId: "99",
    repositoryFullName: "acme/disposable-review",
    workflow: "reviewrouter.yml",
    statuses: ["queued", "in_progress"],
    perPage: 100,
  };
  const workflowRaw: any[] = [];
  for (const sample of artifacts.workflowRuns.observations) {
    for (const run of sample.runs) {
      Object.assign(run, {
        event: "pull_request",
        repositoryId: "99",
        workflowBlobSha: "6".repeat(40),
      });
    }
    const sampleRaw = (["queued", "in_progress"] as const).map((status) => {
      const matching = sample.runs.filter((run: any) => run.status === status);
      return rawEntry(
        `https://api.github.com/repos/acme/disposable-review/actions/workflows/reviewrouter.yml/runs?status=${status}&per_page=100&page=1`,
        {
          workflow_runs: matching.map((run: any) => ({
            id: run.runId,
            repository: { id: 99 },
            sha: run.workflowBlobSha,
          })),
        },
        { nextUrl: null },
      );
    });
    sampleRaw.push(
      rawEntry(
        `https://api.github.com/repos/acme/disposable-review/contents/.github/workflows/reviewrouter.yml?ref=${sample.runs[0].headSha}`,
        { sha: "6".repeat(40) },
      ),
    );
    Object.assign(sample, {
      cohort: artifacts.workflowRuns.cohort,
      rawResponses: sampleRaw,
      captureIdentity: { authenticated: true, apiHost: "api.github.com" },
    });
    workflowRaw.push(...sampleRaw);
  }
  artifacts.workflowRuns.rawResponses = workflowRaw;
  artifacts.workflowRuns.captureIdentity = {
    authenticated: true,
    apiHost: "api.github.com",
    observedAt: "2026-08-09T00:03:36Z",
    rawResponsesSha256: digest(
      Buffer.from(canonicalJson(workflowRaw).trimEnd()),
    ),
  };
  artifacts.events.events.find(
    (entry: any) => entry.type === "migrations_completed",
  ).databaseArtifactSha256 = digest(
    Buffer.from(JSON.stringify(artifacts.database)),
  );

  const evidence: any = {
    version: 3,
    rolloutId: "rollout-1",
    artifacts: {},
  };
  for (const name of Object.keys(artifacts))
    evidence.artifacts[name] = {
      path: `artifacts/${name}.json`,
      sha256: digest(Buffer.from(JSON.stringify(artifacts[name]))),
    };
  evidence.artifacts.compatibilityProbe.sourceFile =
    "apps/web/src/server/codex-rotating-one-shot-curl.real.test.ts";
  evidence.artifacts.compatibilityProbe.sourceFileSha256 = sourceDigest(
    evidence.artifacts.compatibilityProbe.sourceFile,
  );
  evidence.artifacts.database.sourceFile =
    "scripts/capture-codex-rotating-production-writer.mjs";
  evidence.artifacts.database.sourceFileSha256 = sourceDigest(
    evidence.artifacts.database.sourceFile,
  );
  for (const name of ["deployments", "workflowRuns"]) {
    evidence.artifacts[name].sourceFile =
      "scripts/codex-rotating-provider-provenance.mjs";
    evidence.artifacts[name].sourceFileSha256 = sourceDigest(
      evidence.artifacts[name].sourceFile,
    );
  }
  return {
    artifacts,
    evidence,
    options: {
      readArtifact: (path: string) =>
        Buffer.from(
          JSON.stringify(artifacts[path.match(/([^/]+)\.json$/u)![1]]),
        ),
    },
  };
}
function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalFixtureJson(value: unknown): string {
  const sort = (input: any): any =>
    Array.isArray(input)
      ? input.map(sort)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, sort(input[key])]),
          )
        : input;
  return `${JSON.stringify(sort(value))}\n`;
}
