import { describe, expect, it } from "vitest";
import { normalizeMigrationEvidenceReceipts } from "./codex-rotating-migration-receipts.mjs";

const legacy = {
  artifactDigest: `sha256:${"a".repeat(64)}`,
  artifactId: "101",
  rolloutId: "historical-rollout",
  runId: "201",
  claimedAt: "2026-08-09T00:00:00.000Z",
};

const current = {
  receiptVersion: 4,
  artifactDigest: `sha256:${"b".repeat(64)}`,
  artifactId: "102",
  rolloutId: "current-rollout",
  runId: "202",
  runAttempt: 1,
  jobId: "302",
  workflowPath: ".github/workflows/codex-rotating-release-migration.yml",
  commit: "c".repeat(40),
  imageDigest: `sha256:${"d".repeat(64)}`,
  systemIdentifier: "7612345678901234567",
  recoveryWitnessSha256: "e".repeat(64),
  claimedAt: "2026-08-10T00:00:00.000Z",
};

describe("migration evidence receipt history", () => {
  it("deterministically versions mixed historical v2 and generation-bound receipts", () => {
    expect(normalizeMigrationEvidenceReceipts([legacy, current])).toEqual([
      { ...legacy, receiptVersion: 2 },
      current,
    ]);
  });

  it.each([
    [{ ...legacy, artifactId: 101 }],
    [{ ...legacy, unexpected: "field" }],
    [{ ...legacy, claimedAt: "2026-02-31T00:00:00.000Z" }],
    [{ ...current, receiptVersion: 3 }],
  ])("rejects a malformed receipt without dropping fields", (receipt) => {
    expect(() => normalizeMigrationEvidenceReceipts([receipt])).toThrow(
      "malformed or unsupported",
    );
  });

  it("rejects replay keys across receipt versions", () => {
    expect(() =>
      normalizeMigrationEvidenceReceipts([
        legacy,
        { ...current, rolloutId: legacy.rolloutId },
      ]),
    ).toThrow("replay keys are duplicated");
  });
});
