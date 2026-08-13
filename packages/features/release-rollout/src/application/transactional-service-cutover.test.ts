import { describe, expect, it, vi } from "vitest";
import {
  environmentSha256,
  environmentKeysSha256,
  TransactionalServiceCutover,
  validateServiceTransitionContracts,
  sourceServiceContractSha256,
  targetServiceContractSha256,
  type ProtectedSourceEnvironment,
  type EnvironmentMutationOutcome,
  type ServiceTransitionLedger,
  type ServiceTransitionCheckpoint,
  type SourceRecoveryManifest,
  type TargetServiceContract,
} from "./transactional-service-cutover";
import { createHash } from "node:crypto";
import type { RecoveryEffectRecord } from "../domain/recovery-effect";

const sha = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const withHash = <T extends Record<string, unknown>>(
  value: T,
  field: "serviceContractSha256" | "manifestSha256",
): T & Record<typeof field, string> =>
  ({ ...value, [field]: sha(value) }) as T & Record<typeof field, string>;

const sourceEnvs = ["web", "api", "worker"].map((role) => ({
  serviceId: `srv-${role}`,
  values: [
    { key: "DATABASE_URL", value: `postgres://source/${role}` },
    {
      key: "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
      value: `never_log_${role}_${"w".repeat(43)}`,
    },
    {
      key: "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256",
      value: fingerprint(`never_log_${role}_${"w".repeat(43)}`),
    },
    ...(["web", "api"].includes(role)
      ? [
          {
            key: "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL",
            value: "postgres://source/effect-authority",
          },
        ]
      : []),
    { key: "UNKNOWN_SECRET", value: `preserve-byte-for-byte-${role}` },
  ],
}));
const services = ["web", "api", "worker"].map((role) => {
  const value = {
    serviceId: `srv-${role}`,
    ownerId: "tea-owner",
    type:
      role === "worker"
        ? ("background_worker" as const)
        : ("web_service" as const),
    runtime: "node" as const,
    repository: "https://github.com/777genius/review-router-saas",
    branch: "main",
    rootDir: "",
    sourceCommitSha: "a".repeat(40),
    buildCommand: "pnpm build",
    startCommand: `pnpm ${role}:start`,
    preDeployCommand: "",
    healthCheckPath: role === "worker" ? null : "/health",
    region: "frankfurt",
    plan: "starter",
    maxShutdownDelaySeconds: role === "worker" ? 120 : 60,
    autoDeploy: "no" as const,
    databaseEnvKey: "DATABASE_URL",
    databaseRole: `reviewrouter_${role}`,
    sourceEnvSha256: environmentSha256(
      sourceEnvs.find((item) => item.serviceId === `srv-${role}`)!.values,
    ),
    sourceEnvKeysSha256: environmentKeysSha256(
      sourceEnvs.find((item) => item.serviceId === `srv-${role}`)!.values,
    ),
  };
  return {
    ...value,
    serviceContractSha256: sourceServiceContractSha256(value),
  };
}) as SourceRecoveryManifest["services"];
const manifestBase = {
  schemaVersion: "reviewrouter.render-source-recovery.v1" as const,
  rolloutId: "rollout-1",
  services,
};
const source = withHash(
  manifestBase,
  "manifestSha256",
) as SourceRecoveryManifest;
const protectedEnvironment: ProtectedSourceEnvironment = {
  ...Object.fromEntries(
    sourceEnvs.map(({ serviceId, values }) => [
      serviceId,
      {
        DATABASE_URL: values.find(({ key }) => key === "DATABASE_URL")!.value,
        REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: values.find(
          ({ key }) => key === "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
        )!.value,
        REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: values.find(
          ({ key }) => key === "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256",
        )!.value,
        ...(["srv-web", "srv-api"].includes(serviceId)
          ? {
              REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL: values.find(
                ({ key }) =>
                  key === "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL",
              )!.value,
            }
          : {}),
      },
    ]),
  ),
};
const target = ["web", "api", "worker"].map((role) => {
  const environmentDelta = {
    DATABASE_URL: `postgres://target/${role}`,
    REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: `target_${role}_${"x".repeat(43)}`,
    REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: fingerprint(
      `target_${role}_${"x".repeat(43)}`,
    ),
    ...(["web", "api"].includes(role)
      ? {
          REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
            "postgres://target/effect-authority",
        }
      : {}),
    REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA: "a".repeat(40),
    REVIEW_ROUTER_RUNTIME_ROLLOUT_ID: "rollout-1",
    REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT: "2026-08-13T00:00:00.000Z",
  };
  const environment = [
    ...Object.entries(environmentDelta).map(([key, value]) => ({ key, value })),
    { key: "UNKNOWN_SECRET", value: `preserve-byte-for-byte-${role}` },
  ];
  const value = {
    serviceId: `srv-${role}`,
    imageUrl: `ghcr.io/777genius/review-router-saas-runtime@sha256:${"b".repeat(64)}`,
    environmentDelta,
    removeKeys: [],
    environmentSha256: environmentSha256(environment),
  };
  return {
    ...value,
    serviceContractSha256: targetServiceContractSha256(value),
  };
}) as TargetServiceContract[];

