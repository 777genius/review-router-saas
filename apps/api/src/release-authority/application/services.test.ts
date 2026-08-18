import { describe, expect, it, vi } from "vitest";
import {
  canonicalActivationCatalogPolicyDigests,
  createReleaseMigrationTransition,
} from "@reviewrouter/features-release-rollout";
import type {
  ActivationAuthorization,
  ActivationReceipt,
} from "@reviewrouter/features-release-rollout";
import { sha256Canonical } from "@reviewrouter/features-release-rollout";
import {
  ReleaseAuthorityService,
  ProviderAuthorityDecisionService,
  ProviderMutationAuthorityService,
  ReleaseRolloutReconciliationService,
  RunnerOperationsService,
  type ActivationPermitInstallerPort,
  type ReleaseAuthorityHighRiskMutationGate,
  type ReleaseAuthorityLedgerPort,
  type ReleaseProviderMutationAuthorityPort,
  type ReleaseRolloutReconciliationPort,
  type RunnerOperationsLedgerPort,
  type TargetActivationFacts,
  type TargetActivationReceiptReaderPort,
} from "../../release-rollout-ledger.js";
import { sourceLegacyAmbiguityFixture } from "../../../../../test/fixtures/source-legacy-ambiguity";

const targetAttestation = {
  systemIdentifier: "200",
  recoveryWitnessSha256: "e".repeat(64),
};
const migrationEligibilityCutoff = "2026-08-12T00:00:02.000Z";
const sourceLegacyAmbiguity = sourceLegacyAmbiguityFixture({
  rolloutId: "rollout-1",
  sourceSystemIdentifier: "100",
  firstObservedAt: "2026-08-12T00:00:01.000Z",
  eligibilityCutoff: migrationEligibilityCutoff,
});
const explicitTestGate: ReleaseAuthorityHighRiskMutationGate = {
  execute: async (sequence) =>
    sequence(async (_target, mutation) => mutation(targetAttestation)),
};
const migrationPermitInstaller = (
  events?: string[],
): ActivationPermitInstallerPort => ({
  install: vi.fn(async () => "installed" as const),
  installMigrationPermit: vi.fn(async () => {
    events?.push("target-permit-installed");
    return "installed" as const;
  }),
  terminalizeMigrationPermit: vi.fn(async ({ outcome }) => {
    events?.push(`target-permit-${outcome}`);
    return "terminalized" as const;
  }),
});

const authorization: ActivationAuthorization = {
  rolloutId: "rollout-1",
  expectedCommitSha: "c".repeat(40),
  postgresMajor: 17,
  migrationChecksum: `sha256:${"7".repeat(64)}`,
  transitionSha256: `sha256:${"8".repeat(64)}`,
  postManifestIdentity: `sha256:${"7".repeat(64)}`,
  epoch: 3,
  nonce: "a".repeat(32),
  sourceSystemIdentifier: "100",
  targetSystemIdentifier: "200",
  previousReceiptSha256: `sha256:${"b".repeat(64)}`,
  targetDeployIds: ["deploy-1"],
  authorizedAt: "2026-08-12T00:00:00.000Z",
};

const targetReceipt: ActivationReceipt = {
  step: "activate_target_generation",
  receiptId: "receipt-1",
  observedAt: "2026-08-12T00:01:00.000Z",
  rolloutId: authorization.rolloutId,
  expectedCommitSha: authorization.expectedCommitSha,
  runId: "run-1",
  runAttempt: 1,
  sourceSystemIdentifier: authorization.sourceSystemIdentifier,
  targetSystemIdentifier: authorization.targetSystemIdentifier,
  provider: { renderDeployIds: ["deploy-1"] },
  observationSha256: `sha256:${"d".repeat(64)}`,
  previousReceiptSha256: authorization.previousReceiptSha256,
  transitionSha256: authorization.transitionSha256,
  postManifestIdentity: authorization.postManifestIdentity,
  receiptSha256: `sha256:${"e".repeat(64)}`,
  canonicalPrivilegesSha256: `sha256:${"1".repeat(64)}`,
  catalogFactsSha256: `sha256:${"2".repeat(64)}`,
  ...canonicalActivationCatalogPolicyDigests,
  beforePrincipalInventorySha256: `sha256:${"4".repeat(64)}`,
  beforePrincipalPolicySha256: `sha256:${"5".repeat(64)}`,
  activatedPrincipalInventorySha256: `sha256:${"6".repeat(64)}`,
  activatedPrincipalPolicySha256: `sha256:${"7".repeat(64)}`,
  transactionId: "12345",
  firstWriteReceiptSha256: `sha256:${"3".repeat(64)}`,
  firstWriteBoundary: true,
  postgresMajor: authorization.postgresMajor,
  migrationChecksum: authorization.migrationChecksum,
  permitEpoch: authorization.epoch,
  permitNonce: authorization.nonce,
  targetDeployIds: authorization.targetDeployIds,
};

