import { describe, expect, it } from "vitest";
import {
  createReleaseMigrationTransition,
  createReleaseRollout,
} from "../packages/features/release-rollout/src/index";
import { parseInitialRolloutArtifact } from "./reconcile-private-pg17-compensation";

const rolloutId = "pg17-release-1";
const generation = <const Major extends 16 | 17>(majorVersion: Major) => ({
  renderResourceId: `dpg-generation-${majorVersion}`,
  internalHostname: `postgres-${majorVersion}.internal`,
  databaseName: "review_router",
  systemIdentifier: `${majorVersion}1234567890`,
  majorVersion,
  recoveryWitnessSha256: "a".repeat(64),
});
const rollout = () =>
  createReleaseRollout({
    rolloutId,
    expectedCommitSha: "b".repeat(40),
    migrationTransition: createReleaseMigrationTransition({
      commitSha: "b".repeat(40),
      releaseImageDigest: `sha256:${"e".repeat(64)}`,
    }),
    execution: {
      organization: "777genius",
      controlRepository: "777genius/review-router-saas",
      workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
      workflowRef: "refs/heads/main",
      event: "workflow_dispatch",
      actor: "release-operator",
      runId: "12345",
      runAttempt: 1,
      roleJobName: "role-bootstrap-private",
      cutoverJobName: "pg17-cutover-private",
    },
    source: generation(16),
    target: generation(17),
  });

describe("private PG17 compensation artifact", () => {
  it("reads the initializer's versioned rollout wrapper", () => {
    expect(
      parseInitialRolloutArtifact({ rollout: rollout() }, rolloutId),
    ).toEqual(rollout());
  });

  it("rejects the raw rollout and unsupported rollout schema", () => {
    expect(() => parseInitialRolloutArtifact(rollout(), rolloutId)).toThrow(
      "private_pg17_reconcile_artifact_invalid",
    );
    expect(() =>
      parseInitialRolloutArtifact(
        { rollout: { ...rollout(), schemaVersion: 1 } },
        rolloutId,
      ),
    ).toThrow("private_pg17_reconcile_schema_version_unsupported");
  });

  it("rejects malformed and mismatched wrapped rollouts", () => {
    expect(() =>
      parseInitialRolloutArtifact(
        { rollout: { schemaVersion: 3, rolloutId } },
        rolloutId,
      ),
    ).toThrow("private_pg17_reconcile_rollout_invalid");
    expect(() =>
      parseInitialRolloutArtifact({ rollout: rollout() }, "another-rollout"),
    ).toThrow("private_pg17_reconcile_rollout_mismatch");
  });
});
