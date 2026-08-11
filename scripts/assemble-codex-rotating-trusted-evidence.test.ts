import { describe, expect, it } from "vitest";
import { assembleTrustedMigrationEvidence } from "./assemble-codex-rotating-trusted-evidence.mjs";

const commit = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const databaseIdentity = "db.external:5432/review_router";
const roleNames = [
  "reviewrouter_api",
  "reviewrouter_web",
  "reviewrouter_worker",
  "reviewrouter_codex_effect_authority",
  "reviewrouter_release_migration",
];

function fixture() {
  return {
    env: {
      GITHUB_SHA: commit,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REPOSITORY_ID: "17",
      GITHUB_REPOSITORY: "777genius/review-router-saas",
      GITHUB_RUN_ID: "101",
      REVIEW_ROUTER_GITHUB_JOB_ID: "202",
      RENDER_OWNER_ID: "owner-1",
      RENDER_PROJECT_ID: "project-1",
      RENDER_ENVIRONMENT_ID: "environment-1",
      REVIEW_ROUTER_RELEASE_IMAGE_DIGEST: imageDigest,
      REVIEW_ROUTER_RENDER_DATABASE_IDENTITY: databaseIdentity,
      REVIEW_ROUTER_ROLLOUT_EVIDENCE_ARTIFACT_NAME:
        "reviewrouter-trusted-rollout-101-1",
      REVIEW_ROUTER_ROLLOUT_EVIDENCE_ROLLOUT_ID: "rollout-1",
    },
    databaseObservation: {
      observationVersion: 4,
      source: "render-api",
      database: {
        id: "dpg-1",
        name: "reviewrouter-db",
        version: "17.6",
        ownerId: "owner-1",
      },
    },
    migrationOutput: {
      version: 2,
      caller: "scripts/run-codex-rotating-release-migration.mjs",
      callerCount: 1,
      commit,
      databaseIdentity,
      imageDigest,
      migrationStatus: "succeeded",
      preflightOutputSha256: "c".repeat(64),
      preflightStatus: "passed",
      roles: roleNames.map((username) => ({
        username,
        login: true,
        superuser: false,
        createDatabase: false,
        createRole: false,
        replication: false,
        bypassRls: false,
        canSetReleaseRole: username === "reviewrouter_release_migration",
      })),
      status: "succeeded",
    },
  };
}

describe("provider-neutral trusted migration evidence assembly", () => {
  it("binds canonical output and read-only database observation to GitHub execution", () => {
    const value = fixture();
    expect(assembleTrustedMigrationEvidence(value as never)).toMatchObject({
      version: 4,
      rolloutId: "rollout-1",
      execution: {
        headSha: commit,
        jobId: "202",
        jobName: "trusted-release-migration",
      },
      release: { commit, imageDigest },
      database: {
        id: "dpg-1",
        postgresMajorVersion: "17",
        identity: databaseIdentity,
      },
      migration: { callerCount: 1, status: "succeeded" },
      runtimeRoles: expect.arrayContaining([
        expect.objectContaining({
          username: "reviewrouter_api",
          replication: false,
          bypassRls: false,
        }),
      ]),
    });
  });

  it.each([
    ["commit", { commit: "f".repeat(40) }],
    ["image", { imageDigest: `sha256:${"f".repeat(64)}` }],
    ["database", { databaseIdentity: "other:5432/review_router" }],
  ])("rejects a wrong %s binding", (_label, mutation) => {
    const value = fixture();
    expect(() =>
      assembleTrustedMigrationEvidence({
        ...value,
        migrationOutput: { ...value.migrationOutput, ...mutation },
      } as never),
    ).toThrow("trusted_evidence_migration_output_binding_mismatch");
  });
});