const harness = (fail?: string, failOrdinal = 1) => {
  const checkpoints: ServiceTransitionCheckpoint[] = [];
  const current = new Map(
    services.map((service) => [
      service.serviceId,
      {
        serviceId: service.serviceId,
        suspended: true,
        serviceContractSha256: service.serviceContractSha256,
        environmentSha256: service.sourceEnvSha256,
        provenance: {
          kind: "git" as const,
          commitSha: service.sourceCommitSha,
        },
      },
    ]),
  );
  const currentEnv = new Map(
    sourceEnvs.map(({ serviceId, values }) => [
      serviceId,
      new Map(values.map(({ key, value }) => [key, value])),
    ]),
  );
  let crashed = false;
  let boundaryOrdinal = 0;
  const crash = (name: string) => {
    if (fail === name) boundaryOrdinal += 1;
    if (!crashed && fail === name && boundaryOrdinal === failOrdinal) {
      crashed = true;
      throw new Error(`crash:${name}`);
    }
  };
  const begin = vi.fn<ServiceTransitionLedger["begin"]>(async (value) => {
    if (checkpoints.length === 0)
      checkpoints.push({
        rolloutId: value.rolloutId,
        manifestSha256: value.manifestSha256,
        targetContractSha256: value.targetContractSha256,
        serviceId: value.serviceIds[0]!,
        sequence: 1,
        step: "recovery_intent",
      });
    return "created";
  });
  const recoveryEffects = new Map<string, RecoveryEffectRecord>();
  const snapshot = (
    input: Partial<RecoveryEffectRecord> &
      Pick<RecoveryEffectRecord, "rolloutId" | "effectKey" | "kind">,
  ): RecoveryEffectRecord => ({
    rolloutId: input.rolloutId,
    effectKey: input.effectKey,
    kind: input.kind,
    serviceId: input.serviceId ?? null,
    state: input.state ?? "intended",
    epoch: input.epoch ?? 0,
    claimOwnerId: input.claimOwnerId ?? null,
    permitToken: input.permitToken ?? null,
    leaseExpiresAt:
      input.state === "claimed"
        ? new Date(Date.now() + 60_000).toISOString()
        : null,
    consumedAt:
      input.state &&
      ["consumed", "executing", "completed", "forward_repair"].includes(
        input.state,
      )
        ? new Date().toISOString()
        : null,
    completedAt:
      input.completedAt ??
      (input.state === "completed" ? new Date().toISOString() : null),
    observation: input.observation ?? null,
  });
  const ledger = {
    begin,
    readContract: vi.fn(async () => ({
      sourceManifest: source,
      targetContracts: target.map(({ environmentDelta, ...item }) => {
        expect(environmentDelta).toBeDefined();
        return item;
      }),
    })),
    append: vi.fn(
      async (value: Omit<ServiceTransitionCheckpoint, "sequence">) => {
        crash(`checkpoint:${value.step}`);
        const result = { ...value, sequence: checkpoints.length + 1 };
        checkpoints.push(result);
        return result;
      },
    ),
    read: vi.fn(async () => checkpoints),
    complete: vi.fn(async () => undefined),
    intendRecoveryEffect: vi.fn(async (input) => {
      const existing = recoveryEffects.get(input.effectKey);
      if (existing) return existing;
      const value = snapshot(input);
      recoveryEffects.set(input.effectKey, value);
      return value;
    }),
    claimRecoveryEffect: vi.fn(async (input) => {
      const existing = recoveryEffects.get(input.effectKey)!;
      const value = snapshot({
        ...existing,
        state: "claimed",
        epoch: existing.epoch + 1,
        claimOwnerId: input.ownerId,
        permitToken: "a".repeat(64),
      });
      recoveryEffects.set(input.effectKey, value);
      return value;
    }),
    consumeRecoveryEffectPermit: vi.fn(async (input) => {
      const existing = recoveryEffects.get(input.effectKey)!;
      const value = snapshot({
        ...existing,
        state: "consumed",
        epoch: input.epoch,
        claimOwnerId: input.ownerId,
        permitToken: input.permitToken,
      });
      recoveryEffects.set(input.effectKey, value);
      return {
        record: value,
        executionAuthorization: {
          receipt: "b".repeat(64),
          rolloutId: input.rolloutId,
          effectKey: input.effectKey,
          kind: input.kind,
          ownerId: input.ownerId,
          epoch: input.epoch,
          permitToken: input.permitToken,
        },
      };
    }),
    validateRecoveryEffectExecution: vi.fn(async (input) => {
      const existing = recoveryEffects.get(input.effectKey)!;
      const value = snapshot({ ...existing, state: "executing" });
      recoveryEffects.set(input.effectKey, value);
      return {
        record: value,
        executionAuthorization: {
          receipt: input.executionReceipt,
          rolloutId: input.rolloutId,
          effectKey: input.effectKey,
          kind: input.kind,
          ownerId: input.ownerId,
          epoch: input.epoch,
          permitToken: input.permitToken,
        },
      };
    }),
    completeRecoveryEffect: vi.fn(async (input) => {
      const existing = recoveryEffects.get(input.effectKey)!;
      const value = snapshot({
        ...existing,
        state: "completed",
        epoch: input.epoch,
        permitToken: input.permitToken,
        observation: input.observation,
      });
      recoveryEffects.set(input.effectKey, value);
      return value;
    }),
    reconcileRecoveryEffect: vi.fn(async (input) => {
      const existing = recoveryEffects.get(input.effectKey)!;
      const value = snapshot({
        ...existing,
        state: "forward_repair",
        completedAt: new Date().toISOString(),
        observation: input.observation,
      });
      recoveryEffects.set(input.effectKey, value);
      return value;
    }),
  } satisfies ServiceTransitionLedger;
  const provider = {
    observe: vi.fn(async (id: string) => current.get(id)!),
    suspend: vi.fn(async (id: string) => {
      crash("suspend");
      current.get(id)!.suspended = true;
    }),
    resume: vi.fn(async (id: string) => {
      crash("resume");
      current.get(id)!.suspended = false;
    }),
    configureTarget: vi.fn(async (contract: TargetServiceContract) => {
      current.get(contract.serviceId)!.serviceContractSha256 =
        contract.serviceContractSha256;
      crash("configureTarget");
    }),
    configureSource: vi.fn(async (contract: (typeof services)[number]) => {
      current.get(contract.serviceId)!.serviceContractSha256 =
        contract.serviceContractSha256;
    }),
    replaceEnvironment: vi.fn(
      async (
        id: string,
        input: {
          set: Record<string, string>;
          remove: readonly string[];
          expectedBeforeSha256?: string;
          expectedAfterSha256: string;
        },
      ): Promise<EnvironmentMutationOutcome> => {
        const env = currentEnv.get(id)!;
        if (
          input.expectedBeforeSha256 &&
          current.get(id)!.environmentSha256 !== input.expectedBeforeSha256
        )
          throw new Error("concurrent");
        input.remove.forEach((key) => env.delete(key));
        Object.entries(input.set).forEach(([key, value]) =>
          env.set(key, value),
        );
        const value = environmentSha256(
          [...env].map(([key, value]) => ({ key, value })),
        );
        current.get(id)!.environmentSha256 = value;
        crash("replaceEnvironment");
        return {
          status: "applied" as const,
          previousEnvironmentSha256: input.expectedBeforeSha256 ?? value,
          environmentSha256: value,
          environmentKeysSha256: environmentKeysSha256(
            [...env].map(([key, value]) => ({ key, value })),
          ),
          replayed: false,
        };
      },
    ),
    deployImage: vi.fn(async (id: string, imageUrl: string) => {
      current.get(id)!.provenance = {
        kind: "image" as const,
        imageUrl,
        deployId: `dep-${id}`,
      } as never;
      crash("deployImage");
      return `dep-${id}`;
    }),
    deployCommit: vi.fn(async (id: string, commitSha: string) => {
      current.get(id)!.provenance = { kind: "git" as const, commitSha };
      return `restore-${id}`;
    }),
    waitForDeploy: vi.fn(async () => crash("waitForDeploy")),
    reconcileCommitDeploy: vi.fn(async () => null),
    quiesceDeploys: vi.fn(async () => undefined),
    captureSourceManifest: vi.fn(async () => source),
    planEnvironmentDelta: vi.fn(async () => ({
      environmentSha256: target[0]!.environmentSha256,
      environmentKeysSha256: "sha256:" + "0".repeat(64),
    })),
  };
  return {
    cutover: new TransactionalServiceCutover(
      ledger,
      provider,
      "test-recovery-owner",
    ),
    ledger,
    provider,
    checkpoints,
    recoveryEffects,
  };
};

