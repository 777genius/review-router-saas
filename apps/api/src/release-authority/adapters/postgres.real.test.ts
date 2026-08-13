import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@reviewrouter/platform-db";
import {
  RoutineReleaseControlLedgerAdapter,
  RoutineRunnerCleanupWitnessAdapter,
} from "./postgres";

const controlUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_TEST_URL;
const witnessUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_WITNESS_TEST_URL;
const realDescribe = controlUrl && witnessUrl ? describe : describe.skip;

realDescribe("release authority API/Postgres runtime contract", () => {
  const control = controlUrl
    ? createPrismaClient({ databaseUrl: controlUrl })
    : null;
  const witness = witnessUrl
    ? createPrismaClient({ databaseUrl: witnessUrl })
    : null;

  afterAll(async () => {
    await Promise.all(
      [control, witness]
        .filter((client) => client !== null)
        .map((client) => client.$disconnect()),
    );
  });

  it("lists prepared through cleaned intents and executes a compensation checkpoint", async () => {
    if (!control || !witness)
      throw new Error("real_postgres_test_unconfigured");
    const ledger = new RoutineReleaseControlLedgerAdapter(control);
    const witnessLedger = new RoutineRunnerCleanupWitnessAdapter(witness);
    const rolloutId = "r-api-postgres-contract";
    const intentId = `rri-${"7".repeat(64)}`;
    const ownerId = "rrc-00000000-0000-4000-8000-000000000091";
    const jobId = "job-api-postgres-contract";
    const cleanupCanary = "rr-cleanup:r-api-postgres-contract:rr-api-contract";
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
});
