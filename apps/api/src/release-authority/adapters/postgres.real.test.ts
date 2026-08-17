import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@reviewrouter/platform-db";
import {
  createReleaseMigrationTransition,
  sha256Canonical,
} from "@reviewrouter/features-release-rollout";
import {
  RoutineReleaseControlLedgerAdapter,
  RoutineRunnerCleanupWitnessAdapter,
  RoutineProviderMutationAuthorityAdapter,
} from "./postgres";
import { sourceLegacyAmbiguityFixture } from "../../../../../test/fixtures/source-legacy-ambiguity";

const controlUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_TEST_URL;
const witnessUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_WITNESS_TEST_URL;
const adminUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_ADMIN_TEST_URL;
const realDescribe =
  controlUrl && witnessUrl && adminUrl ? describe : describe.skip;

const claimBinding = (input: {
  rolloutId: string;
  expectedCommitSha: string;
  runId: string;
  sourceSystemIdentifier: string;
  targetSystemIdentifier: string;
}) => ({
  ...input,
  runAttempt: 1 as const,
  targetRecoveryWitnessSha256: "f".repeat(64),
  migrationTransition: createReleaseMigrationTransition({
    commitSha: input.expectedCommitSha,
    releaseImageDigest: `sha256:${"e".repeat(64)}`,
  }),
});

