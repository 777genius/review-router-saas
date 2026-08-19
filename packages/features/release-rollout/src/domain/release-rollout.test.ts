import { describe, expect, it } from "vitest";
import {
  ReleaseApprovalMode,
  assertPromotionAllowed,
  beginReleaseMigrationAttempt,
  beginCompensation,
  completeCompensation,
  createReleaseRollout,
  recoverCompletedReleaseMigration,
  RolloutPhase,
  RolloutStep,
  sha256Canonical,
  targetMigrationReceiptEvidence,
  transitionFailure,
  transitionFromObservation,
  type ReleaseMigrationReceipt,
} from "./release-rollout";
import {
  createReleaseMigrationTransition,
  type ReleaseMigrationPermit,
} from "./release-migration-transition";

const digest = `sha256:${"a".repeat(64)}`;
const sourceLegacyAmbiguityUnsigned = {
  schemaVersion: 1 as const,
  rolloutId: "rollout-2026-08-12",
  sourceSystemIdentifier: "100",
  sourceDatabaseName: "reviewrouter",
  sourceRecoveryWitnessSha256: "b".repeat(64),
  authorityPrincipal: "source_admin",
  fenceId: "source-fence:rollout-2026-08-12",
  fenceEstablishedAt: "2026-08-12T00:00:00.000Z",
  fencedInventorySha256: `sha256:${"f".repeat(64)}`,
  inventorySha256:
    "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
  activeLeaseIds: [],
  fetchedSetupIds: [],
  pendingIntentIds: [],
  intentStatuses: [],
  observations: [
    {
      observedAt: "2026-08-12T00:00:01.000Z",
      inventorySha256:
        "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
    },
    {
      observedAt: "2026-08-12T00:00:02.000Z",
      inventorySha256:
        "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
    },
  ],
  eligibilityCutoff: "2026-08-12T00:00:02.000Z",
  stable: true,
} as const;
const sourceLegacyAmbiguity = {
  ...sourceLegacyAmbiguityUnsigned,
  receiptSha256: `sha256:${sha256Canonical(sourceLegacyAmbiguityUnsigned)}`,
} as const;