describe("transactional same-service cutover", () => {
  it("stages all services by exact immutable target contract", async () => {
    const test = harness();
    await expect(
      test.cutover.stage({ source, protectedEnvironment, target }),
    ).resolves.toEqual(["dep-srv-web", "dep-srv-api", "dep-srv-worker"]);
    expect(test.ledger.complete).toHaveBeenCalledWith({
      rolloutId: source.rolloutId,
      outcome: "target_staged",
    });
  });

  it.each([
    [
      "conflict",
      {
        status: "conflict" as const,
        observedEnvironmentSha256: `sha256:${"d".repeat(64)}`,
      },
    ],
    [
      "ambiguous",
      {
        status: "ambiguous" as const,
        observedEnvironmentSha256: `sha256:${"e".repeat(64)}`,
      },
    ],
  ])(
    "stops application policy on an environment %s",
    async (status, outcome) => {
      const test = harness();
      test.provider.replaceEnvironment.mockResolvedValueOnce(outcome);
      await expect(
        test.cutover.stage({ source, protectedEnvironment, target }),
      ).rejects.toThrow(`service_transition_environment_${status}`);
      expect(test.checkpoints).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ step: "target_env_applied" }),
        ]),
      );
    },
  );

  it.each(
    [1, 2, 3].flatMap((ordinal) =>
      [
        "configureTarget",
        "replaceEnvironment",
        "deployImage",
        "waitForDeploy",
        "checkpoint:target_configured",
        "checkpoint:target_env_applied",
        "checkpoint:target_deployed",
      ].map((boundary) => [boundary, ordinal] as const),
    ),
  )(
    "restores every source service after %s boundary failure on service %i",
    async (boundary, ordinal) => {
      const test = harness(boundary, ordinal);
      await expect(
        test.cutover.stage({ source, protectedEnvironment, target }),
      ).rejects.toThrow();
      expect(test.provider.configureSource).not.toHaveBeenCalled();
      await test.cutover.recover({ source, protectedEnvironment, target });
      expect(test.provider.configureSource).toHaveBeenCalledTimes(3);
    },
  );

  it("reconciles after runner death from durable checkpoints", async () => {
    const test = harness();
    test.checkpoints.push({
      rolloutId: source.rolloutId,
      manifestSha256: source.manifestSha256,
      targetContractSha256: validateServiceTransitionContracts(
        source,
        protectedEnvironment,
        target,
      ),
      serviceId: "srv-web",
      sequence: 1,
      step: "target_config_intent",
    });
    await expect(
      test.cutover.stage({ source, protectedEnvironment, target }),
    ).rejects.toThrow("interrupted_recovery_required");
    expect(test.provider.configureSource).not.toHaveBeenCalled();
    await test.cutover.recover({ source, protectedEnvironment, target });
    expect(test.provider.configureSource).toHaveBeenCalledTimes(3);
  });

  it("recovers when another runner creates the durable intent after preflight", async () => {
    const test = harness();
    test.ledger.begin.mockImplementationOnce(async (value) => {
      test.checkpoints.push({
        rolloutId: value.rolloutId,
        manifestSha256: value.manifestSha256,
        targetContractSha256: value.targetContractSha256,
        serviceId: value.serviceIds[0]!,
        sequence: 1,
        step: "recovery_intent",
      });
      return "existing";
    });
    await expect(
      test.cutover.stage({ source, protectedEnvironment, target }),
    ).rejects.toThrow("concurrent_or_interrupted");
    expect(test.provider.configureSource).not.toHaveBeenCalled();
    await test.cutover.recover({ source, protectedEnvironment, target });
    expect(test.provider.configureSource).toHaveBeenCalledTimes(3);
  });

  it("rejects wrong manifest, env hash, scope, and foreign checkpoint", async () => {
    expect(() =>
      validateServiceTransitionContracts(
        { ...source, manifestSha256: `sha256:${"0".repeat(64)}` },
        protectedEnvironment,
        target,
      ),
    ).toThrow("manifest_invalid");
    expect(() =>
      validateServiceTransitionContracts(
        source,
        Object.fromEntries(Object.entries(protectedEnvironment).slice(0, 2)),
        target,
      ),
    ).toThrow();
    const test = harness();
    test.checkpoints.push({
      rolloutId: source.rolloutId,
      manifestSha256: `sha256:${"f".repeat(64)}`,
      targetContractSha256: `sha256:${"e".repeat(64)}`,
      serviceId: "srv-web",
      sequence: 1,
      step: "recovery_intent",
    });
    await expect(
      test.cutover.stage({ source, protectedEnvironment, target }),
    ).rejects.toThrow("foreign_checkpoint");
  });

  it("never serializes protected env values in checkpoints", async () => {
    const test = harness();
    await test.cutover.stage({ source, protectedEnvironment, target });
    expect(JSON.stringify(test.checkpoints)).not.toContain("never-log");
    expect(JSON.stringify(test.checkpoints)).not.toContain("postgres://");
  });

  it("fails closed when recovery sees neither exact source nor exact target env", async () => {
    const test = harness();
    test.checkpoints.push({
      rolloutId: source.rolloutId,
      manifestSha256: source.manifestSha256,
      targetContractSha256: validateServiceTransitionContracts(
        source,
        protectedEnvironment,
        target,
      ),
      serviceId: "srv-web",
      sequence: 1,
      step: "recovery_intent",
    });
    test.provider.observe.mockResolvedValueOnce({
      serviceId: "srv-worker",
      suspended: true,
      serviceContractSha256: services[2]!.serviceContractSha256,
      environmentSha256: `sha256:${"d".repeat(64)}`,
      provenance: { kind: "git", commitSha: "a".repeat(40) },
    });
    await expect(
      test.cutover.recover({ source, protectedEnvironment, target }),
    ).rejects.toThrow("environment_ambiguous");
  });

  it("persists and rejects a wrong well-formed provider environment hash without checkpointing", async () => {
    const test = harness();
    await test.cutover.stage({ source, protectedEnvironment, target });
    const wrongHash = `sha256:${"d".repeat(64)}`;
    test.provider.replaceEnvironment.mockResolvedValueOnce({
      status: "applied",
      previousEnvironmentSha256: target[2]!.environmentSha256,
      environmentSha256: wrongHash,
      environmentKeysSha256: source.services[2]!.sourceEnvKeysSha256,
      replayed: false,
    });

    await expect(
      test.cutover.recover({ source, protectedEnvironment, target }),
    ).rejects.toThrow("service_transition_source_env_restore_failed");

    const failedEffect = [...test.recoveryEffects.values()].find(
      (record) =>
        (record.observation as { environmentSha256?: unknown } | null)
          ?.environmentSha256 === wrongHash,
    );
    expect(failedEffect).toMatchObject({
      state: "completed",
      observation: {
        environmentSha256: wrongHash,
      },
    });
    const failedServiceId = failedEffect?.serviceId;
    expect(failedServiceId).toBeTruthy();
    expect(test.checkpoints).not.toContainEqual(
      expect.objectContaining({
        serviceId: failedServiceId,
        step: "source_env_restored",
      }),
    );
  });

  it.each([
    ["partial", ["srv-web", "srv-worker"]],
    ["complete", ["srv-web", "srv-api", "srv-worker"]],
  ] as const)(
    "resumes only the %s durable freeze mutation set",
    async (_status, durableServiceIds) => {
      const test = harness();
      await test.cutover.stage({ source, protectedEnvironment, target });
      await test.cutover.recover({ source, protectedEnvironment, target });

      const witness = await test.cutover.finalizeAuthorizedSourceRecovery({
        source,
        protectedEnvironment,
        target,
        sourceWriterServiceIds: [...durableServiceIds],
        restoreSourceWritesAndVerify: vi.fn(async () => undefined),
      });

      expect(
        test.provider.resume.mock.calls.map(([serviceId]) => serviceId),
      ).toEqual([...durableServiceIds]);
      expect(witness.serviceIds).toEqual([...durableServiceIds]);
      expect(witness.deployIds).toHaveLength(durableServiceIds.length);
    },
  );

  it("keeps a pre-suspended unchanged service suspended", async () => {
    const test = harness();
    await test.cutover.stage({ source, protectedEnvironment, target });
    await test.cutover.recover({ source, protectedEnvironment, target });

    await test.cutover.finalizeAuthorizedSourceRecovery({
      source,
      protectedEnvironment,
      target,
      sourceWriterServiceIds: ["srv-web", "srv-worker"],
      restoreSourceWritesAndVerify: vi.fn(async () => undefined),
    });

    expect(test.provider.resume).not.toHaveBeenCalledWith("srv-api");
    await expect(test.provider.observe("srv-api")).resolves.toMatchObject({
      suspended: true,
    });
  });

  it("rejects a missing verified deploy ID before restoring writes or resuming services", async () => {
    const test = harness();
    await test.cutover.stage({ source, protectedEnvironment, target });
    await test.cutover.recover({ source, protectedEnvironment, target });
    const index = test.checkpoints.findIndex(
      (item) =>
        item.serviceId === "srv-worker" && item.step === "source_verified",
    );
    const withoutDeployId = { ...test.checkpoints[index]! };
    delete withoutDeployId.deployId;
    test.checkpoints[index] = withoutDeployId;
    const restoreSourceWritesAndVerify = vi.fn(async () => undefined);

    await expect(
      test.cutover.finalizeAuthorizedSourceRecovery({
        source,
        protectedEnvironment,
        target,
        sourceWriterServiceIds: ["srv-web", "srv-worker"],
        restoreSourceWritesAndVerify,
      }),
    ).rejects.toThrow("service_transition_source_deploy_checkpoint_missing");
    expect(restoreSourceWritesAndVerify).not.toHaveBeenCalled();
    expect(test.provider.resume).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous consumed resume without replay", async () => {
    const test = harness("resume");
    await test.cutover.stage({ source, protectedEnvironment, target });
    await test.cutover.recover({ source, protectedEnvironment, target });
    const input = {
      source,
      protectedEnvironment,
      target,
      sourceWriterServiceIds: ["srv-web", "srv-worker"],
      restoreSourceWritesAndVerify: vi.fn(async () => undefined),
    };

    await expect(
      test.cutover.finalizeAuthorizedSourceRecovery(input),
    ).rejects.toThrow("crash:resume");
    await expect(
      test.cutover.finalizeAuthorizedSourceRecovery(input),
    ).rejects.toThrow("service_transition_recovery_effect_ambiguous");
    // Independent observation is retained for forward repair, but it cannot
    // turn an ambiguous consumed/executing permit into completed recovery.
    await test.provider.resume("srv-web");
    await expect(
      test.cutover.finalizeAuthorizedSourceRecovery(input),
    ).rejects.toThrow("service_transition_recovery_forward_repair_required");
  });

  it("rejects durable freeze evidence outside the recovery manifest", async () => {
    const test = harness();
    await test.cutover.stage({ source, protectedEnvironment, target });
    await test.cutover.recover({ source, protectedEnvironment, target });

    await expect(
      test.cutover.finalizeAuthorizedSourceRecovery({
        source,
        protectedEnvironment,
        target,
        sourceWriterServiceIds: ["srv-foreign"],
        restoreSourceWritesAndVerify: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("recovery_scope_mismatch");
    expect(test.provider.resume).not.toHaveBeenCalled();
  });
});
