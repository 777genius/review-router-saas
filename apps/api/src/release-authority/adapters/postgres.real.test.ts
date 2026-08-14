import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@reviewrouter/platform-db";
import {
  RoutineReleaseControlLedgerAdapter,
  RoutineRunnerCleanupWitnessAdapter,
  RoutineProviderMutationAuthorityAdapter,
} from "./postgres";

const controlUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_TEST_URL;
const witnessUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_WITNESS_TEST_URL;
const adminUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_ADMIN_TEST_URL;
const realDescribe =
  controlUrl && witnessUrl && adminUrl ? describe : describe.skip;

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
      runAttempt: 1,
      sourceSystemIdentifier: "191",
      targetSystemIdentifier: "291",
    } as const;

    await expect(ledger.claim(binding)).resolves.toBe("claimed");
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
    await ledger.claim({
      rolloutId,
      expectedCommitSha: "a".repeat(40),
      runId: "902",
      runAttempt: 1,
      sourceSystemIdentifier: "192",
      targetSystemIdentifier: "292",
    });
    await ledger.claim({
      rolloutId: secondRolloutId,
      expectedCommitSha: "c".repeat(40),
      runId: "903",
      runAttempt: 1,
      sourceSystemIdentifier: "193",
      targetSystemIdentifier: "293",
    });
    const base = {
      rolloutId,
      operation: `freeze:srv-${unique.slice(0, 12)}`,
      resource: {
        provider: "render",
        kind: "service",
        id: `srv-authority-${unique.slice(0, 12)}`,
      },
      expected: { fingerprint: `sha256:${"b".repeat(64)}`, version: null },
      leaseSeconds: 60,
    } as const;
    const contenders = [
      { ...base, ownerId: "actor-one" },
      {
        ...base,
        rolloutId: secondRolloutId,
        operation: `resume:srv-${unique.slice(0, 12)}`,
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
    await authority.reconcile({
      result: "ambiguous_forward_repair",
      receipt: nextReceipt,
      observation: null,
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
      operation: `freeze-expiring:srv-${unique.slice(0, 12)}`,
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
      operation: `resume-expired:srv-${unique.slice(0, 12)}`,
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
      operation: `recover:srv-${unique.slice(0, 12)}`,
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
    await authority.reconcile({
      result: "exact_postcondition",
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
        operation: `freeze-unrelated:srv-${unique.slice(0, 12)}`,
        resource: {
          ...base.resource,
          id: `srv-unrelated-${unique.slice(0, 12)}`,
        },
        ownerId: "actor-four",
      }),
    ).resolves.toMatchObject({ epoch: 1 });
  });

  it("uses resource-first locks during concurrent recovery", async () => {
    if (!control || !admin) throw new Error("real_postgres_test_unconfigured");
    const ledger = new RoutineReleaseControlLedgerAdapter(control);
    const authority = new RoutineProviderMutationAuthorityAdapter(control);
    const unique = randomUUID().replaceAll("-", "");
    const request = {
      rolloutId: `r-lock-order-${unique.slice(0, 16)}`,
      operation: `lock-order:srv-${unique.slice(0, 12)}`,
      resource: {
        provider: "render",
        kind: "service",
        id: `srv-lock-order-${unique.slice(0, 12)}`,
      },
      ownerId: "rr-provider-lock-order",
      expected: { fingerprint: `sha256:${"9".repeat(64)}`, version: null },
      leaseSeconds: 60,
    } as const;
    await ledger.claim({
      rolloutId: request.rolloutId,
      expectedCommitSha: "8".repeat(40),
      runId: "904",
      runAttempt: 1,
      sourceSystemIdentifier: "194",
      targetSystemIdentifier: "294",
    });
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
