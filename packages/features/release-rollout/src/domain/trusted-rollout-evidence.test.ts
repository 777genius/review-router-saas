import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
import { releaseAuthoritySchemaVersion } from "./release-authority-contract";
import { canonicalActivationCatalogPolicyDigests } from "./activation-catalog-policy-contract";
import { createReleaseMigrationTransition } from "./release-migration-transition";

const digest = `sha256:${"a".repeat(64)}`;
const legacyInventorySha256 = `sha256:${createHash("sha256")
  .update(
    JSON.stringify({
      activeLeaseIds: ["legacy-lease"],
      fetchedSetupIds: ["legacy-setup"],
      pendingIntentIds: [],
      intentStatuses: ["completed", "failed"],
    }),
  )
  .digest("hex")}`;
const base = createReleaseRollout({
  rolloutId: "rollout-evidence",
  expectedCommitSha: "d".repeat(40),
  migrationTransition: createReleaseMigrationTransition({
    commitSha: "d".repeat(40),
    releaseImageDigest: `sha256:${"e".repeat(64)}`,
  }),
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
const legacyAmbiguityUnsigned = {
  schemaVersion: 1 as const,
  rolloutId: base.rolloutId,
  sourceSystemIdentifier: base.source.systemIdentifier,
  sourceDatabaseName: base.source.databaseName,
  sourceRecoveryWitnessSha256: base.source.recoveryWitnessSha256,
  authorityPrincipal: "fence_authority",
  fenceId: `source-fence:${base.rolloutId}`,
  fenceEstablishedAt: "2026-08-12T00:00:01.000Z",
  fencedInventorySha256: digest,
  inventorySha256: legacyInventorySha256,
  activeLeaseIds: ["legacy-lease"],
  fetchedSetupIds: ["legacy-setup"],
  pendingIntentIds: [],
  intentStatuses: ["completed", "failed"],
  observations: [
    {
      observedAt: "2026-08-12T00:00:02.000Z",
      inventorySha256: legacyInventorySha256,
    },
    {
      observedAt: "2026-08-12T00:00:03.000Z",
      inventorySha256: legacyInventorySha256,
    },
  ],
  eligibilityCutoff: "2026-08-12T00:00:03.000Z",
  stable: true as const,
} as const;
const legacyAmbiguity = {
  ...legacyAmbiguityUnsigned,
  receiptSha256: `sha256:${sha256Canonical(legacyAmbiguityUnsigned)}`,
};
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
    step === RolloutStep.RunReleaseMigration
      ? {
          ...common,
          step: RolloutStep.RunReleaseMigration,
          migrationChecksum: base.migrationTransition.postManifestIdentity,
          transitionSha256: base.migrationTransition.transitionSha256,
          migrationArtifactDigest:
            base.migrationTransition.migrationArtifactDigest,
          migrationBundleSha256: base.migrationTransition.migrationBundleSha256,
          preManifestIdentity: base.migrationTransition.preManifestIdentity,
          postManifestIdentity: base.migrationTransition.postManifestIdentity,
          postCatalogDigest: base.migrationTransition.postCatalogDigest,
          permitEpoch: 1,
          permitNonce: "migration-permit",
        }
      : step === RolloutStep.ActivateTargetGeneration
        ? {
            ...common,
            step: RolloutStep.ActivateTargetGeneration,
            canonicalPrivilegesSha256: digest,
            beforePrincipalInventorySha256: digest,
            beforePrincipalPolicySha256: digest,
            activatedPrincipalInventorySha256: digest,
            activatedPrincipalPolicySha256: digest,
            catalogFactsSha256: digest,
            ...canonicalActivationCatalogPolicyDigests,
            transactionId: "42",
            firstWriteReceiptSha256: digest,
            firstWriteBoundary: true as const,
            postgresMajor: 17 as const,
            migrationChecksum: base.migrationTransition.postManifestIdentity,
            transitionSha256: base.migrationTransition.transitionSha256,
            postManifestIdentity: base.migrationTransition.postManifestIdentity,
            permitEpoch: 1,
            permitNonce: "activation-permit",
            targetDeployIds: ["dep-release"],
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
const witnessKeys = generateKeyPairSync("ed25519");
const trustedWitnessPolicy = {
  keyId: "release-witness-test",
  publicKeyPem: witnessKeys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
  maximumAgeMilliseconds: 300_000,
} as const;
const releaseWitness = (
  schemaVersion: number = releaseAuthoritySchemaVersion,
) => {
  const unsigned = {
    schemaVersion: 3 as const,
    rolloutId: base.rolloutId,
    deploymentRevision: base.expectedCommitSha,
    artifactDigest: releaseImageIdentity.imageDigest,
    execution: {
      repository: base.execution.controlRepository,
      workflowPath: base.execution.workflowPath,
      workflowRef: base.execution.workflowRef,
      commitSha: base.expectedCommitSha,
      runId: base.execution.runId,
      runAttempt: base.execution.runAttempt,
    },
    sourceDatabaseIdentity: {
      serverIdentity: base.source.systemIdentifier,
      databaseIdentity: "16384",
      databaseName: base.source.databaseName,
    },
    authorityDatabaseIdentity: {
      serverIdentity: "300",
      databaseIdentity: "16385",
      databaseName: "release_authority",
    },
    targetDatabaseIdentity: {
      serverIdentity: base.target.systemIdentifier,
      databaseIdentity: "16386",
      databaseName: base.target.databaseName,
    },
    releaseAuthority: {
      schemaVersion,
      migrationManifestIdentity: digest,
      catalogFingerprint: digest,
      catalogVerifier: "release-authority-catalog-v1",
    },
    activation: {
      migrationManifestIdentity: base.migrationTransition.postManifestIdentity,
      namespaceFingerprint: digest,
      installerRoutineBodySha256: "a".repeat(64),
      readerRoutineBodySha256: "b".repeat(64),
      ...canonicalActivationCatalogPolicyDigests,
    },
    source: {
      renderResourceId: base.source.renderResourceId,
      databaseName: base.source.databaseName,
      systemIdentifier: base.source.systemIdentifier,
      majorVersion: base.source.majorVersion,
      recoveryWitnessSha256: base.source.recoveryWitnessSha256,
    },
    target: {
      renderResourceId: base.target.renderResourceId,
      databaseName: base.target.databaseName,
      systemIdentifier: base.target.systemIdentifier,
      majorVersion: base.target.majorVersion,
      recoveryWitnessSha256: base.target.recoveryWitnessSha256,
    },
    deployments: [
      {
        serviceId: "srv-api",
        deployId: "dep-release",
        revision: digest,
      },
    ],
    observedAt: "2026-08-12T00:03:30.000Z",
    expiresAt: "2026-08-12T00:08:30.000Z",
  };
  const bindingSha256 = `sha256:${sha256Canonical(unsigned)}`;
  return {
    ...unsigned,
    bindingSha256,
    signature: {
      algorithm: "Ed25519" as const,
      keyId: trustedWitnessPolicy.keyId,
      value: sign(
        null,
        Buffer.from(bindingSha256, "utf8"),
        witnessKeys.privateKey,
      ).toString("base64"),
    },
  };
};
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
        legacyAmbiguity,
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
        inventorySha256: legacyInventorySha256,
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
      releaseWitness: releaseWitness(),
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
    trustedWitnessPolicy,
  );

describe("trusted post-cleanup evidence", () => {
  it("assembles and verifies full schema-14 evidence", () => {
    expect(create().releaseWitness.releaseAuthority.schemaVersion).toBe(
      releaseAuthoritySchemaVersion,
    );
    expect(
      assertTrustedRolloutEvidence(
        create(),
        trustedImagePolicy,
        trustedWitnessPolicy,
      ),
    ).toEqual(create());
  });
  it("rejects evidence signed for stale release-authority schema 11", () => {
    const {
      schemaVersion: _schemaVersion,
      evidenceSha256: _hash,
      ...unsigned
    } = create();
    void _schemaVersion;
    void _hash;
    expect(() =>
      assembleTrustedRolloutEvidence(
        { ...unsigned, releaseWitness: releaseWitness(11) },
        trustedImagePolicy,
        trustedWitnessPolicy,
      ),
    ).toThrow("trusted_rollout_evidence_release_witness_invalid");
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
        trustedWitnessPolicy,
      ),
    ).toThrow("trusted_rollout_evidence_target_image_invalid");
  });
  it("rejects final evidence whose activation receipt substitutes a policy digest", () => {
    const evidence = create();
    expect(() =>
      assertTrustedRolloutEvidence(
        {
          ...evidence,
          activation: {
            ...evidence.activation,
            activatedCatalogPolicySha256: `sha256:${"f".repeat(64)}`,
          },
        },
        trustedImagePolicy,
        trustedWitnessPolicy,
      ),
    ).toThrow("trusted_rollout_evidence_activation_invalid");
  });

  it("rejects a rehashed live-canary digest not observed by its receipt", () => {
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
          liveCanarySha256: `sha256:${"b".repeat(64)}`,
        },
        trustedImagePolicy,
        trustedWitnessPolicy,
      ),
    ).toThrow("trusted_rollout_evidence_live_canary_binding_invalid");
  });

  it("rejects signed witness evidence whose policy binding mismatches final evidence", () => {
    const evidence = create();
    expect(() =>
      assertTrustedRolloutEvidence(
        {
          ...evidence,
          releaseWitness: {
            ...evidence.releaseWitness,
            activation: {
              ...evidence.releaseWitness.activation,
              preactivationCatalogPolicySha256: `sha256:${"f".repeat(64)}`,
            },
          },
        },
        trustedImagePolicy,
        trustedWitnessPolicy,
      ),
    ).toThrow("trusted_rollout_evidence_release_witness_invalid");
  });
  it("rejects legacy schema 4 evidence instead of implicitly upgrading v1 provenance", () => {
    expect(() =>
      assertTrustedRolloutEvidence(
        {
          ...create(),
          schemaVersion: 4,
        } as unknown as TrustedRolloutEvidence,
        trustedImagePolicy,
        trustedWitnessPolicy,
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
    [
      "live canary digest substitution",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        liveCanarySha256: `sha256:${"b".repeat(64)}`,
      }),
    ],
    [
      "cross-database witness replay",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        releaseWitness: {
          ...v.releaseWitness,
          targetDatabaseIdentity: {
            ...v.releaseWitness.targetDatabaseIdentity,
            databaseIdentity: "99999",
          },
        },
      }),
    ],
    [
      "witness deployment revision substitution",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        releaseWitness: {
          ...v.releaseWitness,
          deploymentRevision: "f".repeat(40),
        },
      }),
    ],
    [
      "witness artifact digest substitution",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        releaseWitness: {
          ...v.releaseWitness,
          artifactDigest: `sha256:${"f".repeat(64)}`,
        },
      }),
    ],
    [
      "stale witness observation",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        releaseWitness: {
          ...v.releaseWitness,
          expiresAt: "2026-08-12T00:03:59.000Z",
        },
      }),
    ],
    [
      "partial witness evidence",
      (v: TrustedRolloutEvidence) => {
        const { activation: _activation, ...partial } = v.releaseWitness;
        void _activation;
        return {
          ...v,
          releaseWitness: partial as TrustedRolloutEvidence["releaseWitness"],
        };
      },
    ],
    [
      "unsigned witness substitution",
      (v: TrustedRolloutEvidence) => ({
        ...v,
        releaseWitness: {
          ...v.releaseWitness,
          signature: { ...v.releaseWitness.signature, value: "Zm9yZ2Vk" },
        },
      }),
    ],
  ])("rejects %s", (_name, mutate) =>
    expect(() =>
      assertTrustedRolloutEvidence(
        mutate(create()) as TrustedRolloutEvidence,
        trustedImagePolicy,
        trustedWitnessPolicy,
      ),
    ).toThrow(),
  );
});
