import { describe, expect, it } from "vitest";
import {
  assembleTrustedRolloutEvidence,
  assertTrustedRolloutEvidence,
  type TrustedRolloutEvidence,
} from "./trusted-rollout-evidence";

const digest = `sha256:${"a".repeat(64)}`;
const source = {
  renderResourceId: "dpg-source",
  systemIdentifier: "100",
  majorVersion: 16 as const,
  recoveryWitnessSha256: "b".repeat(64),
};
const target = {
  renderResourceId: "dpg-target",
  systemIdentifier: "200",
  majorVersion: 17 as const,
  recoveryWitnessSha256: "c".repeat(64),
};
const create = () =>
  assembleTrustedRolloutEvidence({
    rolloutId: "rollout-evidence-1",
    releaseCommitSha: "d".repeat(40),
    runners: [
      {
        repository: "777genius/review-router",
        runId: "10",
        runAttempt: 1,
        commitSha: "d".repeat(40),
        jitLabel: "rr-10-1-role-bootstrap",
        runnerName: "rr-10-1-role",
        renderJobId: "job-role-10",
        baseServiceId: "srv-base",
        baseDeployId: "dep-pinned",
        imageDigest: digest,
      },
      {
        repository: "777genius/review-router",
        runId: "10",
        runAttempt: 1,
        commitSha: "d".repeat(40),
        jitLabel: "rr-10-1-cutover",
        runnerName: "rr-10-1-cutover",
        renderJobId: "job-cutover-10",
        baseServiceId: "srv-base",
        baseDeployId: "dep-pinned",
        imageDigest: digest,
      },
    ],
    source,
    target,
    backup: {
      backupId: "backup-10",
      pitrIdentity: "pitr-10-lsn",
      capturedAt: "2026-08-11T00:00:00.000Z",
    },
    quiescence: {
      writersSuspended: true,
      nonCutoverSessionCount: 0,
      sourceRuntimeConnectRevoked: true,
    },
    dumpSha256: digest,
    equivalence: {
      tables: [
        {
          table: "Workspace",
          sourceRows: 2,
          targetRows: 2,
          sourceSha256: digest,
          targetSha256: digest,
        },
      ],
      sequencesSha256: digest,
      constraintsSha256: digest,
      indexesSha256: digest,
      migrationHistorySha256: digest,
      equivalent: true,
    },
    aclGateBeforeActivation: "closed",
    activation: {
      step: "activate_target_generation",
      receiptId: "activation-1",
      observedAt: "2026-08-11T00:01:00.000Z",
      payloadSha256: digest,
      sourceSystemIdentifier: source.systemIdentifier,
      targetSystemIdentifier: target.systemIdentifier,
      canonicalPrivilegesSha256: digest,
      transactionId: "123",
      firstWriteBoundary: true,
    },
    cleanups: [
      {
        renderJobTerminal: true,
        workspaceRemoved: true,
        bootstrapCredentialsAbsent: true,
        renderJobId: "job-role-10",
        observedAt: "2026-08-11T00:02:00.000Z",
      },
      {
        renderJobTerminal: true,
        workspaceRemoved: true,
        bootstrapCredentialsAbsent: true,
        renderJobId: "job-cutover-10",
        observedAt: "2026-08-11T00:03:00.000Z",
      },
    ],
  });

describe("trusted rollout evidence", () => {
  it("assembles and verifies one canonical digest-bound aggregate", () => {
    expect(assertTrustedRolloutEvidence(create())).toEqual(create());
  });
  it.each([
    [
      "runner splice",
      (value: TrustedRolloutEvidence) => ({
        ...value,
        runners: [{ ...value.runners[0], runId: "11" }, value.runners[1]],
      }),
    ],
    [
      "unknown-field splice",
      (value: TrustedRolloutEvidence) => ({ ...value, unknown: true }),
    ],
    [
      "backup splice",
      (value: TrustedRolloutEvidence) => ({
        ...value,
        backup: { ...value.backup, backupId: "backup-other" },
      }),
    ],
    [
      "cleanup splice",
      (value: TrustedRolloutEvidence) => ({
        ...value,
        cleanups: [
          { ...value.cleanups[0], workspaceRemoved: false },
          value.cleanups[1],
        ],
      }),
    ],
    [
      "activation generation splice",
      (value: TrustedRolloutEvidence) => ({
        ...value,
        activation: { ...value.activation, targetSystemIdentifier: "201" },
      }),
    ],
    [
      "equivalence splice",
      (value: TrustedRolloutEvidence) => ({
        ...value,
        equivalence: {
          ...value.equivalence,
          tables: [{ ...value.equivalence.tables[0]!, targetRows: 3 }],
        },
      }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(() =>
      assertTrustedRolloutEvidence(mutate(create()) as TrustedRolloutEvidence),
    ).toThrow(/trusted_rollout_evidence_/u);
  });
  it("rejects evidence containing a database URL even with a recomputed shape", () => {
    const value = create();
    expect(() =>
      assembleTrustedRolloutEvidence({
        ...value,
        rolloutId: "postgresql://user:secret@host/db",
      }),
    ).toThrow();
  });
});
