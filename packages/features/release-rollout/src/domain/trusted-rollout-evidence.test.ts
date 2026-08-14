import { describe, expect, it } from "vitest";
import {
  createReleaseRollout,
  RolloutStep,
  sha256Canonical,
  type ActivationReceipt,
  type RunnerIdentity,
  type StepReceipt,
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
    roleJobName: "private-role-job",
    cutoverJobName: "private-cutover-job",
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
  RolloutStep.VerifyProtectedEnvironment,
  RolloutStep.FreezeProviderServices,
  RolloutStep.ProvisionRoleRunner,
  RolloutStep.CaptureSourceBackup,
  RolloutStep.QuiesceSource,
  RolloutStep.CopyDatabaseGeneration,
  RolloutStep.BootstrapTargetRoles,
  RolloutStep.VerifyDataEquivalence,
  RolloutStep.CleanupRoleRunner,
  RolloutStep.ProvisionCutoverRunner,
  RolloutStep.RunReleaseMigration,
  RolloutStep.StageTargetServices,
  RolloutStep.ActivateTargetGeneration,
  RolloutStep.CleanupCutoverRunner,
  RolloutStep.ResumeTargetServices,
  RolloutStep.VerifyLiveCanary,
] as const;
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
  workflowJobName:
    name === "role"
      ? base.execution.roleJobName
      : base.execution.cutoverJobName,
  commitSha: base.expectedCommitSha,
  runnerName: `rr-${name}`,
  cleanupCanary: `rr-cleanup:${base.rolloutId}:rr-${name}`,
  renderJobId: job,
  baseServiceId: "srv-base",
  runnerGroupId: 17,
  runnerGroupName: "private-pg17",
  uniqueRunnerLabel: `rr-${name}`,
  workFolder: `_work/rr-${name}`,
  provenance: {
    kind: "git",
    deployId: "dep-pinned",
    commitSha: base.expectedCommitSha,
  },
});
let previousReceiptSha256 = `sha256:${"0".repeat(64)}`;
const receipts = steps.map((step, index) => {
  const provider =
    step === RolloutStep.ProvisionRoleRunner
      ? {
          renderJobId: "job-role",
          renderDeployId: "dep-pinned",
          githubWorkflowJobId: "1",
        }
      : step === RolloutStep.ProvisionCutoverRunner
        ? {
            renderJobId: "job-cutover",
            renderDeployId: "dep-pinned",
            githubWorkflowJobId: "2",
          }
        : step === RolloutStep.CleanupRoleRunner
          ? { renderJobId: "job-role" }
          : step === RolloutStep.CleanupCutoverRunner
            ? { renderJobId: "job-cutover" }
            : step === RolloutStep.ResumeTargetServices
              ? {
                  renderServiceIds: ["srv-target"],
                  renderDeployIds: ["dep-release"],
                }
              : undefined;
  const common = {
    step,
    receiptId: `${base.rolloutId}:${step}:${index + 1}`,
    observedAt: `2026-08-12T00:00:${String(index).padStart(2, "0")}.000Z`,
    rolloutId: base.rolloutId,
    expectedCommitSha: base.expectedCommitSha,
    runId: base.execution.runId,
    runAttempt: 1,
    sourceSystemIdentifier: base.source.systemIdentifier,
    targetSystemIdentifier: base.target.systemIdentifier,
    provider,
    observationSha256: digest,
    previousReceiptSha256,
  };
  const unsigned =
    step === RolloutStep.ActivateTargetGeneration
      ? {
          ...common,
          step: RolloutStep.ActivateTargetGeneration,
          canonicalPrivilegesSha256: digest,
          beforePrincipalInventorySha256: digest,
          beforePrincipalPolicySha256: digest,
          activatedPrincipalInventorySha256: digest,
          activatedPrincipalPolicySha256: digest,
          catalogFactsSha256: digest,
          transactionId: "42",
          firstWriteReceiptSha256: digest,
          firstWriteBoundary: true as const,
        }
      : common;
  const receipt = {
    ...unsigned,
    receiptSha256: `sha256:${sha256Canonical(unsigned)}`,
  } as StepReceipt;
  previousReceiptSha256 = receipt.receiptSha256;
  return receipt;
});
const activation = receipts.find(
  (receipt) => receipt.step === RolloutStep.ActivateTargetGeneration,
)! as ActivationReceipt;
const releaseImageIdentity = {
  schemaVersion: "reviewrouter.hosted-runtime-image.v1" as const,
  repository: base.execution.controlRepository,
  commit: base.expectedCommitSha,
  imageUrl: `ghcr.io/777genius/review-router-saas-runtime@${digest}`,
  imageDigest: digest,
};
const imageRepository = "ghcr.io/777genius/review-router-saas-runtime";
const provenancePolicySha256 = `sha256:${"e".repeat(64)}`;
const trustedImagePolicy = {
  sourceRepository: base.execution.controlRepository,
  sourceRevision: base.expectedCommitSha,
  imageRepository,
  verificationPolicySha256: provenancePolicySha256,
} as const;
const create = () =>
  assembleTrustedRolloutEvidence(
    {
      rolloutId: base.rolloutId,
      releaseCommitSha: base.expectedCommitSha,
      releaseImageProvenance: {
        schemaVersion: "reviewrouter.release-image-provenance.v2",
        identity: releaseImageIdentity,
        claim: {
          identitySha256: `sha256:${sha256Canonical(releaseImageIdentity)}`,
          sourceRepository: base.execution.controlRepository,
          sourceRevision: base.expectedCommitSha,
          imageRepository,
          buildRunId: "321",
          artifactId: "654",
          artifactName: "hosted-runtime-image-v1.2.3",
        },
        verification: {
          policySha256: provenancePolicySha256,
          verifiedAt: "2026-08-12T00:00:00.000Z",
        },
      },
      targetDeploys: [
        {
          serviceId: "srv-api",
          deployId: "dep-release",
          imageDigest: digest,
        },
      ],
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
        recoveryStatus: "AVAILABLE",
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
        fence: {
          version: 1,
          fenceId: `source-fence:${base.rolloutId}`,
          rolloutId: base.rolloutId,
          sourceSystemIdentifier: base.source.systemIdentifier,
          authorityPrincipal: "fence_authority",
          beforeInventorySha256: digest,
          fencedInventorySha256: digest,
          beforePolicySha256: digest,
          fencedPolicySha256: digest,
          priorConnectAclSha256: digest,
          lifecycle: "active",
          observedAt: "2026-08-12T00:00:03.000Z",
        },
        legacyAmbiguity: {
          inventorySha256: digest,
          activeLeaseIds: ["legacy-lease"],
          fetchedSetupIds: ["legacy-setup"],
          pendingIntentIds: [],
          intentStatuses: ["completed", "failed"],
          observations: [
            {
              observedAt: "2026-08-12T00:00:02.000Z",
              inventorySha256: digest,
            },
            {
              observedAt: "2026-08-12T00:00:03.000Z",
              inventorySha256: digest,
            },
          ],
          stable: true,
        },
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
        effectivePrincipals: {
          sourceInventorySha256: digest,
          sourcePolicySha256: digest,
          targetInventorySha256: digest,
          targetPolicySha256: digest,
          stable: true,
        },
      },
      legacyReconciliation: {
        version: 1,
        acknowledgement: "all_prior_installers_and_writers_are_stopped",
        inventory: {
          activeLeaseIds: ["legacy-lease"],
          fetchedSetupIds: ["legacy-setup"],
          pendingIntentIds: [],
          intentStatuses: ["completed", "failed"],
        },
        inventorySha256: digest,
        stableSamples: 2,
        after: {
          activeLeaseIds: [],
          fetchedSetupIds: [],
          pendingIntentIds: [],
          intentStatuses: ["completed", "failed"],
        },
        status: "reconciled",
      },
      protectedEnvironmentPreflightSha256: receipts.find(
        (receipt) => receipt.step === RolloutStep.VerifyProtectedEnvironment,
      )!.observationSha256,
      receipts,
      activation,
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
    },
    trustedImagePolicy,
  );