describe("target migration receipt evidence", () => {
  it("derives both rollout evidence fields from the exact canonical receipt", () => {
    const receipt = {
      effectFingerprint: `sha256:${"b".repeat(64)}`,
      epoch: 7,
      nonce: "receipt-nonce",
    };

    expect(targetMigrationReceiptEvidence(receipt)).toEqual({
      targetMigrationReceiptSha256: `sha256:${sha256Canonical(receipt)}`,
      targetMigrationEffectFingerprint: receipt.effectFingerprint,
    });
  });

  it.each([null, [], {}, { effectFingerprint: "not-a-digest" }])(
    "rejects an unproven receipt: %j",
    (receipt) => {
      expect(() => targetMigrationReceiptEvidence(receipt)).toThrow(
        "target_migration_receipt_unproven",
      );
    },
  );
});
const migrationTransitionFixture = createReleaseMigrationTransition({
  commitSha: "d".repeat(40),
  releaseImageDigest: `sha256:${"e".repeat(64)}`,
});
const servicePostcondition = (suspended: boolean) => ({
  serviceId: "srv-target",
  ownerId: "tea-owner",
  serviceType: "web_service",
  suspended,
  region: "frankfurt",
  plan: "starter",
  runtime: "image" as const,
  image: `registry.example.test/app@sha256:${"a".repeat(64)}`,
  repository: null,
  branch: null,
  rootDirectory: null,
  buildCommand: null,
  startCommand: null,
  preDeployCommand: "",
  healthPath: "/health",
  automaticDeployments: false as const,
  automaticDeployTrigger: "off" as const,
  shutdownDelaySeconds: 60,
  instanceCount: 1,
  environmentSha256: digest,
});
const create = () =>
  createReleaseRollout({
    rolloutId: "rollout-2026-08-12",
    expectedCommitSha: "d".repeat(40),
    migrationTransition: migrationTransitionFixture,
    execution: {
      organization: "reviewrouter-control",
      controlRepository: "reviewrouter-control/releases",
      workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
      workflowRef: "refs/heads/main",
      event: "workflow_dispatch",
      actor: "release-operator",
      runId: "123",
      runAttempt: 1,
      roleJobName: "copy-and-role-bootstrap-private",
      cutoverJobName: "pg17-cutover-private",
    },
    source: {
      renderResourceId: "dpg-source",
      internalHostname: "dpg-source.internal",
      databaseName: "reviewrouter",
      systemIdentifier: "100",
      majorVersion: 16,
      recoveryWitnessSha256: "b".repeat(64),
    },
    target: {
      renderResourceId: "dpg-target",
      internalHostname: "dpg-target.internal",
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
  RolloutStep.QuiesceSource,
  RolloutStep.CaptureSourceBackup,
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
  RolloutStep.VerifyTrustedRollout,
] as const;
const catalogSha256 = {
  sequences: digest,
  columnsDefaults: digest,
  constraintsIndexesTriggers: digest,
  policiesRls: digest,
  functionsViewsSchemas: digest,
  aclOwnershipDefaults: digest,
  migrationHistory: digest,
};
const runner = (lifecycle: "role" | "cutover") => ({
  organization: "reviewrouter-control",
  repository: "reviewrouter-control/releases",
  workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
  workflowRef: "refs/heads/main",
  event: "workflow_dispatch" as const,
  actor: "release-operator",
  runId: "123",
  runAttempt: 1,
  workflowJobId: lifecycle === "role" ? "1001" : "1002",
  workflowJobName:
    lifecycle === "role"
      ? "copy-and-role-bootstrap-private"
      : "pg17-cutover-private",
  commitSha: "d".repeat(40),
  runnerName: `rr-${lifecycle}`,
  cleanupCanary: `rr-cleanup:rollout-2026-08-12:rr-${lifecycle}`,
  renderJobId: `job-${lifecycle}`,
  baseServiceId: "srv-runner",
  runnerGroupId: 17,
  runnerGroupName: "private-pg17",
  uniqueRunnerLabel: `rr-${lifecycle}`,
  workFolder: `_work/rr-${lifecycle}`,
  provenance: {
    kind: "git" as const,
    deployId: "dep-runner",
    commitSha: "d".repeat(40),
  },
});
const observe = (step: (typeof steps)[number], index: number) => {
  const observedAt = `2026-08-12T00:00:${String(index).padStart(2, "0")}.000Z`;
  const base = { step, observedAt };
  switch (step) {
    case RolloutStep.ClaimRollout:
      return { ...base, facts: { durableClaim: true } };
    case RolloutStep.VerifyProtectedEnvironment:
      return {
        ...base,
        facts: {
          organization: "reviewrouter-control",
          repository: "reviewrouter-control/releases",
          workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
          workflowRef: "refs/heads/main",
          sha: "d".repeat(40),
          event: "workflow_dispatch",
          actor: "release-operator",
          runId: "123",
          runAttempt: 1,
          approvalMode: ReleaseApprovalMode.SoloOwner,
          environments: [
            {
              name: "production-release-preflight",
              requiredReviewerCount: 1,
              preventSelfReview: false,
              protectedBranchesOnly: true,
            },
          ],
          runnerGroupId: 17,
          runnerGroupName: "private-pg17",
          uniqueRunnerLabel: "rr-role",
          workFolder: "_work/rr-role",
          observationSha256: digest,
        },
      };
    case RolloutStep.FreezeProviderServices:
      return {
        ...base,
        facts: {
          services: [
            {
              serviceId: "srv-writer",
              suspended: true,
              observedAt,
              latestSuccessfulDeployId: "dep-writer",
            },
          ],
          complete: true,
          discoveryScope: "provider_hint_only_database_fence_authoritative",
        },
        provider: {
          renderServiceIds: ["srv-writer"],
          renderDeployIds: ["dep-writer"],
          renderMutatedServiceIds: ["srv-writer"],
        },
      };
    case RolloutStep.ProvisionRoleRunner:
    case RolloutStep.ProvisionCutoverRunner: {
      const identity = runner(
        step === RolloutStep.ProvisionRoleRunner ? "role" : "cutover",
      );
      return {
        ...base,
        facts: identity,
        provider: {
          renderJobId: identity.renderJobId,
          renderDeployId: identity.provenance.deployId,
          githubWorkflowJobId: identity.workflowJobId,
        },
      };
    }
    case RolloutStep.CaptureSourceBackup:
      return {
        ...base,
        facts: {
          dumpSha256: digest,
          backup: {
            renderResourceId: "dpg-source",
            internalHostname: "dpg-source.internal",
            databaseName: "reviewrouter",
            systemIdentifier: "100",
            lsn: "0/100",
            capturedAt: observedAt,
            recoveryWindowStartsAt: null,
            recoveryWindowEndsAt: "2026-08-13T00:00:00.000Z",
            dumpSha256: digest,
            externalWitnessSha256: digest,
            recoveryStatus: "AVAILABLE",
          },
        },
      };
    case RolloutStep.QuiesceSource:
      return {
        ...base,
        facts: {
          writerServices: [
            { serviceId: "srv-writer", suspended: true, observedAt },
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
            fenceId: "source-fence:rollout-2026-08-12",
            rolloutId: "rollout-2026-08-12",
            sourceSystemIdentifier: "100",
            authorityPrincipal: "fence_authority",
            beforeInventorySha256: digest,
            fencedInventorySha256: digest,
            beforePolicySha256: digest,
            fencedPolicySha256: digest,
            priorConnectAclSha256: digest,
            lifecycle: "active",
            observedAt,
          },
          complete: true,
        },
      };
    case RolloutStep.CopyDatabaseGeneration:
      return {
        ...base,
        facts: {
          dumpSha256: digest,
          ownershipRestored: false,
          privilegesRestored: false,
        },
      };
    case RolloutStep.VerifyDataEquivalence:
      return {
        ...base,
        facts: {
          tables: [
            {
              table: "public.items",
              sourceRows: 1,
              targetRows: 1,
              sourceSha256: digest,
              targetSha256: digest,
            },
          ],
          catalogSha256,
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
      };
    case RolloutStep.BootstrapTargetRoles:
      return {
        ...base,
        facts: {
          version: 2,
          status: "succeeded",
          commit: "d".repeat(40),
          imageDigest: `sha256:${"e".repeat(64)}`,
          migrationChecksum: migrationTransitionFixture.postManifestIdentity,
          roles: [1, 2, 3, 4],
        },
      };
    case RolloutStep.CleanupRoleRunner:
    case RolloutStep.CleanupCutoverRunner: {
      const identity = runner(
        step === RolloutStep.CleanupRoleRunner ? "role" : "cutover",
      );
      return {
        ...base,
        facts: {
          provider: { id: identity.renderJobId, status: "succeeded" },
          runner: {
            listenerStopped: true,
            workspaceRemoved: true,
            credentialProcessGone: true,
            canary: identity.cleanupCanary,
            observedAt,
          },
        },
        provider: { renderJobId: identity.renderJobId },
      };
    }
    case RolloutStep.RunReleaseMigration:
      return {
        ...base,
        facts: {
          version: 3,
          status: "succeeded",
          migrationStatus: "succeeded",
          preflightStatus: "passed",
          aclGateState: "closed",
          commit: "d".repeat(40),
          imageDigest: `sha256:${"e".repeat(64)}`,
          migrationChecksum: migrationTransitionFixture.postManifestIdentity,
          transitionSha256: migrationTransitionFixture.transitionSha256,
          migrationArtifactDigest:
            migrationTransitionFixture.migrationArtifactDigest,
          migrationBundleSha256:
            migrationTransitionFixture.migrationBundleSha256,
          preManifestIdentity: migrationTransitionFixture.preManifestIdentity,
          postManifestIdentity: migrationTransitionFixture.postManifestIdentity,
          postCatalogDigest: migrationTransitionFixture.postCatalogDigest,
          permitEpoch: 1,
          permitNonce: "a".repeat(32),
          targetSystemIdentifier: "200",
          targetRecoveryWitnessSha256: "c".repeat(64),
          targetMigrationReceiptSha256: `sha256:${"d".repeat(64)}`,
          targetMigrationEffectFingerprint: `sha256:${"e".repeat(64)}`,
          roles: [1, 2, 3, 4],
        },
      };
    case RolloutStep.StageTargetServices:
      return {
        ...base,
        facts: [
          {
            serviceId: "srv-target",
            deployId: "dep-target",
            provenance: { kind: "git", commitSha: "d".repeat(40) },
            envSha256: digest,
            recoveryWitnessSha256: "a".repeat(64),
            suspended: true,
            servicePostcondition: servicePostcondition(true),
          },
        ],
        provider: {
          renderServiceIds: ["srv-target"],
          renderDeployIds: ["dep-target"],
          serviceRecoveryManifestSha256: digest,
          targetServiceContractSha256: digest,
        },
      };
    case RolloutStep.ActivateTargetGeneration:
      return {
        ...base,
        facts: {
          rolloutId: "rollout-2026-08-12",
          sourceSystemIdentifier: "100",
          targetSystemIdentifier: "200",
          firstWriteBoundary: true,
          canonicalPrivilegesSha256: digest,
          beforePrincipalInventorySha256: digest,
          beforePrincipalPolicySha256: digest,
          activatedPrincipalInventorySha256: digest,
          activatedPrincipalPolicySha256: digest,
          catalogFactsSha256: digest,
          preactivationCatalogPolicySha256: digest,
          activatedCatalogPolicySha256: digest,
          firstWriteReceiptSha256: digest,
          observationSha256: digest,
          transactionId: "42",
          postgresMajor: 17,
          migrationChecksum: migrationTransitionFixture.postManifestIdentity,
          transitionSha256: migrationTransitionFixture.transitionSha256,
          postManifestIdentity: migrationTransitionFixture.postManifestIdentity,
          permitEpoch: 1,
          permitNonce: "a".repeat(32),
          targetDeployIds: ["dep-target"],
        },
      };
    case RolloutStep.ResumeTargetServices:
      return {
        ...base,
        facts: [
          {
            serviceId: "srv-target",
            deployId: "dep-target",
            resumed: true,
            servicePostcondition: servicePostcondition(false),
          },
        ],
        provider: {
          renderServiceIds: ["srv-target"],
          renderDeployIds: ["dep-target"],
        },
      };
    case RolloutStep.VerifyLiveCanary: {
      const nonce = "f".repeat(48);
      const serviceFacts = ["api", "web", "worker"].map((runtimeRole) => ({
        runtimeRole,
        serviceId: `srv-${runtimeRole}`,
        deployId: `dep-${runtimeRole}`,
        deploymentProvenance: "d".repeat(40),
        servicePostconditionSha256: digest,
      }));
      return {
        ...base,
        facts: {
          commitSha: "d".repeat(40),
          databaseSystemIdentifier: "200",
          recoveryWitnessSha256: "b".repeat(64),
          runtimeWitnessProofs: ["api", "web", "worker"].map(
            (runtimeRole, index) => ({
              runtimeRole,
              databaseRole: `reviewrouter_${runtimeRole}`,
              recoveryWitnessSha256: "b".repeat(64),
              provedAt: observedAt,
              nonce,
              requestedAt: observedAt,
              serviceId: serviceFacts[index]!.serviceId,
              deployId: serviceFacts[index]!.deployId,
              deploymentProvenance: serviceFacts[index]!.deploymentProvenance,
              servicePostconditionSha256:
                serviceFacts[index]!.servicePostconditionSha256,
              systemIdentifier: "200",
              releaseCommitSha: "d".repeat(40),
            }),
          ),
          nonce,
          requestedAt: observedAt,
          observedAt,
          serviceFacts,
          expectedGeneration: {
            systemIdentifier: "200",
            recoveryWitnessSha256: "b".repeat(64),
          },
          writeReadRoundTrip: true,
        },
      };
    }
    case RolloutStep.VerifyTrustedRollout:
      return { ...base, facts: { evidenceSha256: digest } };
  }
};

describe("release rollout domain policy", () => {
  it.each([
    ["too short", "ab"],
    ["too long", `a${"b".repeat(512)}`],
    ["invalid character", "receipt id"],
    ["invalid first character", "@receipt"],
  ])("rejects a %s migration receipt identifier", (_case, receiptId) => {
    let rollout = create();
    steps.slice(0, 11).forEach((step, index) => {
      rollout = transitionFromObservation(rollout, observe(step, index));
    });
    const permit: ReleaseMigrationPermit = {
      schemaVersion: 1,
      rolloutId: rollout.rolloutId,
      runId: rollout.execution.runId,
      runAttempt: rollout.execution.runAttempt,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      targetRecoveryWitnessSha256: rollout.target.recoveryWitnessSha256,
      transitionSha256: rollout.migrationTransition.transitionSha256,
      expectedPreviousReceiptSha256: rollout.receipts.at(-1)!.receiptSha256,
      sourceLegacyAmbiguity,
      eligibilityCutoff: "2026-08-12T00:00:02.000Z",
      epoch: 1,
      nonce: "a".repeat(32),
    };
    const unsigned = {
      step: RolloutStep.RunReleaseMigration,
      receiptId,
      observedAt: "2026-08-12T00:00:00.000Z",
      rolloutId: rollout.rolloutId,
      expectedCommitSha: rollout.expectedCommitSha,
      runId: rollout.execution.runId,
      runAttempt: rollout.execution.runAttempt,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      provider: undefined,
      observationSha256: digest,
      previousReceiptSha256: permit.expectedPreviousReceiptSha256,
      migrationChecksum: rollout.migrationTransition.postManifestIdentity,
      transitionSha256: rollout.migrationTransition.transitionSha256,
      migrationArtifactDigest:
        rollout.migrationTransition.migrationArtifactDigest,
      migrationBundleSha256: rollout.migrationTransition.migrationBundleSha256,
      preManifestIdentity: rollout.migrationTransition.preManifestIdentity,
      postManifestIdentity: rollout.migrationTransition.postManifestIdentity,
      postCatalogDigest: rollout.migrationTransition.postCatalogDigest,
      permitEpoch: permit.epoch,
      permitNonce: permit.nonce,
      targetMigrationReceiptSha256: `sha256:${"d".repeat(64)}`,
      targetMigrationEffectFingerprint: `sha256:${"e".repeat(64)}`,
    };
    const receipt: ReleaseMigrationReceipt = {
      ...unsigned,
      receiptSha256: `sha256:${sha256Canonical(unsigned)}`,
    };

    expect(() =>
      recoverCompletedReleaseMigration(rollout, permit, receipt),
    ).toThrow("release_migration_receipt_recovery_invalid");
  });

  it("hash-chains observation-derived receipts through activation, resume, cleanup, and verification", () => {
    let rollout = create();
    steps.forEach((step, index) => {
      if (step === RolloutStep.RunReleaseMigration)
        rollout = beginReleaseMigrationAttempt(rollout, {
          schemaVersion: 1,
          rolloutId: rollout.rolloutId,
          runId: rollout.execution.runId,
          runAttempt: 1,
          targetSystemIdentifier: rollout.target.systemIdentifier,
          targetRecoveryWitnessSha256: rollout.target.recoveryWitnessSha256,
          transitionSha256: rollout.migrationTransition.transitionSha256,
          expectedPreviousReceiptSha256:
            rollout.receipts.at(-1)?.receiptSha256 ??
            `sha256:${"0".repeat(64)}`,
          sourceLegacyAmbiguity,
          eligibilityCutoff: "2026-08-12T00:00:02.000Z",
          epoch: 1,
          nonce: "a".repeat(32),
        });
      rollout = transitionFromObservation(rollout, observe(step, index));
    });
    expect(rollout.phase).toBe(RolloutPhase.RolloutVerified);
    expect(rollout.receipts[0]?.previousReceiptSha256).toBe(
      `sha256:${"0".repeat(64)}`,
    );
    expect(rollout.receipts[1]?.previousReceiptSha256).toBe(
      rollout.receipts[0]?.receiptSha256,
    );
    expect(rollout.sourcePermanentlyIneligible).toBe(true);
  });

  it("rejects replay, transplant secrets, out-of-order transitions, and retry attempts", () => {
    const first = transitionFromObservation(
      create(),
      observe(RolloutStep.ClaimRollout, 0),
    );
    expect(() =>
      transitionFromObservation(first, observe(RolloutStep.ClaimRollout, 1)),
    ).toThrow("rollout_receipt_replay_forbidden");
    expect(() =>
      transitionFromObservation(
        create(),
        observe(RolloutStep.QuiesceSource, 1),
      ),
    ).toThrow("rollout_transition_stale_or_out_of_order");
    expect(() =>
      transitionFromObservation(create(), {
        ...observe(RolloutStep.ClaimRollout, 0),
        facts: { url: "postgresql://user:password@db.internal/x" },
      }),
    ).toThrow("rollout_observation_contains_secret");
    expect(() =>
      createReleaseRollout({
        ...create(),
        execution: { ...create().execution, runAttempt: 2 },
      }),
    ).toThrow("release_run_retry_forbidden");
  });

  it("permits complete pre-activation compensation but permanently bans PG16 after activation uncertainty", () => {
    const pre = transitionFailure(create(), "definite_pre_activation");
    expect(completeCompensation(beginCompensation(pre)).phase).toBe(
      RolloutPhase.RecoveryCompensated,
    );
    const uncertain = transitionFailure(create(), "activation_uncertain");
    expect(() => beginCompensation(uncertain)).toThrow(
      "source_compensation_forbidden",
    );
    expect(() =>
      assertPromotionAllowed(uncertain, uncertain.source.systemIdentifier),
    ).toThrow("source_generation_permanently_ineligible");
    expect(() =>
      assertPromotionAllowed(uncertain, uncertain.target.systemIdentifier),
    ).not.toThrow();
  });

  it("requires an organization-owned control repository and distinct observed generations", () => {
    expect(() =>
      createReleaseRollout({
        ...create(),
        execution: { ...create().execution, organization: "other" },
      }),
    ).toThrow("release_control_repository_not_organization_owned");
    expect(() =>
      createReleaseRollout({
        ...create(),
        target: { ...create().target, systemIdentifier: "100" },
      }),
    ).toThrow("database_generations_not_distinct");
  });

  it("rejects fictional or incomplete security observations before issuing receipts", () => {
    let rollout = transitionFromObservation(
      create(),
      observe(RolloutStep.ClaimRollout, 0),
    );
    rollout = transitionFromObservation(
      rollout,
      observe(RolloutStep.VerifyProtectedEnvironment, 1),
    );
    expect(() =>
      transitionFromObservation(rollout, {
        step: RolloutStep.FreezeProviderServices,
        observedAt: "2026-08-12T00:00:02.000Z",
        facts: { services: [], complete: true },
      }),
    ).toThrow("source_writer_suspension_observation_invalid");
    expect(() =>
      transitionFromObservation(rollout, {
        ...observe(RolloutStep.FreezeProviderServices, 2),
        provider: {
          renderServiceIds: ["srv-attacker"],
          renderDeployIds: ["dep-writer"],
        },
      }),
    ).toThrow("source_writer_suspension_observation_invalid");
  });
});
