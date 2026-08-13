import { describe, expect, it, vi } from "vitest";
import {
  environmentSha256,
  TransactionalServiceCutover,
  validateServiceTransitionContracts,
  sourceServiceContractSha256,
  targetServiceContractSha256,
  type ProtectedSourceEnvironment,
  type ServiceTransitionCheckpoint,
  type SourceRecoveryManifest,
  type TargetServiceContract,
} from "./transactional-service-cutover";
import { createHash } from "node:crypto";

const sha = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const withHash = <T extends Record<string, unknown>>(
  value: T,
  field: "serviceContractSha256" | "manifestSha256",
): T & Record<typeof field, string> =>
  ({ ...value, [field]: sha(value) }) as T & Record<typeof field, string>;

const sourceEnvs = ["web", "api", "worker"].map((role) => ({
  serviceId: `srv-${role}`,
  values: [
    { key: "DATABASE_URL", value: `postgres://source/${role}` },
    { key: "SECRET", value: `never-log-${role}` },
  ],
}));
const services = ["web", "api", "worker"].map((role) =>
  {
    const value = {
      serviceId: `srv-${role}`,
      ownerId: "tea-owner",
      type: role === "worker" ? ("background_worker" as const) : ("web_service" as const),
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
    };
    return { ...value, serviceContractSha256: sourceServiceContractSha256(value) };
  },
) as SourceRecoveryManifest["services"];
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
  manifestSha256: source.manifestSha256,
  services: sourceEnvs,
};
const target = ["web", "api", "worker"].map((role) => {
  const environment = [
    { key: "DATABASE_URL", value: `postgres://target/${role}` },
    { key: "SECRET", value: `never-log-${role}` },
  ];
  const value = {
      serviceId: `srv-${role}`,
      imageUrl: `ghcr.io/777genius/review-router-saas-runtime@sha256:${"b".repeat(64)}`,
      environment,
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
  let crashed = false;
  let boundaryOrdinal = 0;
  const crash = (name: string) => {
    if (fail === name) boundaryOrdinal += 1;
    if (!crashed && fail === name && boundaryOrdinal === failOrdinal) {
      crashed = true;
      throw new Error(`crash:${name}`);
    }
  };
  const ledger = {
    begin: vi.fn(async () => "created" as const),
    append: vi.fn(async (value: Omit<ServiceTransitionCheckpoint, "sequence">) => {
      crash(`checkpoint:${value.step}`);
      const result = { ...value, sequence: checkpoints.length + 1 };
      checkpoints.push(result);
      return result;
    }),
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
    replaceEnvironment: vi.fn(async (id: string, values: typeof sourceEnvs[number]["values"]) => {
      const value = environmentSha256(values);
      current.get(id)!.environmentSha256 = value;
      crash("replaceEnvironment");
      return value;
    }),
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
  )("restores every source service after %s boundary failure on service %i", async (boundary, ordinal) => {
    const test = harness(boundary, ordinal);
    await expect(
      test.cutover.stage({ source, protectedEnvironment, target }),
    ).rejects.toThrow();
    expect(test.provider.configureSource).toHaveBeenCalledTimes(3);
  });

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

  it("rejects wrong manifest, env hash, scope, and foreign checkpoint", async () => {
    expect(() =>
      validateServiceTransitionContracts(
        { ...source, manifestSha256: `sha256:${"0".repeat(64)}` },
        protectedEnvironment,
        target,
      ),
    ).toThrow("manifest_invalid");
    expect(() =>
      validateServiceTransitionContracts(source, {
        ...protectedEnvironment,
        services: protectedEnvironment.services.slice(0, 2),
      }, target),
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
});
