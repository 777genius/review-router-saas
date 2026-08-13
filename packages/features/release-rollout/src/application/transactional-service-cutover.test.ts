import { describe, expect, it, vi } from "vitest";
import {
  environmentSha256,
  environmentKeysSha256,
  TransactionalServiceCutover,
  validateServiceTransitionContracts,
  sourceServiceContractSha256,
  targetServiceContractSha256,
  type ProtectedSourceEnvironment,
  type ServiceTransitionLedger,
  type ServiceTransitionCheckpoint,
  type SourceRecoveryManifest,
  type TargetServiceContract,
} from "./transactional-service-cutover";
import { createHash } from "node:crypto";

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
  };
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
        },
      ) => {
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
        return value;
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
    cutover: new TransactionalServiceCutover(ledger, provider),
    ledger,
    provider,
    checkpoints,
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
    ).rejects.toThrow("interrupted_source_recovered");
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
});