const targetFacts: TargetActivationFacts = {
  rolloutId: targetReceipt.rolloutId,
  expectedCommitSha: targetReceipt.expectedCommitSha,
  sourceSystemIdentifier: targetReceipt.sourceSystemIdentifier,
  targetSystemIdentifier: targetReceipt.targetSystemIdentifier,
  canonicalPrivilegesSha256: targetReceipt.canonicalPrivilegesSha256,
  catalogFactsSha256: targetReceipt.catalogFactsSha256,
  preactivationCatalogPolicySha256:
    targetReceipt.preactivationCatalogPolicySha256,
  activatedCatalogPolicySha256: targetReceipt.activatedCatalogPolicySha256,
  beforePrincipalInventorySha256: targetReceipt.beforePrincipalInventorySha256,
  beforePrincipalPolicySha256: targetReceipt.beforePrincipalPolicySha256,
  activatedPrincipalInventorySha256:
    targetReceipt.activatedPrincipalInventorySha256,
  activatedPrincipalPolicySha256: targetReceipt.activatedPrincipalPolicySha256,
  transactionId: targetReceipt.transactionId,
  firstWriteReceiptSha256: targetReceipt.firstWriteReceiptSha256,
  firstWriteBoundary: targetReceipt.firstWriteBoundary,
  postgresMajor: targetReceipt.postgresMajor,
  migrationChecksum: targetReceipt.migrationChecksum,
  permitEpoch: targetReceipt.permitEpoch,
  permitNonce: targetReceipt.permitNonce,
  targetDeployIds: targetReceipt.targetDeployIds,
  activatedAt: targetReceipt.observedAt,
  activationObservationSha256: targetReceipt.observationSha256,
};

const finalizeInput = {
  authorization,
  provider: { renderDeployIds: ["caller-controlled"] },
  nextReceiptSha256: targetReceipt.receiptSha256,
  activationReceipt: targetReceipt,
};

const service = (proof: TargetActivationFacts | null) => {
  const finalizeActivation = vi.fn().mockResolvedValue(true);
  const repository = {
    finalizeActivation,
  } as unknown as ReleaseAuthorityLedgerPort;
  const reader: TargetActivationReceiptReaderPort = {
    read: vi.fn().mockResolvedValue(proof),
  };
  return {
    finalizeActivation,
    service: new ReleaseAuthorityService(
      repository,
      undefined,
      reader,
      explicitTestGate,
    ),
  };
};

describe("independent target activation receipt verification", () => {
  it("rejects a forged proposed receipt without persisting authority", async () => {
    const fixture = service(targetFacts);
    await expect(
      fixture.service.finalize({
        ...finalizeInput,
        activationReceipt: {
          ...targetReceipt,
          transactionId: "forged",
        },
      }),
    ).rejects.toThrow("target_activation_receipt_mismatch");
    expect(fixture.finalizeActivation).not.toHaveBeenCalled();
  });

  it("rejects swapped proposed principal evidence", async () => {
    const fixture = service(targetFacts);
    await expect(
      fixture.service.finalize({
        ...finalizeInput,
        activationReceipt: {
          ...targetReceipt,
          beforePrincipalInventorySha256:
            targetReceipt.beforePrincipalPolicySha256,
          beforePrincipalPolicySha256:
            targetReceipt.beforePrincipalInventorySha256,
        },
      }),
    ).rejects.toThrow("target_activation_receipt_mismatch");
    expect(fixture.finalizeActivation).not.toHaveBeenCalled();
  });

  it("rejects missing target proof without persisting authority", async () => {
    const fixture = service(null);
    await expect(fixture.service.finalize(finalizeInput)).rejects.toThrow(
      "target_activation_receipt_missing",
    );
    expect(fixture.finalizeActivation).not.toHaveBeenCalled();
  });

  it("persists the full receipt only after independently verifying target facts", async () => {
    const fixture = service(targetFacts);
    await expect(fixture.service.finalize(finalizeInput)).resolves.toBe(true);
    expect(fixture.finalizeActivation).toHaveBeenCalledWith(finalizeInput);
  });

  it("rejects target proof that differs from authorization", async () => {
    const fixture = service({
      ...targetFacts,
      permitNonce: "f".repeat(32),
    });
    await expect(
      fixture.service.finalize({
        ...finalizeInput,
        activationReceipt: {
          ...targetReceipt,
          permitNonce: "f".repeat(32),
        },
      }),
    ).rejects.toThrow("target_activation_receipt_mismatch");
    expect(fixture.finalizeActivation).not.toHaveBeenCalled();
  });

  it.each([
    ["rolloutId", "rollout-other"],
    ["expectedCommitSha", "f".repeat(40)],
    ["sourceSystemIdentifier", "101"],
    ["targetSystemIdentifier", "201"],
    ["activatedAt", "2026-08-12T00:02:00.000Z"],
    ["activationObservationSha256", `sha256:${"8".repeat(64)}`],
    ["canonicalPrivilegesSha256", `sha256:${"8".repeat(64)}`],
    ["catalogFactsSha256", `sha256:${"8".repeat(64)}`],
    ["preactivationCatalogPolicySha256", `sha256:${"8".repeat(64)}`],
    ["activatedCatalogPolicySha256", `sha256:${"8".repeat(64)}`],
    ["beforePrincipalInventorySha256", `sha256:${"8".repeat(64)}`],
    ["beforePrincipalPolicySha256", `sha256:${"8".repeat(64)}`],
    ["activatedPrincipalInventorySha256", `sha256:${"8".repeat(64)}`],
    ["activatedPrincipalPolicySha256", `sha256:${"8".repeat(64)}`],
    ["transactionId", "54321"],
    ["firstWriteReceiptSha256", `sha256:${"8".repeat(64)}`],
  ] satisfies readonly (readonly [keyof TargetActivationFacts, string])[])(
    "rejects an independently observed %s mismatch",
    async (field, value) => {
      const fixture = service({ ...targetFacts, [field]: value });
      await expect(fixture.service.finalize(finalizeInput)).rejects.toThrow(
        "target_activation_receipt_mismatch",
      );
      expect(fixture.finalizeActivation).not.toHaveBeenCalled();
    },
  );

  it("rejects a receipt hash identity that differs from the finalization input", async () => {
    const fixture = service(targetFacts);
    await expect(
      fixture.service.finalize({
        ...finalizeInput,
        nextReceiptSha256: `sha256:${"8".repeat(64)}`,
      }),
    ).rejects.toThrow("target_activation_receipt_mismatch");
    expect(fixture.finalizeActivation).not.toHaveBeenCalled();
  });
});

