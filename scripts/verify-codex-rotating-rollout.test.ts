import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runCodexRotatingRolloutVerifierCli,
  verifyCodexRotatingRollout,
} from "./verify-codex-rotating-rollout.mjs";

describe("observation-backed Codex rotating rollout verifier", () => {
  it("accepts digested executable/database observations", () => {
    const fixture = observedFixture();
    expect(
      verifyCodexRotatingRollout(fixture.evidence, fixture.options),
    ).toMatchObject({ ok: true, failures: [] });
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
      "evidence must use observation-backed version 2",
    );
    expect(result.failures).toContain(
      "top-level self-reported rollout fields are prohibited",
    );
  });

  it("rejects a fully invented v2 bundle even when its artifact byte digests match", () => {
    const artifacts = Object.fromEntries(
      ["database", "deployments", "compatibilityProbe", "events"].map(
        (name) => [name, { succeeded: true, passed: true }],
      ),
    );
    const evidence: any = { version: 2, artifacts: {} };
    for (const [name, value] of Object.entries(artifacts)) {
      evidence.artifacts[name] = {
        path: `artifacts/${name}.json`,
        sha256: digest(Buffer.from(JSON.stringify(value))),
        ...(name === "compatibilityProbe"
          ? {
              sourceFile:
                "apps/web/src/server/codex-rotating-dropped-response.real.test.ts",
              sourceFileSha256: digest(
                readFileSync(
                  join(
                    process.cwd(),
                    "apps/web/src/server/codex-rotating-dropped-response.real.test.ts",
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
        "database observation version is invalid",
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
        "000061_codex_oauth_provider_mutation_fence migration history is not exactly one current success",
        "rollback floor must be the fence-aware deployed commit",
      ]),
    );
  });

  it("runs the CLI over real artifact files and rejects post-write tampering", () => {
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
      runCodexRotatingRolloutVerifierCli([evidencePath], {
        stdout: { write: (v: string) => (output += v) },
        stderr: { write: (v: string) => (errors += v) },
      }),
      errors,
    ).toBe(0);
    expect(output).toMatch(/^PASS proof-bundle-sha256=[a-f0-9]{64}\n$/u);
    writeFileSync(join(directory, "artifacts/database.json"), "{}\n");
    expect(
      runCodexRotatingRolloutVerifierCli([evidencePath], {
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      }),
    ).toBe(1);
  });
});

function observedFixture(): any {
  const commit = "a".repeat(40);
  const imageDigest = `sha256:${"b".repeat(64)}`;
  const sourceDigest = (path: string) =>
    digest(readFileSync(join(process.cwd(), path)));
  const artifacts: any = {
    database: {
      observationVersion: 2,
      postgresVersion: "17.6",
      unsafeWork: {
        activeLeasesWithoutPositiveEpoch: 0,
        activeManifestsWithoutPositiveEpoch: 0,
        pendingIntents: 0,
        pendingIntentsWithoutPositiveEpoch: 0,
      },
      fetchedRecoveryOwner: "setup:fetched-new",
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
      ],
      catalog: {
        triggers: [
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
            "CodexOAuthWritebackIntent_identity_fence_guard",
            "CodexOAuthWritebackIntent",
            "codex_oauth_child_identity_fence_guard",
            23,
          ],
          [
            "RepositoryConnection_codex_oauth_identity_guard",
            "RepositoryConnection",
            "codex_oauth_repository_identity_guard",
            17,
          ],
        ].map(([name, table, fn, type]) => ({
          name,
          table,
          function: fn,
          type,
        })),
        checks: [
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
        ].map(([name, definition, validated]) => ({
          name,
          definition,
          validated,
        })),
        indexes: [
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
            "providerInstanceRowId issued fetched",
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
        ].map(([name, definition, unique]) => ({
          name,
          definition,
          predicate: "",
          unique,
          valid: true,
          ready: true,
        })),
      },
    },
    deployments: {
      observationVersion: 1,
      source: "render-api",
      services: ["api", "web", "worker"].map((name) => ({
        name,
        commit,
        imageDigest,
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
        },
        {
          type: "canary_passed",
          observedAt: "2026-08-09T00:09:00Z",
          compatibilityArtifactSha256: "set-below",
        },
        { type: "widening_approved", observedAt: "2026-08-09T00:10:00Z" },
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
  const evidence: any = { version: 2, artifacts: {} };
  for (const name of Object.keys(artifacts))
    evidence.artifacts[name] = {
      path: `artifacts/${name}.json`,
      sha256: digest(Buffer.from(JSON.stringify(artifacts[name]))),
    };
  evidence.artifacts.compatibilityProbe.sourceFile =
    "apps/web/src/server/codex-rotating-dropped-response.real.test.ts";
  evidence.artifacts.compatibilityProbe.sourceFileSha256 = sourceDigest(
    evidence.artifacts.compatibilityProbe.sourceFile,
  );
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
