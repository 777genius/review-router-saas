import { describe, expect, it } from "vitest";
import {
  createReleaseRollout,
  RolloutStep,
  transitionFromObservation,
  type RunnerIdentity,
} from "./release-rollout";
import {
  assembleTrustedRolloutEvidence,
  assertTrustedRolloutEvidence,
  type TrustedRolloutEvidence,
} from "./trusted-rollout-evidence";

const digest = `sha256:${"a".repeat(64)}`;
const base = createReleaseRollout({
  rolloutId: "rollout-evidence",
  expectedCommitSha: "d".repeat(40),
  execution: {
    organization: "rr-control",
    controlRepository: "rr-control/releases",
    workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
    workflowRef: "refs/heads/main",
    event: "workflow_dispatch",
    actor: "operator",
    runId: "123",
    runAttempt: 1,
    expectedJobName: "private-job",
  },
  source: {
    renderResourceId: "dpg-source",
    internalHostname: "source.internal",
    databaseName: "reviewrouter",
    systemIdentifier: "100",
    majorVersion: 16,
    recoveryWitnessSha256: "b".repeat(64),
  },
  target: {
    renderResourceId: "dpg-target",
    internalHostname: "target.internal",
    databaseName: "reviewrouter",
    systemIdentifier: "200",
    majorVersion: 17,
    recoveryWitnessSha256: "c".repeat(64),
  },
});
const steps = [
  RolloutStep.ClaimRollout,
  RolloutStep.FreezeProviderServices,
  RolloutStep.ProvisionRoleRunner,
  RolloutStep.CaptureSourceBackup,
  RolloutStep.QuiesceSource,
  RolloutStep.CopyDatabaseGeneration,
  RolloutStep.VerifyDataEquivalence,
  RolloutStep.BootstrapTargetRoles,
  RolloutStep.CleanupRoleRunner,
  RolloutStep.ProvisionCutoverRunner,
  RolloutStep.RunReleaseMigration,
  RolloutStep.StageTargetServices,
  RolloutStep.ActivateTargetGeneration,
  RolloutStep.CleanupCutoverRunner,
  RolloutStep.ResumeTargetServices,
  RolloutStep.VerifyLiveCanary,
] as const;
let rollout = base;
steps.forEach((step, index) => {
  rollout = transitionFromObservation(rollout, {
    step,
    observedAt: `2026-08-12T00:00:${String(index).padStart(2, "0")}.000Z`,
    facts:
      step === RolloutStep.ActivateTargetGeneration
        ? {
            firstWriteBoundary: true,
            canonicalPrivilegesSha256: digest,
            catalogFactsSha256: digest,
            firstWriteReceiptSha256: digest,
            transactionId: "42",
          }
        : { ok: true },
  });
});
const runner = (job: string, name: string): RunnerIdentity => ({
  organization: "rr-control",
  repository: "rr-control/releases",
  workflowPath: base.execution.workflowPath,
  workflowRef: base.execution.workflowRef,
  event: "workflow_dispatch",
  actor: "operator",
  runId: "123",
  runAttempt: 1,
  workflowJobId: name === "role" ? "1" : "2",
  workflowJobName: "private-job",
  commitSha: base.expectedCommitSha,
  runnerName: `rr-${name}`,
  cleanupCanary: `rr-cleanup:${base.rolloutId}:rr-${name}`,
  renderJobId: job,
  baseServiceId: "srv-base",
  runnerGroupId: 17,
  provenance: {
    kind: "git",
    deployId: "dep-pinned",
    commitSha: base.expectedCommitSha,
  },
});
const create = () =>
  assembleTrustedRolloutEvidence({
    rolloutId: base.rolloutId,
    releaseCommitSha: base.expectedCommitSha,
    execution: base.execution,
    runners: [runner("job-role", "role"), runner("job-cutover", "cutover")],
    source: base.source,
    target: base.target,
    backup: {
      renderResourceId: base.source.renderResourceId,
      internalHostname: base.source.internalHostname,
      databaseName: base.source.databaseName,
      systemIdentifier: base.source.systemIdentifier,
      lsn: "0/16B6C50",
      capturedAt: "2026-08-12T00:00:20.000Z",
      recoveryWindowStartsAt: "2026-08-11T00:00:00.000Z",
      recoveryWindowEndsAt: "2026-08-13T00:00:00.000Z",
      dumpSha256: digest,
      externalWitnessSha256: digest,
      recoveryStatus: "available",
    },
    quiescence: {
      writerServices: [
        {
          serviceId: "srv-api",
          suspended: true,
          observedAt: "2026-08-12T00:00:01.000Z",
        },
      ],
      aclSha256: digest,
      stabilizationSeries: [0, 0, 0],
      reconnectDeniedRoles: [
        "reviewrouter_api",
        "reviewrouter_web",
        "reviewrouter_worker",
        "reviewrouter_codex_effect_authority",
      ],
      complete: true,
    },
    equivalence: {
      tables: [
        {
          table: "public.items",
          sourceRows: 3,
          targetRows: 3,
          sourceSha256: digest,
          targetSha256: digest,
        },
      ],
      catalogSha256: {
        sequences: digest,
        columnsDefaults: digest,
        constraintsIndexesTriggers: digest,
        policiesRls: digest,
        functionsViewsSchemas: digest,
        aclOwnershipDefaults: digest,
        migrationHistory: digest,
      },
      equivalent: true,
      streamingHash: true,
      maxProcessBufferBytes: 8 * 1024 * 1024,
    },
    protectedEnvironmentPreflightSha256: digest,
    receipts: rollout.receipts,
    activation: rollout.activationReceipt!,
    resumedTargetDeployIds: ["dep-release"],
    liveCanarySha256: digest,
    cleanups: [
      {
        renderJobId: "job-role",
        providerStatus: "succeeded",
        listenerStopped: true,
        workspaceRemoved: true,
        credentialProcessGone: true,
        cleanupCanary: "rr-cleanup:rollout-evidence:rr-role",
        observedAt: "2026-08-12T00:02:00.000Z",
      },
      {
        renderJobId: "job-cutover",
        providerStatus: "succeeded",
        listenerStopped: true,
        workspaceRemoved: true,
        credentialProcessGone: true,
        cleanupCanary: "rr-cleanup:rollout-evidence:rr-cutover",
        observedAt: "2026-08-12T00:03:00.000Z",
      },
    ],
    assembledAt: "2026-08-12T00:04:00.000Z",
  });

describe("trusted post-cleanup evidence", () => {
  it("verifies the two runner lifecycles, receipt chain, activation, service resume, and canary", () => {
    expect(assertTrustedRolloutEvidence(create())).toEqual(create());
  });
  it.each([
    [
      "receipt transplant",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        receipts: v.receipts.map((r, i) =>
          i === 2 ? { ...r, rolloutId: "other" } : r,
        ),
      }),
    ],
    [
      "cleanup canary forgery",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        cleanups: [
          { ...v.cleanups[0], cleanupCanary: "rr-cleanup:other" },
          v.cleanups[1],
        ],
      }),
    ],
    [
      "early assembly",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        assembledAt: "2026-08-12T00:01:00.000Z",
      }),
    ],
    [
      "PG16 transplant",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        activation: {
          ...v.activation,
          targetSystemIdentifier: v.source.systemIdentifier,
        },
      }),
    ],
  ])("rejects %s", (_name, mutate) =>
    expect(() =>
      assertTrustedRolloutEvidence(mutate(create()) as TrustedRolloutEvidence),
    ).toThrow(),
  );
});