describe("trusted post-cleanup evidence", () => {
  it("verifies the two runner lifecycles, receipt chain, activation, service resume, and canary", () => {
    expect(assertTrustedRolloutEvidence(create(), trustedImagePolicy)).toEqual(
      create(),
    );
  });
  it("rejects a target deploy whose image is not the attested release image", () => {
    const {
      schemaVersion: _schemaVersion,
      evidenceSha256: _hash,
      ...unsigned
    } = create();
    void _schemaVersion;
    void _hash;
    expect(() =>
      assembleTrustedRolloutEvidence(
        {
          ...unsigned,
          targetDeploys: [
            {
              ...unsigned.targetDeploys[0]!,
              imageDigest: `sha256:${"f".repeat(64)}`,
            },
          ],
        },
        trustedImagePolicy,
      ),
    ).toThrow("trusted_rollout_evidence_target_image_invalid");
  });
  it("rejects legacy schema 4 evidence instead of implicitly upgrading v1 provenance", () => {
    expect(() =>
      assertTrustedRolloutEvidence(
        {
          ...create(),
          schemaVersion: 4,
        } as unknown as TrustedRolloutEvidence,
        trustedImagePolicy,
      ),
    ).toThrow("trusted_rollout_evidence_invariant_failed");
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
    [
      "resumed deploy transplant",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        resumedTargetDeployIds: ["dep-attacker"],
      }),
    ],
    [
      "protected preflight substitution",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        protectedEnvironmentPreflightSha256: `sha256:${"b".repeat(64)}`,
      }),
    ],
  ])("rejects %s", (_name, mutate) =>
    expect(() =>
      assertTrustedRolloutEvidence(
        mutate(create()) as TrustedRolloutEvidence,
        trustedImagePolicy,
      ),
    ).toThrow(),
  );
});