describe("high-risk activation mutation policy", () => {
  it("rejects a claimant target that differs from the fenced configured generation", async () => {
    const transition = createReleaseMigrationTransition({
      commitSha: "c".repeat(40),
      releaseImageDigest: `sha256:${"d".repeat(64)}`,
    });
    const claim = vi.fn();
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        sequence(async (_target, mutation) => mutation(targetAttestation)),
    };
    const authority = new ReleaseAuthorityService(
      { claim } as unknown as ReleaseAuthorityLedgerPort,
      undefined,
      undefined,
      gate,
      transition,
    );
    const input = {
      rolloutId: "rollout-claim-target",
      expectedCommitSha: transition.commitSha,
      runId: "1",
      runAttempt: 1 as const,
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: "201",
      targetRecoveryWitnessSha256: targetAttestation.recoveryWitnessSha256,
      migrationTransition: transition,
    };

    await expect(authority.claim(input)).rejects.toThrow(
      "release_migration_target_identity_untrusted",
    );
    await expect(
      authority.claim({
        ...input,
        targetSystemIdentifier: targetAttestation.systemIdentifier,
        targetRecoveryWitnessSha256: "f".repeat(64),
      }),
    ).rejects.toThrow("release_migration_target_identity_untrusted");
    expect(claim).not.toHaveBeenCalled();
  });

  it("holds the target fence while checkpointing and durably beginning authority", async () => {
    const transition = createReleaseMigrationTransition({
      commitSha: "c".repeat(40),
      releaseImageDigest: `sha256:${"d".repeat(64)}`,
    });
    const permit = {
      schemaVersion: 1 as const,
      rolloutId: "rollout-1",
      runId: "1",
      runAttempt: 1,
      targetSystemIdentifier: "200",
      targetRecoveryWitnessSha256: "e".repeat(64),
      transitionSha256: transition.transitionSha256,
      expectedPreviousReceiptSha256: `sha256:${"0".repeat(64)}`,
      sourceLegacyAmbiguity,
      eligibilityCutoff: migrationEligibilityCutoff,
      epoch: 1,
      nonce: "f".repeat(32),
    };
    const loadReleaseMigrationCheckpoint = vi.fn().mockResolvedValue({
      targetManifestPhase: "pre_migration",
      permit: null,
      receipt: null,
    });
    const repository = {
      loadReleaseMigrationCheckpoint,
      beginReleaseMigration: vi.fn().mockResolvedValue(permit),
    } as unknown as ReleaseAuthorityLedgerPort;
    const phases: Array<string | undefined> = [];
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        sequence(async (_target, mutation, phase) => {
          phases.push(phase);
          return mutation(targetAttestation);
        }),
    };
    const installer = migrationPermitInstaller();
    const service = new ReleaseAuthorityService(
      repository,
      installer,
      undefined,
      gate,
      transition,
    );
    const input = {
      rolloutId: permit.rolloutId,
      expectedCommitSha: transition.commitSha,
      runId: permit.runId,
      runAttempt: permit.runAttempt,
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: permit.targetSystemIdentifier,
      targetRecoveryWitnessSha256: permit.targetRecoveryWitnessSha256,
      transitionSha256: transition.transitionSha256,
      expectedPreviousReceiptSha256: permit.expectedPreviousReceiptSha256,
      sourceLegacyAmbiguity,
    };

    await service.beginReleaseMigration(input);

    expect(phases).toEqual(["pre_migration", "pre_migration"]);
    expect(repository.loadReleaseMigrationCheckpoint).toHaveBeenCalledWith({
      rolloutId: permit.rolloutId,
      targetSystemIdentifier: targetAttestation.systemIdentifier,
    });
    expect(installer.installMigrationPermit).toHaveBeenCalledWith({
      permit,
      sourceSystemIdentifier: input.sourceSystemIdentifier,
      expectedPostManifestIdentity: transition.postManifestIdentity,
      expectedPostCatalogDigest: transition.postCatalogDigest,
    });
    await expect(
      service.beginReleaseMigration({
        ...input,
        targetSystemIdentifier: "201",
      }),
    ).rejects.toThrow("release_migration_target_identity_untrusted");
    expect(repository.beginReleaseMigration).toHaveBeenCalledOnce();

    loadReleaseMigrationCheckpoint.mockResolvedValue({
      targetManifestPhase: "migrating",
      permit,
      receipt: null,
    });
    phases.length = 0;
    await expect(service.beginReleaseMigration(input)).resolves.toEqual(permit);
    expect(phases).toEqual(["migration_recovery", "migration_recovery"]);
    expect(repository.beginReleaseMigration).toHaveBeenCalledTimes(2);
  });

  it("commits target completion and reads its guard receipt before authority", async () => {
    const events: string[] = [];
    const transition = createReleaseMigrationTransition({
      commitSha: "c".repeat(40),
      releaseImageDigest: `sha256:${"d".repeat(64)}`,
    });
    const permit = {
      schemaVersion: 1 as const,
      rolloutId: "rollout-hostile",
      runId: "1",
      runAttempt: 1,
      targetSystemIdentifier: targetAttestation.systemIdentifier,
      targetRecoveryWitnessSha256: targetAttestation.recoveryWitnessSha256,
      transitionSha256: transition.transitionSha256,
      expectedPreviousReceiptSha256: `sha256:${"0".repeat(64)}`,
      sourceLegacyAmbiguity,
      eligibilityCutoff: migrationEligibilityCutoff,
      epoch: 1,
      nonce: "f".repeat(32),
    };
    const targetMigrationReceipt = {
      schemaVersion: 1 as const,
      rolloutId: permit.rolloutId,
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: permit.targetSystemIdentifier,
      targetDatabaseIdentity: "16385",
      targetDatabaseName: "target",
      targetRecoveryWitnessSha256: permit.targetRecoveryWitnessSha256,
      transitionSha256: permit.transitionSha256,
      previousReceiptSha256: permit.expectedPreviousReceiptSha256,
      permitEpoch: permit.epoch,
      permitNonce: permit.nonce,
      postManifestIdentity: transition.postManifestIdentity,
      postCatalogDigest: transition.postCatalogDigest,
      sourceLegacyAmbiguity,
      eligibilityCutoff: migrationEligibilityCutoff,
      legacyReconciliation: { status: "reconciled" },
      effectFingerprint: `sha256:${"3".repeat(64)}`,
      completedAt: "2026-08-12T00:00:30.000Z",
    };
    const targetMigrationReceiptSha256 = `sha256:${sha256Canonical(
      targetMigrationReceipt,
    )}`;
    const receipt = {
      step: "run_release_migration" as const,
      receiptId: "receipt-hostile",
      observedAt: "2026-08-12T00:01:00.000Z",
      rolloutId: permit.rolloutId,
      expectedCommitSha: transition.commitSha,
      runId: permit.runId,
      runAttempt: 1,
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: targetAttestation.systemIdentifier,
      provider: undefined,
      observationSha256: `sha256:${"1".repeat(64)}`,
      previousReceiptSha256: permit.expectedPreviousReceiptSha256,
      receiptSha256: `sha256:${"2".repeat(64)}`,
      migrationChecksum: transition.postManifestIdentity,
      transitionSha256: transition.transitionSha256,
      migrationArtifactDigest: transition.migrationArtifactDigest,
      migrationBundleSha256: transition.migrationBundleSha256,
      preManifestIdentity: transition.preManifestIdentity,
      postManifestIdentity: transition.postManifestIdentity,
      postCatalogDigest: transition.postCatalogDigest,
      permitEpoch: permit.epoch,
      permitNonce: permit.nonce,
      targetMigrationReceiptSha256,
      targetMigrationEffectFingerprint:
        targetMigrationReceipt.effectFingerprint,
    };
    const repository = {
      completeReleaseMigration: vi.fn(async () => {
        events.push("authority-durable");
        return receipt;
      }),
    } as unknown as ReleaseAuthorityLedgerPort;
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        sequence(async (target, mutation) => {
          events.push(`${target}-fence-open`);
          const result = await mutation(targetAttestation);
          events.push(`${target}-fence-close`);
          return result;
        }),
    };
    const service = new ReleaseAuthorityService(
      repository,
      migrationPermitInstaller(events),
      undefined,
      gate,
      transition,
      {
        readMigrationReceipt: vi.fn(async () => {
          events.push("target-receipt-read");
          return { ...targetMigrationReceipt, targetMigrationReceiptSha256 };
        }),
      },
    );

    await expect(
      service.completeReleaseMigration({ permit, receipt }),
    ).resolves.toEqual(receipt);
    expect(events).toEqual([
      "installer-fence-open",
      "target-permit-completed",
      "installer-fence-close",
      "reader-fence-open",
      "target-receipt-read",
      "reader-fence-close",
      "control-fence-open",
      "authority-durable",
      "control-fence-close",
    ]);
    await expect(
      service.completeReleaseMigration({
        permit,
        receipt: {
          ...receipt,
          targetMigrationReceiptSha256: `sha256:${"9".repeat(64)}`,
        },
      }),
    ).rejects.toThrow("release_migration_target_receipt_conflict");
    expect(repository.completeReleaseMigration).toHaveBeenCalledOnce();
    await expect(
      service.completeReleaseMigration({ permit, receipt }),
    ).resolves.toEqual(receipt);
    expect(repository.completeReleaseMigration).toHaveBeenCalledTimes(2);
  });

  it("commits target quarantine before durable authority quarantine", async () => {
    const events: string[] = [];
    const phases: string[] = [];
    const permit = {
      schemaVersion: 1 as const,
      rolloutId: "rollout-quarantine",
      runId: "1",
      runAttempt: 1,
      targetSystemIdentifier: targetAttestation.systemIdentifier,
      targetRecoveryWitnessSha256: targetAttestation.recoveryWitnessSha256,
      transitionSha256: `sha256:${"a".repeat(64)}`,
      expectedPreviousReceiptSha256: `sha256:${"0".repeat(64)}`,
      sourceLegacyAmbiguity,
      eligibilityCutoff: migrationEligibilityCutoff,
      epoch: 1,
      nonce: "f".repeat(32),
    };
    const repository = {
      failReleaseMigration: vi.fn(async () => {
        events.push("quarantine-durable");
      }),
    } as unknown as ReleaseAuthorityLedgerPort;
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        sequence(async (target, mutation, phase) => {
          phases.push(`${target}:${phase}`);
          events.push(`${target}-fence-open`);
          const result = await mutation(targetAttestation);
          events.push(`${target}-fence-close`);
          return result;
        }),
    };
    const service = new ReleaseAuthorityService(
      repository,
      migrationPermitInstaller(events),
      undefined,
      gate,
    );

    await service.failReleaseMigration({
      permit,
      reasonSha256: `sha256:${"b".repeat(64)}`,
    });

    expect(events).toEqual([
      "installer-fence-open",
      "target-permit-quarantined",
      "installer-fence-close",
      "control-fence-open",
      "quarantine-durable",
      "control-fence-close",
    ]);
    expect(phases).toEqual([
      "installer:migration_recovery",
      "control:control_only",
    ]);
  });

  it("rejects quarantine when fenced target identity differs from the permit", async () => {
    const failReleaseMigration = vi.fn();
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        sequence(async (_target, mutation) =>
          mutation({ ...targetAttestation, systemIdentifier: "999" }),
        ),
    };
    const service = new ReleaseAuthorityService(
      { failReleaseMigration } as unknown as ReleaseAuthorityLedgerPort,
      undefined,
      undefined,
      gate,
    );

    await expect(
      service.failReleaseMigration({
        permit: {
          schemaVersion: 1,
          rolloutId: "rollout-quarantine",
          runId: "1",
          runAttempt: 1,
          targetSystemIdentifier: targetAttestation.systemIdentifier,
          targetRecoveryWitnessSha256: targetAttestation.recoveryWitnessSha256,
          transitionSha256: `sha256:${"a".repeat(64)}`,
          expectedPreviousReceiptSha256: `sha256:${"0".repeat(64)}`,
          sourceLegacyAmbiguity,
          eligibilityCutoff: migrationEligibilityCutoff,
          epoch: 1,
          nonce: "f".repeat(32),
        },
        reasonSha256: `sha256:${"b".repeat(64)}`,
      }),
    ).rejects.toThrow("release_migration_target_identity_untrusted");
    expect(failReleaseMigration).not.toHaveBeenCalled();
  });

  it("does not quarantine authority when the target commit fails", async () => {
    const failReleaseMigration = vi.fn();
    const installer = migrationPermitInstaller();
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        sequence(async (target, mutation) => {
          await mutation(targetAttestation);
          if (target === "installer")
            throw new Error("injected_target_commit_failure");
          return undefined as never;
        }),
    };
    const service = new ReleaseAuthorityService(
      { failReleaseMigration } as unknown as ReleaseAuthorityLedgerPort,
      installer,
      undefined,
      gate,
    );
    await expect(
      service.failReleaseMigration({
        permit: {
          schemaVersion: 1,
          rolloutId: "rollout-target-commit-failure",
          runId: "1",
          runAttempt: 1,
          targetSystemIdentifier: targetAttestation.systemIdentifier,
          targetRecoveryWitnessSha256: targetAttestation.recoveryWitnessSha256,
          transitionSha256: `sha256:${"a".repeat(64)}`,
          expectedPreviousReceiptSha256: `sha256:${"0".repeat(64)}`,
          sourceLegacyAmbiguity,
          eligibilityCutoff: migrationEligibilityCutoff,
          epoch: 1,
          nonce: "f".repeat(32),
        },
        reasonSha256: `sha256:${"b".repeat(64)}`,
      }),
    ).rejects.toThrow("injected_target_commit_failure");
    expect(failReleaseMigration).not.toHaveBeenCalled();
  });

  it("retries idempotently after target commit and authority failure", async () => {
    const permit = {
      schemaVersion: 1 as const,
      rolloutId: "rollout-authority-commit-failure",
      runId: "1",
      runAttempt: 1,
      targetSystemIdentifier: targetAttestation.systemIdentifier,
      targetRecoveryWitnessSha256: targetAttestation.recoveryWitnessSha256,
      transitionSha256: `sha256:${"a".repeat(64)}`,
      expectedPreviousReceiptSha256: `sha256:${"0".repeat(64)}`,
      sourceLegacyAmbiguity,
      eligibilityCutoff: migrationEligibilityCutoff,
      epoch: 1,
      nonce: "f".repeat(32),
    };
    const terminalizeMigrationPermit = vi
      .fn()
      .mockResolvedValueOnce("terminalized")
      .mockResolvedValueOnce("existing");
    const failReleaseMigration = vi
      .fn()
      .mockRejectedValueOnce(new Error("injected_authority_commit_failure"))
      .mockResolvedValueOnce(undefined);
    const service = new ReleaseAuthorityService(
      { failReleaseMigration } as unknown as ReleaseAuthorityLedgerPort,
      {
        ...migrationPermitInstaller(),
        terminalizeMigrationPermit,
      },
      undefined,
      explicitTestGate,
    );
    const input = { permit, reasonSha256: `sha256:${"b".repeat(64)}` };
    await expect(service.failReleaseMigration(input)).rejects.toThrow(
      "injected_authority_commit_failure",
    );
    await expect(service.failReleaseMigration(input)).resolves.toBeUndefined();
    expect(terminalizeMigrationPermit).toHaveBeenCalledTimes(2);
    expect(failReleaseMigration).toHaveBeenCalledTimes(2);
  });

  it("places provider-authority decisions inside the high-risk boundary", async () => {
    const events: string[] = [];
    const repository = {
      decideProviderOperation: vi.fn(async () => {
        events.push("provider-write");
        return { decision: "allowed" };
      }),
    } as unknown as ReleaseAuthorityLedgerPort;
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        sequence(async (target, mutation) => {
          events.push(`${target}-attested`);
          return mutation(targetAttestation);
        }),
    };

    await new ProviderAuthorityDecisionService(repository, gate).decide(
      {} as never,
    );

    expect(events).toEqual(["provider-attested", "provider-write"]);
  });

  it("places every durable provider mutation authority write inside the control boundary", async () => {
    const methods = [
      "recover",
      "issue",
      "consume",
      "validateExecution",
      "complete",
      "reconcile",
    ] as const;
    const events: string[] = [];
    const repository = Object.fromEntries(
      methods.map((method) => [
        method,
        vi.fn(async () => {
          events.push(`${method}-write`);
          return method === "validateExecution" ? true : {};
        }),
      ]),
    ) as unknown as ReleaseProviderMutationAuthorityPort;
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        sequence(async (target, mutation) => {
          events.push(`${target}-attested`);
          return mutation(targetAttestation);
        }),
    };
    const service = new ProviderMutationAuthorityService(repository, gate);

    for (const method of methods) await service[method]({} as never);

    expect(events).toEqual(
      methods.flatMap((method) => ["control-attested", `${method}-write`]),
    );
  });

  it("owns one fresh attestation immediately before each authorization and installation write", async () => {
    const events: string[] = [];
    const repository = {
      authorizeActivation: vi.fn(async () => {
        events.push("authority-write");
        return authorization;
      }),
    } as unknown as ReleaseAuthorityLedgerPort;
    const installer: ActivationPermitInstallerPort = {
      install: vi.fn(async () => {
        events.push("target-write");
        return "installed" as const;
      }),
      installMigrationPermit: vi.fn(async () => "installed" as const),
      terminalizeMigrationPermit: vi.fn(async () => "existing" as const),
    };
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        await sequence(async (target, mutation) => {
          events.push(`${target}-attested`);
          return await mutation(targetAttestation);
        }),
    };

    await new ReleaseAuthorityService(
      repository,
      installer,
      undefined,
      gate,
    ).authorizeAndInstall({} as never);

    expect(events).toEqual([
      "control-attested",
      "authority-write",
      "installer-attested",
      "target-write",
    ]);
  });

  it("freshly attests the target reader immediately before finalization", async () => {
    const events: string[] = [];
    const repository = {
      finalizeActivation: vi.fn(async () => {
        events.push("authority-write");
        return true;
      }),
    } as unknown as ReleaseAuthorityLedgerPort;
    const reader: TargetActivationReceiptReaderPort = {
      read: vi.fn(async () => {
        events.push("target-read");
        return targetFacts;
      }),
    };
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        await sequence(async (target, mutation) => {
          events.push(`${target}-attested`);
          return await mutation(targetAttestation);
        }),
    };

    await new ReleaseAuthorityService(
      repository,
      undefined,
      reader,
      gate,
    ).finalize(finalizeInput);

    expect(events).toEqual([
      "reader-attested",
      "target-read",
      "control-attested",
      "authority-write",
    ]);
  });

  it("attests activation state transitions through the control authority connection", async () => {
    const targets: string[] = [];
    const repository = {
      compareAndSet: vi.fn().mockResolvedValue(true),
      markActivationUncertain: vi.fn().mockResolvedValue(true),
      fenceTargetSwitch: vi.fn().mockResolvedValue({ fenced: true }),
    } as unknown as ReleaseAuthorityLedgerPort;
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        sequence(async (target, mutation) => {
          targets.push(target);
          return mutation(targetAttestation);
        }),
    };
    const authority = new ReleaseAuthorityService(
      repository,
      undefined,
      undefined,
      gate,
    );

    await authority.cas({} as never);
    await authority.markUncertain({} as never);
    await authority.fenceTargetSwitch({} as never);

    expect(targets).toEqual(["control", "control", "control"]);
  });
});

