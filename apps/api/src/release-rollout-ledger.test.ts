import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type {
  ActivationAuthorization,
  ExternalEffectRecord,
  ProviderAuthorityRequest,
  StepObservation,
} from "@reviewrouter/features-release-rollout";
import { assertOneShotMutationPermit } from "@reviewrouter/features-release-rollout";
import { registerReleaseRolloutLedgerRoutes } from "./release-authority/adapters/http";
import {
  ReleaseAuthorityService,
  ReleaseRolloutReconciliationService,
  RunnerOperationsService,
  ProviderMutationAuthorityService,
} from "./release-authority/application/services";
import type {
  ReleaseAuthorityLedgerPort,
  ReleaseRolloutReconciliationPort,
  RunnerOperationsLedgerPort,
} from "./release-authority/domain/model";

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
  async completeSourceFreeze() {
    return "recorded" as const;
  }
  async prepareSourceFreezeMutation() {
    return true;
  }
  async recordSourceFreezeMutation() {
    return "recorded" as const;
  }
  private claimed: typeof binding | undefined;
  private receipt = `sha256:${"0".repeat(64)}`;
  private state: "before" | "uncertain" | "activated" = "before";
  private authorization: ActivationAuthorization | undefined;
  private activationJobId: string | undefined;
  private targetSwitchFenced = false;
  private readonly intents = new Map<string, Record<string, unknown>>();
  effectCalls: string[] = [];
  registration:
    | Parameters<RunnerOperationsLedgerPort["persistRegistration"]>[0]
    | undefined;
  persistedJob:
    | Parameters<RunnerOperationsLedgerPort["persistJob"]>[0]
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
      sourceFreeze: { status: "none" as const, serviceIds: [], services: [] },
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
  async persistProvisioningIntent(
    input: Parameters<
      RunnerOperationsLedgerPort["persistProvisioningIntent"]
    >[0],
  ): Promise<ExternalEffectRecord> {
    this.effectCalls.push("persistProvisioningIntent");
    const existing = this.intents.get(input.id);
    if (!existing) {
      this.intents.set(input.id, { ...input });
    } else if (JSON.stringify(existing) !== JSON.stringify(input))
      throw new Error("intent_conflict");
    return {
      state: "prepared",
      ownerId: input.creationLeaseOwner,
      epoch: 0,
      providerId: null,
      safeForCompensation: false,
    };
  }
  async listIntents() {
    return [] as const;
  }
  async acquireProviderDispatchPermit(
    input: Parameters<
      RunnerOperationsLedgerPort["acquireProviderDispatchPermit"]
    >[0],
  ): Promise<ExternalEffectRecord> {
    this.effectCalls.push("acquireProviderDispatchPermit");
    return {
      state: "dispatching",
      ownerId: input.claimantId,
      epoch: input.expectedEpoch + 1,
      providerId: null,
      safeForCompensation: false,
    };
  }
  async abandonPreparedEffect(
    input: Parameters<RunnerOperationsLedgerPort["abandonPreparedEffect"]>[0],
  ): Promise<ExternalEffectRecord> {
    this.effectCalls.push("abandonPreparedEffect");
    return {
      state: "abandoned",
      ownerId: input.claimantId,
      epoch: input.expectedEpoch,
      providerId: null,
      safeForCompensation: true,
    };
  }
  async reconcileProvisioningEffect(
    input: Parameters<
      RunnerOperationsLedgerPort["reconcileProvisioningEffect"]
    >[0],
  ): Promise<ExternalEffectRecord> {
    this.effectCalls.push("reconcileProvisioningEffect");
    return {
      state: input.jobId ? "bound" : "dispatching",
      ownerId: input.claimantId,
      epoch: input.expectedEpoch,
      providerId: input.jobId ?? null,
      safeForCompensation: false,
    };
  }
  async persistJob(
    input: Parameters<RunnerOperationsLedgerPort["persistJob"]>[0],
  ) {
    this.persistedJob = input;
  }
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
  it("exposes the authenticated one-shot provider mutation authority protocol", async () => {
    let state: "fresh" | "consumed" | "executing" | "completed" = "fresh";
    const expected = { fingerprint: `sha256:${"b".repeat(64)}`, version: null };
    const resource = { provider: "render", kind: "service", id: "srv-one" };
    const permit = {
      rolloutId: binding.rolloutId,
      operation: "freeze:srv-one",
      resource,
      ownerId: "actor-one",
      epoch: 1,
      permitId: "c".repeat(64),
      token: "d".repeat(64),
      expected,
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      singleUse: true as const,
    };
    const receipt = {
      rolloutId: permit.rolloutId,
      operation: permit.operation,
      resource,
      ownerId: permit.ownerId,
      epoch: permit.epoch,
      permitId: permit.permitId,
      receiptId: "e".repeat(64),
      expected,
      consumedAt: "2026-08-14T00:00:01.000Z",
    };
    expect(() => assertOneShotMutationPermit(permit, new Date())).not.toThrow();
    const providerMutationAuthority = new ProviderMutationAuthorityService({
      issue: async () => permit,
      consume: async () => {
        if (state !== "fresh") throw new Error("replay");
        state = "consumed";
        return receipt;
      },
      validateExecution: async () => {
        if (state !== "consumed") return false;
        state = "executing";
        return true;
      },
      complete: async () => {
        if (state !== "executing") throw new Error("not_executing");
        state = "completed";
      },
      reconcile: async () => undefined,
    });
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(app, {
      ...services(new ConcurrentRepository()),
      providerMutationAuthority,
      providerAuthorityTokenSha256: tokenSha256,
    });
    const request = (path: string, payload: object) =>
      app.inject({
        method: "POST",
        url: `/v1/provider-mutations/${path}`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    expect(
      (
        await request("issue", {
          rolloutId: permit.rolloutId,
          operation: permit.operation,
          resource,
          ownerId: permit.ownerId,
          expected,
          leaseSeconds: 60,
        })
      ).statusCode,
    ).toBe(200);
    expect((await request("consume", permit)).json()).toEqual(receipt);
    expect((await request("consume", permit)).statusCode).toBe(500);
    expect((await request("validate-execution", receipt)).json()).toEqual({
      authorized: true,
    });
    expect((await request("validate-execution", receipt)).json()).toEqual({
      authorized: false,
    });
    const observation = {
      resource,
      state: expected,
      observedAt: "2026-08-14T00:00:02.000Z",
    };
    expect(
      (await request("complete", { receipt, observation })).statusCode,
    ).toBe(200);
    expect(state).toBe("completed");
    await app.close();
  });

  it("requires the authority-owned provider creation boundary on runner jobs", async () => {
    const repository = new ConcurrentRepository();
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(app, {
      ...services(repository),
    });
    const payload = {
      rolloutId: binding.rolloutId,
      serviceId: "srv-disposable",
      jobId: "job-role",
      observedAt: "2026-08-12T00:00:01.000Z",
      providerCreationNotBefore: "2026-08-12T00:00:00.000Z",
      cleanupCanary: "rr-cleanup:rollout-ledger-test:rr-role",
      lifecycle: "role",
      provisioningIntentId: `rri-${"a".repeat(64)}`,
    };
    const headers = { authorization: `Bearer ${token}` };

    const stalePayload: Partial<typeof payload> = { ...payload };
    delete stalePayload.providerCreationNotBefore;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/runner-jobs",
          headers,
          payload: stalePayload,
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.persistedJob).toBeUndefined();

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/runner-jobs",
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(204);
    expect(repository.persistedJob).toEqual(payload);
    await app.close();
  });

  it("rejects malformed service-transition completion input with HTTP 400", async () => {
    const completed: unknown[] = [];
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(app, {
      ...services(new ConcurrentRepository()),
      serviceTransition: {
        complete: async (input: unknown) => completed.push(input),
      } as never,
    });
    const request = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/v1/service-transitions/rollout-1/complete",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });

    expect((await request({})).statusCode).toBe(400);
    expect((await request({ outcome: "invalid" })).statusCode).toBe(400);
    expect(
      (await request({ outcome: "source_recovered", extra: true })).statusCode,
    ).toBe(400);
    expect(completed).toEqual([]);

    expect((await request({ outcome: "source_recovered" })).statusCode).toBe(
      204,
    );
    expect(completed).toEqual([
      { rolloutId: "rollout-1", outcome: "source_recovered" },
    ]);
    await app.close();
  });

  it("validates exact recovery-effect requests and rejects secret-bearing observations", async () => {
    const dispatched: string[] = [];
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(app, {
      ...services(new ConcurrentRepository()),
      serviceTransition: {
        intendRecoveryEffect: async () => {
          dispatched.push("intend");
          return {};
        },
        claimRecoveryEffect: async () => {
          dispatched.push("claim");
          return {};
        },
        consumeRecoveryEffectPermit: async () => {
          dispatched.push("consume");
          return {};
        },
        validateRecoveryEffectExecution: async () => {
          dispatched.push("validate-execution");
          return {};
        },
        completeRecoveryEffect: async () => {
          dispatched.push("complete");
          return {};
        },
        reconcileRecoveryEffect: async () => {
          dispatched.push("reconcile");
          return {};
        },
      } as never,
    });
    const headers = { authorization: `Bearer ${token}` };
    const base = {
      rolloutId: "rollout-1",
      effectKey: "restore_database_writes",
      kind: "restore_database_writes",
    };
    const request = (route: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/v1/service-transitions/rollout-1/recovery-effects/${route}`,
        headers,
        payload,
      });
    for (const [route, payload] of [
      ["intend", { ...base, token: "secret" }],
      [
        "claim",
        { ...base, ownerId: "worker-1", leaseSeconds: 60, extra: true },
      ],
      [
        "consume",
        {
          ...base,
          ownerId: "worker-1",
          epoch: 1,
          permitToken: "a".repeat(64),
          password: "secret",
        },
      ],
      [
        "complete",
        {
          ...base,
          ownerId: "worker-1",
          epoch: 1,
          permitToken: "a".repeat(64),
          executionReceipt: "b".repeat(64),
          observation: {
            sourceWritesRestored: true,
            observedAt: "2026-08-13T00:00:00.000Z",
            environmentDelta: { PASSWORD: "secret" },
          },
        },
      ],
      [
        "validate-execution",
        {
          ...base,
          ownerId: "worker-1",
          epoch: 1,
          permitToken: "a".repeat(64),
          executionReceipt: "b".repeat(64),
          token: "secret",
        },
      ],
      [
        "reconcile",
        {
          ...base,
          ownerId: "worker-1",
          epoch: 1,
          permitToken: "a".repeat(64),
          observation: {
            sourceWritesRestored: true,
            observedAt: "2026-08-13T00:00:00.000Z",
            token: "secret",
          },
        },
      ],
      [
        "complete",
        {
          ...base,
          ownerId: "worker-1",
          epoch: 1,
          permitToken: "a".repeat(64),
          executionReceipt: "b".repeat(64),
          observation: {
            sourceWritesRestored: true,
            observedAt: "https://user:password@example.test/token",
          },
        },
      ],
    ] as const)
      expect((await request(route, payload)).statusCode).toBe(400);
    expect(dispatched).toEqual([]);

    expect((await request("intend", base)).statusCode).toBe(200);
    const permit = {
      ...base,
      ownerId: "worker-1",
      epoch: 1,
      permitToken: "a".repeat(64),
    };
    expect(
      (
        await request("validate-execution", {
          ...permit,
          executionReceipt: "b".repeat(64),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request("reconcile", {
          ...permit,
          observation: {
            sourceWritesRestored: true,
            observedAt: "2026-08-13T00:00:00.000Z",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(dispatched).toEqual(["intend", "validate-execution", "reconcile"]);
    await app.close();
  });

  it("validates the exact service-transition begin contract before dispatch", async () => {
    const begun: unknown[] = [];
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(app, {
      ...services(new ConcurrentRepository()),
      serviceTransition: {
        begin: async (input: unknown) => {
          begun.push(input);
          return "created" as const;
        },
      } as never,
    });
    const digest = `sha256:${"1".repeat(64)}`;
    const service = (serviceId: string) => ({
      serviceId,
      ownerId: "owner",
      type: "web_service",
      runtime: "node",
      repository: "https://source.example/owner/repository",
      branch: "main",
      rootDir: "",
      sourceCommitSha: "a".repeat(40),
      buildCommand: "pnpm build",
      startCommand: "pnpm start",
      preDeployCommand: "",
      healthCheckPath: "/health",
      region: "region",
      plan: "plan",
      maxShutdownDelaySeconds: 60,
      autoDeploy: "no",
      databaseEnvKey: "DATABASE_URL",
      databaseRole: "reviewrouter_api",
      sourceEnvSha256: digest,
      sourceEnvKeysSha256: digest,
      serviceContractSha256: digest,
    });
    const serviceIds = ["srv-web", "srv-api", "srv-worker"];
    const payload = {
      rolloutId: "rollout-1",
      manifestSha256: digest,
      targetContractSha256: digest,
      serviceIds,
      sourceManifest: {
        schemaVersion: "reviewrouter.render-source-recovery.v1",
        rolloutId: "rollout-1",
        services: serviceIds.map(service),
        manifestSha256: digest,
      },
      targetContracts: serviceIds.map((serviceId) => ({
        serviceId,
        imageUrl: `registry.example/owner/runtime@${digest}`,
        removeKeys: [],
        environmentSha256: digest,
        serviceContractSha256: digest,
      })),
    };
    const request = (candidate: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/v1/service-transitions",
        headers: { authorization: `Bearer ${token}` },
        payload: candidate,
      });

    for (const invalid of [
      { ...payload, extra: true },
      { ...payload, serviceIds: ["srv-web", "srv-api", "srv-api"] },
      {
        ...payload,
        sourceManifest: { ...payload.sourceManifest, rolloutId: "foreign" },
      },
      {
        ...payload,
        sourceManifest: {
          ...payload.sourceManifest,
          services: [
            { ...payload.sourceManifest.services[0], unexpected: true },
            ...payload.sourceManifest.services.slice(1),
          ],
        },
      },
      {
        ...payload,
        targetContracts: payload.targetContracts.map((item, index) =>
          index === 0 ? { ...item, environmentDelta: {} } : item,
        ),
      },
    ])
      expect((await request(invalid)).statusCode).toBe(400);
    expect(begun).toEqual([]);

    expect((await request(payload)).statusCode).toBe(200);
    expect(begun).toEqual([payload]);
    await app.close();
  });

  it("validates exact step-specific service-transition checkpoints", async () => {
    const appended: unknown[] = [];
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(app, {
      ...services(new ConcurrentRepository()),
      serviceTransition: {
        append: async (input: unknown) => {
          appended.push(input);
          return { ...(input as object), sequence: 1 };
        },
      } as never,
    });
    const digest = `sha256:${"2".repeat(64)}`;
    const base = {
      manifestSha256: digest,
      targetContractSha256: digest,
      serviceId: "srv-api",
    };
    const request = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/v1/service-transitions/rollout-1/checkpoints",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });

    for (const invalid of [
      { ...base, step: "unknown" },
      { ...base, step: "suspended", deployId: "not-allowed" },
      { ...base, step: "target_deployed" },
      { ...base, step: "target_verified", deployId: "dep-1" },
      {
        ...base,
        step: "restore_deploy_intent",
        intentAt: "not-a-timestamp",
      },
      { ...base, step: "source_verified", deployId: "dep-1", extra: true },
    ])
      expect((await request(invalid)).statusCode).toBe(400);
    expect(appended).toEqual([]);

    const valid = {
      ...base,
      step: "target_verified",
      deployId: "dep-1",
      observedContractSha256: digest,
      observedEnvSha256: digest,
    };
    expect((await request(valid)).statusCode).toBe(200);
    expect(appended).toEqual([{ ...valid, rolloutId: "rollout-1" }]);
    await app.close();
  });

  it("returns sanitized transition conflict and unexpected failures", async () => {
    const app = Fastify();
    let failure: Error = Object.assign(
      new Error("release_authority_conflict"),
      {
        statusCode: 409,
      },
    );
    await registerReleaseRolloutLedgerRoutes(app, {
      ...services(new ConcurrentRepository()),
      serviceTransition: {
        append: async () => {
          throw failure;
        },
      } as never,
    });
    const digest = `sha256:${"3".repeat(64)}`;
    const request = () =>
      app.inject({
        method: "POST",
        url: "/v1/service-transitions/rollout-1/checkpoints",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          manifestSha256: digest,
          targetContractSha256: digest,
          serviceId: "srv-api",
          step: "suspended",
        },
      });

    const conflict = await request();
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).not.toContain("database");

    failure = Object.assign(new Error("release_authority_adapter_failure"), {
      statusCode: 500,
      cause: new Error("sensitive database detail"),
    });
    const unexpected = await request();
    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.body).not.toContain("sensitive database detail");
    await app.close();
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

  it("accepts only rollout-bound source freeze mutation observations", async () => {
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(
      app,
      services(new ConcurrentRepository()),
    );
    const payload = {
      ...binding,
      serviceId: "srv-source",
      latestSuccessfulDeployId: "dep-source",
      observedAt: "2026-08-13T00:00:00.000Z",
      declaredServiceIds: ["srv-source", "srv-other"],
    };
    const prepared = await app.inject({
      method: "POST",
      url: `/v1/rollouts/${binding.rolloutId}/source-freeze-preparations`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ...payload, beforeSuspended: false },
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toEqual({ mutationRequired: true });
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/rollouts/${binding.rolloutId}/source-freeze-mutations`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ result: "recorded" });
    const completed = await app.inject({
      method: "POST",
      url: `/v1/rollouts/${binding.rolloutId}/source-freeze-completion`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...binding,
        declaredServiceIds: payload.declaredServiceIds,
        observedAt: payload.observedAt,
      },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual({ result: "recorded" });
    const mismatched = await app.inject({
      method: "POST",
      url: "/v1/rollouts/another/source-freeze-mutations",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(mismatched.statusCode).toBe(400);
    for (const invalid of [
      { ...payload, runId: 123 },
      { ...payload, sourceSystemIdentifier: 100 },
      { ...payload, serviceId: 123 },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/rollouts/${binding.rolloutId}/source-freeze-mutations`,
        headers: { authorization: `Bearer ${token}` },
        payload: invalid,
      });
      expect(response.statusCode).toBe(400);
    }
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

  it("replays preparation only for the exact provisioning identity", async () => {
    const service = new RunnerOperationsService(new ConcurrentRepository());
    const intent = {
      id: `rri-${"b".repeat(64)}`,
      rolloutId: binding.rolloutId,
      serviceId: "srv-runner",
      lifecycle: "role" as const,
      workflowJobId: "456",
      runnerName: "rr-123-role",
      createdAt: "2026-08-12T00:00:00.000Z",
      startCommandSha256: `sha256:${"b".repeat(64)}`,
      creationLeaseOwner: "rrc-00000000-0000-4000-8000-000000000001",
    };
    expect(await service.persistProvisioningIntent(intent)).toMatchObject({
      state: "prepared",
      epoch: 0,
    });
    expect(await service.persistProvisioningIntent(intent)).toMatchObject({
      state: "prepared",
      epoch: 0,
    });
    await expect(
      service.persistProvisioningIntent({
        ...intent,
        serviceId: "srv-attacker",
      }),
    ).rejects.toThrow("intent_conflict");
  });

  it("serves the external-effect HTTP contract and leaves legacy routes absent", async () => {
    const repository = new ConcurrentRepository();
    const app = Fastify();
    await registerReleaseRolloutLedgerRoutes(app, services(repository));
    const intentId = `rri-${"b".repeat(64)}`;
    const claimantId = "rrc-00000000-0000-4000-8000-000000000001";
    const headers = { authorization: `Bearer ${token}` };
    const intent = {
      id: intentId,
      rolloutId: binding.rolloutId,
      serviceId: "srv-runner",
      lifecycle: "role",
      workflowJobId: "456",
      runnerName: "rr-123-role",
      createdAt: "2026-08-12T00:00:00.000Z",
      startCommandSha256: `sha256:${"b".repeat(64)}`,
      creationLeaseOwner: claimantId,
    };

    const prepared = await app.inject({
      method: "POST",
      url: "/v1/runner-jobs/intents",
      headers,
      payload: intent,
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toEqual({
      state: "prepared",
      ownerId: claimantId,
      epoch: 0,
      providerId: null,
      safeForCompensation: false,
    });
    expect(prepared.json()).not.toHaveProperty("result");

    const permitInput = {
      intentId,
      claimantId,
      startCommandSha256: intent.startCommandSha256,
      expectedEpoch: 0,
      leaseSeconds: 120,
    };
    const permit = await app.inject({
      method: "POST",
      url: `/v1/runner-jobs/intents/${intentId}/dispatch-permit`,
      headers,
      payload: permitInput,
    });
    expect(permit.json()).toMatchObject({ state: "dispatching", epoch: 1 });

    const reconciliation = await app.inject({
      method: "POST",
      url: `/v1/runner-jobs/intents/${intentId}/reconciliation`,
      headers,
      payload: {
        intentId,
        claimantId,
        expectedEpoch: 1,
        jobId: "job-1",
        reconciliation: {
          result: "pending",
          safeForCompensation: false,
        },
      },
    });
    expect(reconciliation.json()).toMatchObject({
      state: "bound",
      providerId: "job-1",
    });

    const abandoned = await app.inject({
      method: "POST",
      url: `/v1/runner-jobs/intents/${intentId}/abandon`,
      headers,
      payload: { intentId, claimantId, expectedEpoch: 0 },
    });
    expect(abandoned.json()).toMatchObject({
      state: "abandoned",
      safeForCompensation: true,
    });
    expect(repository.effectCalls).toEqual([
      "persistProvisioningIntent",
      "acquireProviderDispatchPermit",
      "reconcileProvisioningEffect",
      "abandonPreparedEffect",
    ]);

    for (const [method, url] of [
      ["POST", `/v1/runner-jobs/intents/${intentId}/provider-creation-claim`],
      ["PUT", `/v1/runner-jobs/intents/${intentId}/outcome`],
    ] as const)
      expect(
        (await app.inject({ method, url, headers, payload: {} })).statusCode,
      ).toBe(404);

    const callsBeforeInvalid = repository.effectCalls.length;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/runner-jobs/intents/${intentId}/dispatch-permit`,
          headers,
          payload: { ...permitInput, intentId: `rri-${"c".repeat(64)}` },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/runner-jobs/intents/${intentId}/reconciliation`,
          headers,
          payload: {
            intentId,
            claimantId,
            expectedEpoch: 1,
            reconciliation: {
              result: "clean",
              safeForCompensation: false,
            },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/runner-jobs/intents/${intentId}/reconciliation`,
          headers,
          payload: {
            intentId,
            claimantId,
            expectedEpoch: 1,
            jobId: "job-clean",
            reconciliation: {
              result: "clean",
              safeForCompensation: true,
            },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.effectCalls).toHaveLength(callsBeforeInvalid);
    await app.close();
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
