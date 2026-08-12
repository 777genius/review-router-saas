import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ActivationFence } from "@reviewrouter/features-release-rollout";
import {
  PrismaReleaseRolloutLedgerRepository,
  registerReleaseRolloutLedgerRoutes,
  ReleaseAuthorityService,
  ReleaseRolloutReconciliationService,
  RunnerOperationsService,
  type ReleaseAuthorityLedgerPort,
  type ReleaseRolloutReconciliationPort,
  type RunnerOperationsLedgerPort,
} from "./release-rollout-ledger";

const binding = {
  rolloutId: "rollout-ledger-test",
  expectedCommitSha: "a".repeat(40),
  runId: "123",
  runAttempt: 1,
  sourceSystemIdentifier: "100",
  targetSystemIdentifier: "200",
};

type CombinedLedgerPort = ReleaseAuthorityLedgerPort &
  RunnerOperationsLedgerPort &
  ReleaseRolloutReconciliationPort;

class ConcurrentRepository implements CombinedLedgerPort {
  private claimed: typeof binding | undefined;
  private receipt = `sha256:${"0".repeat(64)}`;
  private state: "before" | "uncertain" | "activated" = "before";
  private fenceValue: ActivationFence | undefined;
  private targetSwitchFenced = false;
  private readonly intents = new Map<string, Record<string, unknown>>();
  providerWitness: Record<string, unknown> | undefined;
  registration:
    | Parameters<RunnerOperationsLedgerPort["persistRegistration"]>[0]
    | undefined;

  async claim(input: typeof binding) {
    if (!this.claimed) {
      this.claimed = { ...input };
      return "claimed" as const;
    }
    if (JSON.stringify(this.claimed) !== JSON.stringify(input))
      throw new Error("claim_conflict");
    return "duplicate" as const;
  }
  async compareAndSet(
    input: Parameters<ReleaseAuthorityLedgerPort["compareAndSet"]>[0],
  ) {
    if (this.state !== "before" || input.expectedReceiptSha256 !== this.receipt)
      return false;
    this.receipt = input.nextReceiptSha256;
    return true;
  }
  async markActivationUncertain() {
    this.state = "uncertain";
    return true;
  }
  async fenceTargetSwitch(
    input: Parameters<ReleaseAuthorityLedgerPort["fenceTargetSwitch"]>[0],
  ) {
    if (this.targetSwitchFenced) return null;
    this.targetSwitchFenced = true;
    return {
      schemaVersion: 1 as const,
      ...binding,
      previousReceiptSha256: input.previousReceiptSha256,
      nonce: input.nonce,
      version: 1,
      fencedAt: input.fencedAt.toISOString(),
    };
  }
  async fenceActivation(
    input: Parameters<ReleaseAuthorityLedgerPort["fenceActivation"]>[0],
  ) {
    if (this.state !== "before" || input.previousReceiptSha256 !== this.receipt)
      return null;
    this.state = "uncertain";
    this.fenceValue = {
      schemaVersion: 1,
      ...binding,
      jobId: input.jobId,
      previousReceiptSha256: input.previousReceiptSha256,
      nonce: input.nonce,
      version: 1,
      claimVersion: 1,
      targetDeployIds: input.targetDeployIds,
      fencedAt: input.fencedAt.toISOString(),
    };
    return this.fenceValue;
  }
  async finalizeActivation() {
    if (this.state !== "uncertain") return false;
    this.state = "activated";
    return true;
  }
  async activationState() {
    return this.state;
  }
  async verifyFinalAuthority() {
    return this.state === "activated";
  }
  async persistIntent(
    input: Parameters<RunnerOperationsLedgerPort["persistIntent"]>[0],
  ) {
    const existing = this.intents.get(input.id);
    if (!existing) {
      this.intents.set(input.id, { ...input });
      return "created" as const;
    }
    if (JSON.stringify(existing) !== JSON.stringify(input))
      throw new Error("intent_conflict");
    return "existing" as const;
  }
  async listIntents() {
    return [] as const;
  }
  async recordIntentOutcome() {}
  async persistJob() {}
  async listOpenJobs() {
    return [] as const;
  }
  async persistIdentity() {}
  async currentRunner(): Promise<never> {
    throw new Error("unused");
  }
  async markTerminal() {}
  async cleanupObservation(): Promise<never> {
    throw new Error("unused");
  }
  async persistProviderWitness(
    _jobId: string,
    witness: Parameters<
      RunnerOperationsLedgerPort["persistProviderWitness"]
    >[1],
  ) {
    this.providerWitness = witness;
  }
  async cleanupWitness(): Promise<never> {
    throw new Error("unused");
  }
  async persistRegistration(
    input: Parameters<RunnerOperationsLedgerPort["persistRegistration"]>[0],
  ) {
    this.registration = input;
  }
  async reconcile() {
    return { state: "activation_uncertain_forward_only" };
  }
}