describe("target-aware uncertain activation reconciliation", () => {
  const context = {
    rolloutId: authorization.rolloutId,
    runId: targetReceipt.runId,
    runAttempt: targetReceipt.runAttempt,
    state: "outcome_unknown" as const,
    activationBoundary: "uncertain" as const,
    receiptOrdinal: 13,
    authorization,
  };

  const reconcileWith = async (
    proof: Awaited<ReturnType<TargetActivationReceiptReaderPort["read"]>>,
  ) => {
    const reconcile = vi.fn().mockResolvedValue({ state: "result" });
    const repository = {
      context: vi.fn().mockResolvedValue(context),
      reconcile,
    } as unknown as ReleaseRolloutReconciliationPort;
    const reader = {
      read: vi.fn().mockResolvedValue(proof),
    } satisfies TargetActivationReceiptReaderPort;
    await new ReleaseRolloutReconciliationService(
      repository,
      reader,
      explicitTestGate,
    ).reconcile(authorization.rolloutId);
    return reconcile.mock.calls[0]?.[0];
  };

  it("places the reconciliation write inside the control authority boundary", async () => {
    const targets: string[] = [];
    const repository = {
      context: vi.fn().mockResolvedValue(context),
      reconcile: vi.fn().mockResolvedValue({ state: "result" }),
    } as unknown as ReleaseRolloutReconciliationPort;
    const gate: ReleaseAuthorityHighRiskMutationGate = {
      execute: async (sequence) =>
        sequence(async (target, mutation) => {
          targets.push(target);
          return mutation(targetAttestation);
        }),
    };

    await new ReleaseRolloutReconciliationService(
      repository,
      { read: vi.fn().mockResolvedValue(null) },
      gate,
    ).reconcile(authorization.rolloutId);

    expect(targets).toEqual(["control"]);
  });

  it("reconstructs the exact immutable receipt chain from matching target facts", async () => {
    const input = await reconcileWith(targetFacts);
    const directFacts = {
      rolloutId: targetFacts.rolloutId,
      sourceSystemIdentifier: targetFacts.sourceSystemIdentifier,
      targetSystemIdentifier: targetFacts.targetSystemIdentifier,
      postgresMajor: targetFacts.postgresMajor,
      expectedCommitSha: targetFacts.expectedCommitSha,
      migrationChecksum: targetFacts.migrationChecksum,
      transitionSha256: authorization.transitionSha256,
      postManifestIdentity: authorization.postManifestIdentity,
      targetDeployIds: targetFacts.targetDeployIds,
      permitEpoch: targetFacts.permitEpoch,
      permitNonce: targetFacts.permitNonce,
      canonicalPrivilegesSha256: targetFacts.canonicalPrivilegesSha256,
      catalogFactsSha256: targetFacts.catalogFactsSha256,
      preactivationCatalogPolicySha256:
        targetFacts.preactivationCatalogPolicySha256,
      activatedCatalogPolicySha256: targetFacts.activatedCatalogPolicySha256,
      beforePrincipalInventorySha256:
        targetFacts.beforePrincipalInventorySha256,
      beforePrincipalPolicySha256: targetFacts.beforePrincipalPolicySha256,
      activatedPrincipalInventorySha256:
        targetFacts.activatedPrincipalInventorySha256,
      activatedPrincipalPolicySha256:
        targetFacts.activatedPrincipalPolicySha256,
      firstWriteReceiptSha256: targetFacts.firstWriteReceiptSha256,
      transactionId: targetFacts.transactionId,
      activatedAt: targetFacts.activatedAt,
      firstWriteBoundary: true as const,
      observationSha256: targetFacts.activationObservationSha256,
    };
    const directActivationBase = {
      step: "activate_target_generation" as const,
      receiptId: `${authorization.rolloutId}:activate_target_generation:14`,
      observedAt: targetFacts.activatedAt,
      rolloutId: authorization.rolloutId,
      expectedCommitSha: authorization.expectedCommitSha,
      runId: targetReceipt.runId,
      runAttempt: targetReceipt.runAttempt,
      sourceSystemIdentifier: authorization.sourceSystemIdentifier,
      targetSystemIdentifier: authorization.targetSystemIdentifier,
      provider: undefined,
      observationSha256: `sha256:${sha256Canonical(directFacts)}`,
      previousReceiptSha256: authorization.previousReceiptSha256,
      canonicalPrivilegesSha256: targetFacts.canonicalPrivilegesSha256,
      catalogFactsSha256: targetFacts.catalogFactsSha256,
      preactivationCatalogPolicySha256:
        targetFacts.preactivationCatalogPolicySha256,
      activatedCatalogPolicySha256: targetFacts.activatedCatalogPolicySha256,
      beforePrincipalInventorySha256:
        targetFacts.beforePrincipalInventorySha256,
      beforePrincipalPolicySha256: targetFacts.beforePrincipalPolicySha256,
      activatedPrincipalInventorySha256:
        targetFacts.activatedPrincipalInventorySha256,
      activatedPrincipalPolicySha256:
        targetFacts.activatedPrincipalPolicySha256,
      transactionId: targetFacts.transactionId,
      firstWriteReceiptSha256: targetFacts.firstWriteReceiptSha256,
      firstWriteBoundary: true as const,
      postgresMajor: targetFacts.postgresMajor,
      migrationChecksum: targetFacts.migrationChecksum,
      transitionSha256: authorization.transitionSha256,
      postManifestIdentity: authorization.postManifestIdentity,
      permitEpoch: targetFacts.permitEpoch,
      permitNonce: targetFacts.permitNonce,
      targetDeployIds: targetFacts.targetDeployIds,
    };
    const directReceipt = {
      ...directActivationBase,
      receiptSha256: `sha256:${sha256Canonical(directActivationBase)}`,
    };
    expect(input.targetObservation.kind).toBe("matching_activation_receipt");
    expect(input.targetObservation.authorization).toEqual(authorization);
    expect(input.targetObservation.activationReceipt).toMatchObject({
      rolloutId: authorization.rolloutId,
      runId: targetReceipt.runId,
      runAttempt: targetReceipt.runAttempt,
      receiptId: `${authorization.rolloutId}:activate_target_generation:14`,
      previousReceiptSha256: authorization.previousReceiptSha256,
      permitEpoch: authorization.epoch,
      permitNonce: authorization.nonce,
    });
    expect(input.targetObservation.nextReceiptSha256).toBe(
      input.targetObservation.activationReceipt.receiptSha256,
    );
    expect(input.targetObservation.activationReceipt).toEqual(directReceipt);
    expect(input.targetObservation.nextReceiptSha256).toBe(
      directReceipt.receiptSha256,
    );
  });

  it.each([
    [null, "target_receipt_absent"],
    [
      { receiptAbsent: true, permitAbsent: true },
      "activation_absent_without_revocation",
    ],
    [
      { ...targetFacts, permitNonce: "f".repeat(32) },
      "target_receipt_conflict",
    ],
  ] as const)(
    "keeps source fenced for target evidence %j",
    async (proof, kind) => {
      const input = await reconcileWith(proof);
      expect(input.targetObservation).toEqual({ kind });
    },
  );

  it("keeps source fenced when the independent target read fails", async () => {
    const reconcile = vi.fn().mockResolvedValue({ state: "result" });
    const repository = {
      context: vi.fn().mockResolvedValue(context),
      reconcile,
    } as unknown as ReleaseRolloutReconciliationPort;
    const reader = {
      read: vi.fn().mockRejectedValue(new Error("target unavailable")),
    } satisfies TargetActivationReceiptReaderPort;
    await new ReleaseRolloutReconciliationService(
      repository,
      reader,
      explicitTestGate,
    ).reconcile(authorization.rolloutId);
    expect(reconcile).toHaveBeenCalledWith({
      rolloutId: authorization.rolloutId,
      targetObservation: { kind: "target_read_unavailable" },
    });
  });
});