const migrationBoundaryReceiptSha256 = (
  rolloutId: string,
  step: string,
  index: number,
): string =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({ fixture: "migration-boundary", rolloutId, step, index }),
    )
    .digest("hex")}`;

const preMigrationSteps = [
  "claim_rollout",
  "verify_protected_environment",
  "freeze_provider_services",
  "provision_role_runner",
  "quiesce_source",
  "capture_source_backup",
  "copy_database_generation",
  "bootstrap_target_roles",
  "verify_data_equivalence",
  "cleanup_role_runner",
  "provision_cutover_runner",
] as const;

const migrationBoundaryReceiptSequence = (rolloutId: string) =>
  preMigrationSteps.map((step, index) =>
    migrationBoundaryReceiptSha256(rolloutId, step, index),
  );

describe("migration boundary receipt fixtures", () => {
  it("binds valid SHA-256 identifiers to rollout identity and ordered step", () => {
    const first = migrationBoundaryReceiptSequence("rollout-one");
    const second = migrationBoundaryReceiptSequence("rollout-two");

    expect(
      [...first, ...second].every((receiptSha256) =>
        /^sha256:[a-f0-9]{64}$/u.test(receiptSha256),
      ),
    ).toBe(true);
    expect(new Set([...first, ...second]).size).toBe(
      first.length + second.length,
    );
  });
});

const numericSystemIdentifiers = (unique: string) => {
  const base = BigInt(`0x${unique.slice(0, 15)}`) * 10n;
  return {
    sourceSystemIdentifier: (base + 1n).toString(),
    targetSystemIdentifier: (base + 2n).toString(),
  };
};

realDescribe("release authority API/Postgres runtime contract", () => {
  const control = controlUrl
    ? createPrismaClient({ databaseUrl: controlUrl })
    : null;
  const witness = witnessUrl
    ? createPrismaClient({ databaseUrl: witnessUrl })
    : null;
  const admin = adminUrl ? createPrismaClient({ databaseUrl: adminUrl }) : null;

  afterAll(async () => {
    await Promise.all(
      [control, witness, admin]
        .filter((client) => client !== null)
        .map((client) => client.$disconnect()),
    );
  });

  it("lists prepared through cleaned intents and executes a compensation checkpoint", async () => {
    if (!control || !witness)
      throw new Error("real_postgres_test_unconfigured");
    const ledger = new RoutineReleaseControlLedgerAdapter(control);
    const witnessLedger = new RoutineRunnerCleanupWitnessAdapter(witness);
    const unique = randomUUID().replaceAll("-", "");
    const rolloutId = `r-api-postgres-${unique.slice(0, 16)}`;
    const intentId = `rri-${unique.repeat(2)}`;
    const ownerId = "rrc-00000000-0000-4000-8000-000000000091";
    const jobId = `job-api-postgres-${unique.slice(0, 16)}`;
    const cleanupCanary = `rr-cleanup:${rolloutId}:rr-api-contract`;
    const now = new Date().toISOString();
    const binding = {
      rolloutId,
      expectedCommitSha: "d".repeat(40),
      runId: "901",
      runAttempt: 1 as const,
      ...numericSystemIdentifiers(unique),
    };

    await expect(ledger.claim(claimBinding(binding))).resolves.toBe("claimed");
    await ledger.persistProvisioningIntent({
      id: intentId,
      rolloutId,
      serviceId: "svc-api-contract",
      lifecycle: "role",
      workflowJobId: "9011",
      runnerName: "rr-api-contract",
      createdAt: now,
      startCommandSha256: `sha256:${"e".repeat(64)}`,
      creationLeaseOwner: ownerId,
    });
    await expect(ledger.listIntents(rolloutId)).resolves.toMatchObject([
      {
        creationLeaseOwner: ownerId,
        creationLeaseExpiresAt: expect.any(String),
        effect: { state: "prepared", ownerId },
      },
    ]);

    await expect(
      ledger.prepareSourceFreezeMutation({
        ...binding,
        serviceId: "srv-source",
        latestSuccessfulDeployId: "dep-source",
        observedAt: now,
        declaredServiceIds: ["srv-source", "srv-other"],
        beforeSuspended: false,
      }),
    ).resolves.toBe(true);
    await expect(
      ledger.recordSourceFreezeMutation({
        ...binding,
        serviceId: "srv-source",
        latestSuccessfulDeployId: "dep-source",
        observedAt: now,
        declaredServiceIds: ["srv-source", "srv-other"],
      }),
    ).resolves.toBe("recorded");

    await ledger.acquireProviderDispatchPermit({
      intentId,
      claimantId: ownerId,
      startCommandSha256: `sha256:${"e".repeat(64)}`,
      expectedEpoch: 0,
      leaseSeconds: 120,
    });
    await expect(ledger.listIntents(rolloutId)).resolves.toMatchObject([
      {
        creationLeaseOwner: ownerId,
        creationLeaseExpiresAt: null,
        effect: { state: "dispatching", ownerId, epoch: 1 },
      },
    ]);

    await ledger.persistJob({
      rolloutId,
      serviceId: "svc-api-contract",
      jobId,
      observedAt: now,
      providerCreationNotBefore: now,
      cleanupCanary,
      lifecycle: "role",
      provisioningIntentId: intentId,
    });
    await ledger.reconcileProvisioningEffect({
      intentId,
      claimantId: ownerId,
      expectedEpoch: 1,
      jobId,
      reconciliation: { result: "pending", safeForCompensation: false },
    });
    await expect(ledger.listIntents(rolloutId)).resolves.toMatchObject([
      {
        creationLeaseOwner: ownerId,
        creationLeaseExpiresAt: null,
        effect: { state: "bound", ownerId, providerId: jobId },
      },
    ]);

    await witnessLedger.persistProviderWitness(jobId, {
      jobId,
      canary: cleanupCanary,
      providerStatus: "succeeded",
      containerTerminated: true,
      logSha256: `sha256:${"f".repeat(64)}`,
      removedPaths: ["/runner/_work/rr-api-contract/repository"],
      remainingPaths: [],
      providerLogId: "log-api-contract",
      providerCreatedAt: now,
      providerObservedAt: now,
    });
    await ledger.markTerminal(jobId, {
      step: "cleanup_role_runner",
      observedAt: now,
      facts: {},
    });
    await expect(ledger.listIntents(rolloutId)).resolves.toMatchObject([
      {
        creationLeaseOwner: ownerId,
        creationLeaseExpiresAt: null,
        effect: {
          state: "cleaned",
          ownerId,
          providerId: jobId,
          safeForCompensation: true,
        },
      },
    ]);

    const nextReceiptSha256 = `sha256:${"4".repeat(64)}`;
    await expect(
      ledger.compareAndSet({
        ...binding,
        step: "begin_compensation",
        expectedReceiptSha256: `sha256:${"0".repeat(64)}`,
        nextReceiptSha256,
        authoritativeSystemIdentifier: binding.sourceSystemIdentifier,
        expectedActivationBoundary: "before",
        nextActivationBoundary: "before",
      }),
    ).resolves.toBe(true);
    await expect(ledger.compensationCheckpoint(binding)).resolves.toEqual({
      activationBoundary: "before",
      state: "compensating",
      lastReceiptSha256: nextReceiptSha256,
      lastStep: "begin_compensation",
      receiptCount: 1,
      sourceFreeze: {
        status: "partial",
        serviceIds: ["srv-source"],
        services: [
          {
            serviceId: "srv-source",
            latestSuccessfulDeployId: "dep-source",
            observedAt: now,
          },
        ],
      },
    });
  });

  it("serializes provider permits by resource across rollouts and replays exact committed outcomes", async () => {
    if (!control || !admin) throw new Error("real_postgres_test_unconfigured");
    const ledger = new RoutineReleaseControlLedgerAdapter(control);
    const authority = new RoutineProviderMutationAuthorityAdapter(control);
    const unique = randomUUID().replaceAll("-", "");
    const rolloutId = `r-provider-mutation-${unique.slice(0, 16)}`;
    const secondRolloutId = `r-provider-second-${unique.slice(0, 16)}`;
    const firstIdentifiers = numericSystemIdentifiers(unique);
    await ledger.claim(
      claimBinding({
        rolloutId,
        expectedCommitSha: "a".repeat(40),
        runId: "902",
        ...firstIdentifiers,
      }),
    );
    const secondIdentifiers = numericSystemIdentifiers(`${unique.slice(1)}0`);
    await ledger.claim(
      claimBinding({
        rolloutId: secondRolloutId,
        expectedCommitSha: "c".repeat(40),
        runId: "903",
        ...secondIdentifiers,
      }),
    );
    for (const [id, identifiers] of [
      [rolloutId, firstIdentifiers],
      [secondRolloutId, secondIdentifiers],
    ] as const)
      await admin.$queryRawUnsafe(
        `SELECT release_authority.release_provider_authority_decide(
          jsonb_build_object('rolloutId',$1::text,'operation','freeze_source',
            'sourceSystemIdentifier',$2::text,'targetSystemIdentifier',$3::text,
            'expectedReceiptSha256','sha256:'||repeat('0',64),
            'activationBoundary','before'))`,
        id,
        identifiers.sourceSystemIdentifier,
        identifiers.targetSystemIdentifier,
      );
    const resourceId = `srv-authority-${unique.slice(0, 12)}`;
    const base = {
      rolloutId,
      operation: `freeze:${resourceId}`,
      resource: {
        provider: "render",
        kind: "service",
        id: resourceId,
      },
      expected: { fingerprint: `sha256:${"b".repeat(64)}`, version: null },
      leaseSeconds: 60,
    } as const;
    const contenders = [
      { ...base, ownerId: "actor-one" },
      {
        ...base,
        rolloutId: secondRolloutId,
        operation: `freeze:${resourceId}`,
        ownerId: "actor-two",
      },
    ] as const;
    const results = await Promise.allSettled([
      authority.issue(contenders[0]),
      authority.issue(contenders[1]),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    const first = results[0];
    const second = results[1];
    if (!first || !second)
      throw new Error("provider_mutation_race_result_missing");
    const winnerRequest =
      first.status === "fulfilled" ? contenders[0] : contenders[1];
    const loserRequest =
      first.status === "fulfilled" ? contenders[1] : contenders[0];
    const permit =
      first.status === "fulfilled"
        ? first.value
        : second.status === "fulfilled"
          ? second.value
          : (() => {
              throw new Error("provider_mutation_race_has_no_winner");
            })();
    const receipt = await authority.consume(permit);
    await expect(authority.consume(permit)).resolves.toEqual(receipt);
    await expect(authority.validateExecution(receipt)).resolves.toBe(true);
    await expect(authority.validateExecution(receipt)).resolves.toBe(false);
    await expect(
      admin.$queryRawUnsafe<
        Array<{
          active_state: string;
          active_permit_id: string;
          mutation_state: string;
          completed_at: Date | null;
        }>
      >(
        `SELECT lease.active_state, lease.active_permit_id,
                mutation.state AS mutation_state, mutation.completed_at
         FROM release_authority.provider_resource_lease lease
         JOIN release_authority.provider_mutation mutation
           ON mutation.provider=lease.provider
          AND mutation.resource_kind=lease.resource_kind
          AND mutation.resource_id=lease.resource_id
         WHERE lease.provider=$1 AND lease.resource_kind=$2
           AND lease.resource_id=$3`,
        receipt.resource.provider,
        receipt.resource.kind,
        receipt.resource.id,
      ),
    ).resolves.toEqual([
      {
        active_state: "executing",
        active_permit_id: receipt.permitId,
        mutation_state: "executing",
        completed_at: null,
      },
    ]);
    const observation = {
      resource: base.resource,
      state: base.expected,
      observedAt: new Date().toISOString(),
    };
    const outcome = await authority.complete({ receipt, observation });
    await expect(authority.complete({ receipt, observation })).resolves.toEqual(
      outcome,
    );

    const next = await authority.issue({
      ...loserRequest,
      ownerId: "actor-three",
    });
    expect(next.epoch).toBeGreaterThan(receipt.epoch);
    const nextReceipt = await authority.consume(next);
    await expect(authority.validateExecution(nextReceipt)).resolves.toBe(true);
    await expect(
      (authority.reconcile as (input: unknown) => Promise<void>)({
        result: "ambiguous_forward_repair",
        receipt: nextReceipt,
        observation: null,
      }),
    ).rejects.toThrow();
    await authority.reconcile({
      result: "ambiguous_forward_repair",
      receipt: nextReceipt,
      observation: { ...observation, resource: nextReceipt.resource },
    });
    await expect(
      authority.issue({
        ...base,
        rolloutId: winnerRequest.rolloutId,
        operation: `other-operation:srv-${unique.slice(0, 12)}`,
        ownerId: "actor-four",
      }),
    ).rejects.toThrow();

    const expiring = await authority.issue({
      ...base,
      operation: `freeze:srv-expiring-${unique.slice(0, 12)}`,
      resource: { ...base.resource, id: `srv-expiring-${unique.slice(0, 12)}` },
      ownerId: "actor-expiring",
    });
    await admin.$executeRawUnsafe(
      `UPDATE release_authority.provider_mutation
       SET expires_at=clock_timestamp()-interval '1 second'
       WHERE rollout_id=$1 AND operation=$2 AND provider=$3
         AND resource_kind=$4 AND resource_id=$5`,
      expiring.rolloutId,
      expiring.operation,
      expiring.resource.provider,
      expiring.resource.kind,
      expiring.resource.id,
    );
    const afterExpiry = await authority.issue({
      ...base,
      rolloutId: secondRolloutId,
      operation: `freeze:srv-expiring-${unique.slice(0, 12)}`,
      resource: expiring.resource,
      ownerId: "actor-after-expiry",
    });
    expect(afterExpiry.epoch).toBeGreaterThan(expiring.epoch);
    await expect(authority.consume(expiring)).rejects.toThrow();
    await expect(
      authority.issue({
        ...base,
        operation: expiring.operation,
        resource: expiring.resource,
        ownerId: "actor-expiring",
      }),
    ).rejects.toThrow();

    const recoverRequest = {
      ...base,
      operation: `freeze:srv-recover-${unique.slice(0, 12)}`,
      resource: { ...base.resource, id: `srv-recover-${unique.slice(0, 12)}` },
      ownerId: "actor-recover-one",
    } as const;
    const recoverPermit = await authority.issue(recoverRequest);
    await expect(authority.recover(recoverRequest)).resolves.toEqual({
      status: "permit",
      permit: recoverPermit,
    });
    await expect(
      authority.recover({ ...recoverRequest, ownerId: "actor-conflict" }),
    ).rejects.toThrow();
    const recoverReceipt = await authority.consume(recoverPermit);
    await expect(authority.recover(recoverRequest)).resolves.toEqual({
      status: "receipt",
      phase: "consumed",
      reconciliationOnly: false,
      receipt: recoverReceipt,
    });
    await admin.$executeRawUnsafe(
      `UPDATE release_authority.provider_mutation
       SET expires_at=clock_timestamp()-interval '1 second'
       WHERE rollout_id=$1 AND operation=$2 AND provider=$3
         AND resource_kind=$4 AND resource_id=$5`,
      recoverPermit.rolloutId,
      recoverPermit.operation,
      recoverPermit.resource.provider,
      recoverPermit.resource.kind,
      recoverPermit.resource.id,
    );
    const takeoverRequest = {
      ...recoverRequest,
      ownerId: "actor-recover-two",
    } as const;
    const takeover = await authority.recover(takeoverRequest);
    expect(takeover.status).toBe("permit");
    if (takeover.status !== "permit")
      throw new Error("provider_mutation_safe_takeover_missing");
    expect(takeover.permit.epoch).toBeGreaterThan(recoverPermit.epoch);
    await expect(authority.validateExecution(recoverReceipt)).rejects.toThrow();
    const takeoverReceipt = await authority.consume(takeover.permit);
    await expect(authority.validateExecution(takeoverReceipt)).resolves.toBe(
      true,
    );
    await expect(authority.recover(takeoverRequest)).resolves.toEqual({
      status: "receipt",
      phase: "executing",
      reconciliationOnly: false,
      receipt: takeoverReceipt,
    });
    await expect(
      authority.recover({ ...takeoverRequest, ownerId: "actor-conflict" }),
    ).rejects.toThrow();
    await admin.$executeRawUnsafe(
      `UPDATE release_authority.provider_mutation
       SET expires_at=clock_timestamp()-interval '1 second'
       WHERE rollout_id=$1 AND operation=$2 AND provider=$3
         AND resource_kind=$4 AND resource_id=$5`,
      takeoverReceipt.rolloutId,
      takeoverReceipt.operation,
      takeoverReceipt.resource.provider,
      takeoverReceipt.resource.kind,
      takeoverReceipt.resource.id,
    );
    await expect(authority.recover(takeoverRequest)).resolves.toEqual({
      status: "receipt",
      phase: "executing",
      reconciliationOnly: true,
      receipt: takeoverReceipt,
    });
    await expect(
      (authority.reconcile as (input: unknown) => Promise<void>)({
        result: "exact_postcondition",
        receipt: takeoverReceipt,
        observation: {
          resource: takeoverReceipt.resource,
          state: base.expected,
          observedAt: new Date().toISOString(),
        },
      }),
    ).rejects.toThrow();
    await authority.complete({
      receipt: takeoverReceipt,
      observation: {
        resource: takeoverReceipt.resource,
        state: base.expected,
        observedAt: new Date().toISOString(),
      },
    });
    await expect(authority.recover(takeoverRequest)).resolves.toMatchObject({
      status: "terminal",
      outcome: {
        result: "exact_postcondition",
        receiptId: takeoverReceipt.receiptId,
      },
    });
    await expect(
      authority.recover({
        ...takeoverRequest,
        // A restarted caller initially observes the already-applied state;
        // the terminal record's durable precondition remains authoritative.
        expected: { fingerprint: `sha256:${"7".repeat(64)}`, version: null },
      }),
    ).resolves.toMatchObject({
      status: "terminal",
      outcome: { result: "exact_postcondition" },
    });
    await expect(
      authority.issue({
        ...base,
        operation: `freeze:srv-unrelated-${unique.slice(0, 12)}`,
        resource: {
          ...base.resource,
          id: `srv-unrelated-${unique.slice(0, 12)}`,
        },
        ownerId: "actor-four",
      }),
    ).resolves.toMatchObject({ epoch: 1 });
  });

  it("returns the stored canonical migration receipt on stable retries and quarantines conflicts", async () => {
    if (!control) throw new Error("real_postgres_test_unconfigured");
    const ledger = new RoutineReleaseControlLedgerAdapter(control);
    const unique = randomUUID().replaceAll("-", "");
    const rolloutId = `r-migration-retry-${unique.slice(0, 16)}`;
    const binding = claimBinding({
      rolloutId,
      expectedCommitSha: "6".repeat(40),
      runId: "905",
      ...numericSystemIdentifiers(unique),
    });
    const sourceLegacyAmbiguity = sourceLegacyAmbiguityFixture({
      rolloutId,
      sourceSystemIdentifier: binding.sourceSystemIdentifier,
      firstObservedAt: "2026-08-14T01:02:00.000Z",
      eligibilityCutoff: "2026-08-14T01:02:01.000Z",
    });
    await ledger.claim(binding);
    const advanceToMigrationBoundary = async (target: typeof binding) => {
      let previousReceiptSha256 = `sha256:${"0".repeat(64)}`;
      const receiptSequence = migrationBoundaryReceiptSequence(
        target.rolloutId,
      );
      for (const [index, step] of preMigrationSteps.entries()) {
        const nextReceiptSha256 = receiptSequence[index];
        if (!nextReceiptSha256)
          throw new Error("migration_boundary_receipt_missing");
        await expect(
          ledger.compareAndSet({
            rolloutId: target.rolloutId,
            expectedCommitSha: target.expectedCommitSha,
            runId: target.runId,
            runAttempt: 1,
            sourceSystemIdentifier: target.sourceSystemIdentifier,
            targetSystemIdentifier: target.targetSystemIdentifier,
            step,
            expectedReceiptSha256: previousReceiptSha256,
            nextReceiptSha256,
            authoritativeSystemIdentifier: target.sourceSystemIdentifier,
            expectedActivationBoundary: "before",
            nextActivationBoundary: "before",
          }),
        ).resolves.toBe(true);
        previousReceiptSha256 = nextReceiptSha256;
      }
      return previousReceiptSha256;
    };
    await expect(
      ledger.beginReleaseMigration({
        rolloutId,
        expectedCommitSha: binding.expectedCommitSha,
        runId: binding.runId,
        runAttempt: 1,
        sourceSystemIdentifier: binding.sourceSystemIdentifier,
        targetSystemIdentifier: binding.targetSystemIdentifier,
        targetRecoveryWitnessSha256: binding.targetRecoveryWitnessSha256,
        transitionSha256: binding.migrationTransition.transitionSha256,
        expectedPreviousReceiptSha256: `sha256:${"0".repeat(64)}`,
        sourceLegacyAmbiguity,
      }),
    ).rejects.toThrow();
    const provisionReceiptSha256 = await advanceToMigrationBoundary(binding);
    const permit = await ledger.beginReleaseMigration({
      rolloutId,
      expectedCommitSha: binding.expectedCommitSha,
      runId: binding.runId,
      runAttempt: 1,
      sourceSystemIdentifier: binding.sourceSystemIdentifier,
      targetSystemIdentifier: binding.targetSystemIdentifier,
      targetRecoveryWitnessSha256: binding.targetRecoveryWitnessSha256,
      transitionSha256: binding.migrationTransition.transitionSha256,
      expectedPreviousReceiptSha256: provisionReceiptSha256,
      sourceLegacyAmbiguity,
    });
    const migrationReceipt = (observedAt: string, receiptId: string) => {
      const unsigned = {
        step: "run_release_migration" as const,
        receiptId,
        observedAt,
        rolloutId,
        expectedCommitSha: binding.expectedCommitSha,
        runId: binding.runId,
        runAttempt: 1 as const,
        sourceSystemIdentifier: binding.sourceSystemIdentifier,
        targetSystemIdentifier: binding.targetSystemIdentifier,
        provider: undefined,
        observationSha256: `sha256:${"1".repeat(64)}`,
        previousReceiptSha256: permit.expectedPreviousReceiptSha256,
        migrationChecksum: binding.migrationTransition.postManifestIdentity,
        transitionSha256: binding.migrationTransition.transitionSha256,
        migrationArtifactDigest:
          binding.migrationTransition.migrationArtifactDigest,
        migrationBundleSha256:
          binding.migrationTransition.migrationBundleSha256,
        preManifestIdentity: binding.migrationTransition.preManifestIdentity,
        postManifestIdentity: binding.migrationTransition.postManifestIdentity,
        postCatalogDigest: binding.migrationTransition.postCatalogDigest,
        permitEpoch: permit.epoch,
        permitNonce: permit.nonce,
        targetMigrationReceiptSha256: `sha256:${"3".repeat(64)}`,
        targetMigrationEffectFingerprint: `sha256:${"4".repeat(64)}`,
      };
      return {
        ...unsigned,
        receiptSha256: `sha256:${sha256Canonical(unsigned)}`,
      };
    };
    const first = migrationReceipt(
      "2026-08-14T01:02:03.004Z",
      `${rolloutId}:migration:first`,
    );
    const invalidTimestampReceipt = migrationReceipt(
      "2026-02-31T01:02:03.004Z",
      `${rolloutId}:migration:invalid-time`,
    );
    await expect(
      control.$queryRawUnsafe(
        "SELECT release_authority.release_migration_complete($1::jsonb)",
        JSON.stringify({ permit, receipt: invalidTimestampReceipt }),
      ),
    ).rejects.toThrow();
    const sourceEvidenceReplayPermit = {
      ...permit,
      sourceLegacyAmbiguity: {
        ...permit.sourceLegacyAmbiguity,
        observations: [
          {
            ...permit.sourceLegacyAmbiguity.observations[0],
            observedAt: "2026-08-14T01:01:59.999Z",
          },
          permit.sourceLegacyAmbiguity.observations[1],
        ] as const,
      },
    };
    await expect(
      ledger.completeReleaseMigration({
        permit: sourceEvidenceReplayPermit,
        receipt: first,
      }),
    ).rejects.toThrow();
    await expect(
      ledger.completeReleaseMigration({
        permit: {
          ...permit,
          eligibilityCutoff: "2026-08-14T01:02:01.001Z",
        },
        receipt: first,
      }),
    ).rejects.toThrow();
    await expect(
      ledger.completeReleaseMigration({ permit, receipt: first }),
    ).resolves.toEqual(first);
    const retry = migrationReceipt(
      "2026-08-14T01:02:04.005Z",
      `${rolloutId}:migration:retry`,
    );
    await expect(
      ledger.completeReleaseMigration({ permit, receipt: retry }),
    ).resolves.toEqual(first);
    await expect(
      ledger.completeReleaseMigration({
        permit: sourceEvidenceReplayPermit,
        receipt: retry,
      }),
    ).rejects.toThrow();
    const conflictingUnsignedReceipt = {
      ...retry,
      observationSha256: `sha256:${"2".repeat(64)}`,
    };
    Reflect.deleteProperty(conflictingUnsignedReceipt, "receiptSha256");
    await expect(
      ledger.completeReleaseMigration({
        permit,
        receipt: {
          ...conflictingUnsignedReceipt,
          receiptSha256: `sha256:${sha256Canonical(conflictingUnsignedReceipt)}`,
        },
      }),
    ).rejects.toThrow();

    const quarantineUnique = randomUUID().replaceAll("-", "");
    const quarantined = claimBinding({
      rolloutId: `r-migration-quarantine-${quarantineUnique.slice(0, 12)}`,
      expectedCommitSha: "7".repeat(40),
      runId: "906",
      ...numericSystemIdentifiers(quarantineUnique),
    });
    await ledger.claim(quarantined);
    const quarantineProvisionReceiptSha256 =
      await advanceToMigrationBoundary(quarantined);
    const quarantinePermit = await ledger.beginReleaseMigration({
      rolloutId: quarantined.rolloutId,
      expectedCommitSha: quarantined.expectedCommitSha,
      runId: quarantined.runId,
      runAttempt: 1,
      sourceSystemIdentifier: quarantined.sourceSystemIdentifier,
      targetSystemIdentifier: quarantined.targetSystemIdentifier,
      targetRecoveryWitnessSha256: quarantined.targetRecoveryWitnessSha256,
      transitionSha256: quarantined.migrationTransition.transitionSha256,
      expectedPreviousReceiptSha256: quarantineProvisionReceiptSha256,
      sourceLegacyAmbiguity: sourceLegacyAmbiguityFixture({
        rolloutId: quarantined.rolloutId,
        sourceSystemIdentifier: quarantined.sourceSystemIdentifier,
        firstObservedAt: "2026-08-14T01:03:00.000Z",
        eligibilityCutoff: "2026-08-14T01:03:01.000Z",
      }),
    });
    await ledger.failReleaseMigration({
      permit: quarantinePermit,
      reasonSha256: `sha256:${"3".repeat(64)}`,
    });
    await expect(
      ledger.loadReleaseMigrationCheckpoint({
        rolloutId: quarantined.rolloutId,
        targetSystemIdentifier: quarantined.targetSystemIdentifier,
      }),
    ).resolves.toMatchObject({ targetManifestPhase: "quarantined" });
  });

  it("rejects empty arrays and forged transition digests in direct SQL", async () => {
    if (!control) throw new Error("real_postgres_test_unconfigured");
    const unique = randomUUID().replaceAll("-", "");
    const base = claimBinding({
      rolloutId: `r-transition-sql-${unique.slice(0, 16)}`,
      expectedCommitSha: "8".repeat(40),
      runId: "907",
      ...numericSystemIdentifiers(unique),
    });
    const directClaim = (
      migrationTransition: typeof base.migrationTransition,
    ) =>
      control.$queryRawUnsafe(
        "SELECT release_authority.release_rollout_claim_transition($1::jsonb)",
        JSON.stringify({ ...base, migrationTransition }),
      );
    for (const migrationTransition of [
      { ...base.migrationTransition, orderedMigrationEntries: [] },
      { ...base.migrationTransition, allowedResumeManifestIdentities: [] },
      {
        ...base.migrationTransition,
        postCatalogDigest: `sha256:${"9".repeat(64)}`,
      },
    ])
      await expect(
        directClaim(migrationTransition as typeof base.migrationTransition),
      ).rejects.toThrow();
  });

  it("uses resource-first locks during concurrent recovery", async () => {
    if (!control || !admin) throw new Error("real_postgres_test_unconfigured");
    const ledger = new RoutineReleaseControlLedgerAdapter(control);
    const authority = new RoutineProviderMutationAuthorityAdapter(control);
    const unique = randomUUID().replaceAll("-", "");
    const lockResourceId = `srv-lock-order-${unique.slice(0, 12)}`;
    const request = {
      rolloutId: `r-lock-order-${unique.slice(0, 16)}`,
      operation: `freeze:${lockResourceId}`,
      resource: {
        provider: "render",
        kind: "service",
        id: lockResourceId,
      },
      ownerId: "rr-provider-lock-order",
      expected: { fingerprint: `sha256:${"9".repeat(64)}`, version: null },
      leaseSeconds: 60,
    } as const;
    await ledger.claim(
      claimBinding({
        rolloutId: request.rolloutId,
        expectedCommitSha: "8".repeat(40),
        runId: "904",
        ...numericSystemIdentifiers(unique),
      }),
    );
    const identifiers = numericSystemIdentifiers(unique);
    await admin.$queryRawUnsafe(
      `SELECT release_authority.release_provider_authority_decide(
        jsonb_build_object('rolloutId',$1::text,'operation','freeze_source',
          'sourceSystemIdentifier',$2::text,'targetSystemIdentifier',$3::text,
          'expectedReceiptSha256','sha256:'||repeat('0',64),
          'activationBoundary','before'))`,
      request.rolloutId,
      identifiers.sourceSystemIdentifier,
      identifiers.targetSystemIdentifier,
    );
    await authority.issue(request);

    // This transaction deliberately holds resource before requesting mutation.
    // A mutation-first recover routine forms an actual deadlock with it.
    const resourceFirst = admin.$transaction(async (transaction) => {
      await transaction.$queryRawUnsafe(
        `SELECT 1 FROM release_authority.provider_resource_lease
         WHERE provider=$1 AND resource_kind=$2 AND resource_id=$3 FOR UPDATE`,
        request.resource.provider,
        request.resource.kind,
        request.resource.id,
      );
      await transaction.$queryRawUnsafe("SELECT pg_sleep(0.2)::text AS slept");
      await transaction.$queryRawUnsafe(
        `SELECT 1 FROM release_authority.provider_mutation
         WHERE rollout_id=$1 AND operation=$2 AND provider=$3
           AND resource_kind=$4 AND resource_id=$5 FOR UPDATE`,
        request.rolloutId,
        request.operation,
        request.resource.provider,
        request.resource.kind,
        request.resource.id,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recovery = authority.recover(request);
    const results = await Promise.race([
      Promise.all([resourceFirst, recovery]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("provider_mutation_lock_order_timeout")),
          5_000,
        ),
      ),
    ]);
    expect(results[1]).toMatchObject({ status: "permit" });
  });
});