const token = "ledger-control-secret";
const tokenSha256 = createHash("sha256").update(token).digest("hex");
const services = (repository: CombinedLedgerPort) => ({
  authority: new ReleaseAuthorityService(repository),
  runnerOperations: new RunnerOperationsService(repository),
  reconciliation: new ReleaseRolloutReconciliationService(repository),
  controlTokenSha256: tokenSha256,
  witnessTokenSha256: createHash("sha256").update("witness").digest("hex"),
});

describe("release rollout ledger internal API", () => {
  it("builds final cleanup evidence only from the independent provider witness", async () => {
    const repository = new PrismaReleaseRolloutLedgerRepository({
      releaseRunnerJob: {
        findUniqueOrThrow: () => ({
          cleanupCanary: "rr-cleanup:rollout:runner",
          cleanupObservation: {
            facts: { forgedByCaller: true },
          },
          cleanupProviderWitness: {
            jobId: "job-1",
            canary: "rr-cleanup:rollout:runner",
            providerStatus: "failed",
            containerTerminated: true,
            logSha256: `sha256:${"a".repeat(64)}`,
            removedPaths: ["/runner/_work/rr-rollout-role"],
            remainingPaths: [],
            providerObservedAt: "2026-08-12T00:00:00.000Z",
          },
        }),
      },
    } as never);

    expect(await repository.cleanupWitness("job-1")).toEqual({
      providerStatus: "failed",
      listenerStopped: true,
      workspaceRemoved: true,
      credentialProcessGone: true,
      canary: "rr-cleanup:rollout:runner",
      observedAt: "2026-08-12T00:00:00.000Z",
      providerLogSha256: `sha256:${"a".repeat(64)}`,
      removedPaths: ["/runner/_work/rr-rollout-role"],
      remainingPaths: [],
    });
  });

  it("appends receipts against the durable boundary on both sides of activation", async () => {
    const boundaries: unknown[] = [];
    const receiptBoundaries: unknown[] = [];
    const transaction = {
      releaseRolloutLedger: {
        updateMany: (input: { where: Record<string, unknown> }) => {
          boundaries.push(input.where.activationBoundary);
          return { count: 1 };
        },
      },
      releaseRolloutReceipt: {
        create: (input: { data: Record<string, unknown> }) => {
          receiptBoundaries.push(input.data.activationBoundary);
          return input.data;
        },
      },
    };
    const repository = new PrismaReleaseRolloutLedgerRepository({
      $transaction: (operation: (client: typeof transaction) => unknown) =>
        operation(transaction),
    } as never);

    expect(
      await repository.compareAndSet({
        ...binding,
        step: "freeze_provider_services",
        expectedReceiptSha256: `sha256:${"0".repeat(64)}`,
        nextReceiptSha256: `sha256:${"1".repeat(64)}`,
        authoritativeSystemIdentifier: binding.sourceSystemIdentifier,
        activationBoundary: "before",
      }),
    ).toBe(true);
    expect(
      await repository.compareAndSet({
        ...binding,
        step: "resume_target_services",
        expectedReceiptSha256: `sha256:${"1".repeat(64)}`,
        nextReceiptSha256: `sha256:${"2".repeat(64)}`,
        authoritativeSystemIdentifier: binding.targetSystemIdentifier,
        activationBoundary: "activated",
      }),
    ).toBe(true);
    expect(boundaries).toEqual(["before", "activated"]);
    expect(receiptBoundaries).toEqual(["before", "activated"]);
  });

  it("authenticates internal callers and keeps claim idempotent", async () => {
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(app, {
      ...services(new ConcurrentRepository()),
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/rollouts/claim",
          payload: binding,
        })
      ).statusCode,
    ).toBe(401);
    const first = await app.inject({
      method: "POST",
      url: "/v1/rollouts/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: binding,
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/rollouts/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: binding,
    });
    expect(first.json()).toEqual({ result: "claimed" });
    expect(duplicate.json()).toEqual({ result: "duplicate" });
    await app.close();
  });

  it("allows exactly one activation fence under adversarial concurrency", async () => {
    const service = new ReleaseAuthorityService(new ConcurrentRepository());
    await service.claim(binding);
    const results = await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        service.fence({
          ...binding,
          jobId: String(1000 + index),
          previousReceiptSha256: `sha256:${"0".repeat(64)}`,
          targetDeployIds: ["dep-target"],
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await service.state(binding)).toBe("uncertain");
  });

  it("allows exactly one target-switch lease under adversarial concurrency", async () => {
    const service = new ReleaseAuthorityService(new ConcurrentRepository());
    const results = await Promise.all(
      Array.from({ length: 64 }, () =>
        service.fenceTargetSwitch({
          ...binding,
          previousReceiptSha256: `sha256:${"0".repeat(64)}`,
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("returns existing only for the exact provisioning idempotency identity", async () => {
    const service = new RunnerOperationsService(new ConcurrentRepository());
    const intent = {
      id: `rri-${"b".repeat(64)}`,
      rolloutId: binding.rolloutId,
      serviceId: "srv-runner",
      lifecycle: "role" as const,
      workflowJobId: "456",
      runnerName: "rr-123-role",
      createdAt: "2026-08-12T00:00:00.000Z",
    };
    expect(await service.persistIntent(intent)).toBe("created");
    expect(await service.persistIntent(intent)).toBe("existing");
    await expect(
      service.persistIntent({ ...intent, serviceId: "srv-attacker" }),
    ).rejects.toThrow("intent_conflict");
  });

  it("isolates provider cleanup evidence behind the distinct witness credential", async () => {
    const repository = new ConcurrentRepository();
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(app, {
      ...services(repository),
    });
    const payload = {
      jobId: "job-1",
      canary: "rr-cleanup:rollout:runner",
      providerStatus: "succeeded",
      containerTerminated: true,
      logSha256: `sha256:${"a".repeat(64)}`,
      removedPaths: ["/runner/_work/rr-runner"],
      remainingPaths: [],
      providerLogId: "log-1",
      providerObservedAt: "2026-08-12T00:00:00.000Z",
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/v1/runner-jobs/job-1/provider-witness",
          headers: { authorization: `Bearer ${token}` },
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/v1/runner-jobs/job-1/provider-witness",
          headers: { authorization: "Bearer witness" },
          payload,
        })
      ).statusCode,
    ).toBe(204);
    expect(repository.providerWitness).toEqual(payload);

    const missingStatus = { ...payload } as Record<string, unknown>;
    delete missingStatus.providerStatus;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/v1/runner-jobs/job-2/provider-witness",
          headers: { authorization: "Bearer witness" },
          payload: missingStatus,
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("persists only allowlisted non-secret JIT registration metadata", async () => {
    const repository = new ConcurrentRepository();
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(app, {
      ...services(repository),
    });
    const registration = {
      runnerId: 123,
      runnerGroupId: 456,
      labels: ["self-hosted", "rr-rollout-role"],
      uniqueLabel: "rr-rollout-role",
      workFolder: "_work/rr-rollout-role",
    };
    const payload = {
      rolloutId: "rollout-1",
      lifecycle: "role",
      workflowJobId: "789",
      registration,
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/runner-jobs/registration",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            ...payload,
            registration: {
              ...registration,
              encodedJitConfig: "must-never-cross-the-ledger-boundary",
            },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.registration).toBeUndefined();

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/runner-jobs/registration",
          headers: { authorization: `Bearer ${token}` },
          payload,
        })
      ).statusCode,
    ).toBe(204);
    expect(repository.registration).toEqual(payload);
    expect(JSON.stringify(repository.registration)).not.toContain(
      "encodedJitConfig",
    );
    await app.close();
  });
});
