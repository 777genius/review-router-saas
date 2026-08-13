import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type {
  ActivationAuthorization,
  ProviderAuthorityRequest,
  StepObservation,
} from "@reviewrouter/features-release-rollout";
import {
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
  private authorization: ActivationAuthorization | undefined;
  private activationJobId: string | undefined;
  private targetSwitchFenced = false;
  private readonly intents = new Map<string, Record<string, unknown>>();
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
      nonce: "a".repeat(32),
      version: 1,
      fencedAt: "2026-08-12T00:00:00.000Z",
    };
  }
  async authorizeActivation(
    input: Parameters<ReleaseAuthorityLedgerPort["authorizeActivation"]>[0],
  ) {
    if (this.authorization) {
      if (
        this.activationJobId !== input.jobId ||
        this.authorization.previousReceiptSha256 !==
          input.previousReceiptSha256 ||
        this.authorization.expectedCommitSha !== input.expectedCommitSha ||
        this.authorization.postgresMajor !== input.postgresMajor ||
        this.authorization.migrationChecksum !== input.migrationChecksum ||
        JSON.stringify(this.authorization.targetDeployIds) !==
          JSON.stringify(input.targetDeployIds)
      )
        throw new Error("activation_replay_conflict");
      return this.authorization;
    }
    if (this.state !== "before" || input.previousReceiptSha256 !== this.receipt)
      throw new Error("activation_state_conflict");
    this.state = "uncertain";
    this.activationJobId = input.jobId;
    this.authorization = {
      rolloutId: input.rolloutId,
      expectedCommitSha: input.expectedCommitSha,
      postgresMajor: input.postgresMajor,
      migrationChecksum: input.migrationChecksum,
      epoch: 1,
      nonce: "c".repeat(32),
      sourceSystemIdentifier: input.sourceSystemIdentifier,
      targetSystemIdentifier: input.targetSystemIdentifier,
      previousReceiptSha256: input.previousReceiptSha256,
      targetDeployIds: input.targetDeployIds,
      authorizedAt: "2026-08-12T00:00:00.000Z",
    };
    return this.authorization;
  }
  async authorityState() {
    return this.state === "activated"
      ? ("activated" as const)
      : ("activation_authorized" as const);
  }
  async compensationCheckpoint() {
    return {
      activationBoundary: this.state,
      state:
        this.state === "activated"
          ? ("activated" as const)
          : this.state === "uncertain"
            ? ("activation_authorized" as const)
            : ("pre_activation" as const),
      lastReceiptSha256: this.receipt,
      lastStep: null,
      receiptCount: 0,
    };
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
  async decideProviderOperation(input: ProviderAuthorityRequest) {
    return {
      ...input,
      decision: "allow" as const,
      decisionId: "00000000-0000-4000-8000-000000000001",
      decidedAt: "2026-08-12T00:00:00.000Z",
    };
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
  async cleanupWitness(): Promise<never> {
    throw new Error("unused");
  }
  async terminalCleanupFact(rolloutId: string, lifecycle: "role" | "cutover") {
    return {
      jobId: "job-clean",
      lifecycle,
      canary: `rr-cleanup:${rolloutId}:runner`,
      terminalAt: "2026-08-12T00:03:00.000Z",
      observation: {
        step: "cleanup_role_runner",
        observedAt: "2026-08-12T00:02:00.000Z",
        facts: {},
      } as StepObservation,
      witness: {
        providerStatus: "succeeded" as const,
        listenerStopped: true as const,
        workspaceRemoved: true as const,
        credentialProcessGone: true as const,
        canary: `rr-cleanup:${rolloutId}:runner`,
        observedAt: "2026-08-12T00:01:00.000Z",
        providerLogSha256: `sha256:${"4".repeat(64)}`,
        removedPaths: ["/runner/_work/rr-safe/repo"],
        remainingPaths: [] as const,
      },
    };
  }
  async persistRegistration(
    input: Parameters<RunnerOperationsLedgerPort["persistRegistration"]>[0],
  ) {
    this.registration = input;
  }
  async context(rolloutId: string) {
    return {
      rolloutId,
      runId: binding.runId,
      runAttempt: binding.runAttempt,
      state: "forward_repair_required" as const,
      activationBoundary: this.state,
      receiptOrdinal: 0,
      authorization: this.authorization ?? null,
    };
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
});

describe("release rollout ledger internal API", () => {
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

  it("replays one exact activation permit and denies conflicting concurrency", async () => {
    const service = new ReleaseAuthorityService(new ConcurrentRepository());
    await service.claim(binding);
    const results = await Promise.allSettled(
      Array.from({ length: 64 }, (_, index) =>
        service.authorizeActivation({
          ...binding,
          jobId: index === 0 ? "1000" : String(1000 + index),
          previousReceiptSha256: `sha256:${"0".repeat(64)}`,
          targetDeployIds: ["dep-target"],
          postgresMajor: 17,
          migrationChecksum: `sha256:${"7".repeat(64)}`,
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(63);
    const exactReplay = await service.authorizeActivation({
      ...binding,
      jobId: "1000",
      previousReceiptSha256: `sha256:${"0".repeat(64)}`,
      targetDeployIds: ["dep-target"],
      postgresMajor: 17,
      migrationChecksum: `sha256:${"7".repeat(64)}`,
    });
    expect(exactReplay.epoch).toBe(1);
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

  it("returns the witness-gated terminal fact for the exact rollout lifecycle", async () => {
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(app, {
      ...services(new ConcurrentRepository()),
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/runner-jobs/terminal-cleanup-fact?rollout_id=${binding.rolloutId}&lifecycle=role`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jobId: "job-clean",
      lifecycle: "role",
      canary: `rr-cleanup:${binding.rolloutId}:runner`,
      witness: {
        providerStatus: "succeeded",
        canary: `rr-cleanup:${binding.rolloutId}:runner`,
      },
    });
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