describe("witness-gated runner terminal ordering", () => {
  const observation = {
    step: "cleanup_role_runner",
    observedAt: "2026-08-12T00:02:00.000Z",
  } as never;

  it("does not invoke terminal CAS when independent witness is unproven", async () => {
    const markTerminal = vi.fn();
    const repository = {
      cleanupWitness: vi
        .fn()
        .mockRejectedValue(
          new Error("release runner independent cleanup witness unproven"),
        ),
      markTerminal,
    } as unknown as RunnerOperationsLedgerPort;
    const service = new RunnerOperationsService(repository);

    await expect(service.markTerminal("job-1", observation)).rejects.toThrow(
      "independent cleanup witness unproven",
    );
    expect(markTerminal).not.toHaveBeenCalled();
  });

  it("checks the exact job witness before invoking terminal CAS", async () => {
    const calls: string[] = [];
    const repository = {
      cleanupWitness: vi.fn(async (jobId: string) => {
        calls.push(`witness:${jobId}`);
        return { canary: "canary" };
      }),
      markTerminal: vi.fn(async (jobId: string) => {
        calls.push(`terminal:${jobId}`);
      }),
    } as unknown as RunnerOperationsLedgerPort;
    const service = new RunnerOperationsService(repository);

    await service.markTerminal("job-1", observation);
    expect(calls).toEqual(["witness:job-1", "terminal:job-1"]);
  });
});
