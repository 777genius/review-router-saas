import { describe, expect, it } from "vitest";
import type { TransactionalServiceProvider } from "../application/service-transition-ports";
import { RenderTransactionalServicesAdapter } from "./render-transactional-services";
import {
  RENDER_SOURCE_RECOVERY_FORMAT,
  fromRenderSourceRecoveryManifestV1,
  renderSourceRecoveryManifestSha256,
  renderSourceServiceContractSha256,
  toRenderSourceRecoveryManifestV1,
} from "./render-service-transition-compatibility";

const legacyService = (() => {
  const value = {
    serviceId: "srv-api",
    ownerId: "tea-owner",
    type: "web_service" as const,
    runtime: "node" as const,
    repository: "https://example.test/source.git",
    branch: "main",
    rootDir: "",
    sourceCommitSha: "a".repeat(40),
    buildCommand: "build",
    startCommand: "start",
    preDeployCommand: "",
    healthCheckPath: "/health",
    region: "region-1",
    plan: "plan-1",
    maxShutdownDelaySeconds: 60,
    autoDeploy: "no" as const,
    databaseEnvKey: "DATABASE_URL",
    databaseRole: "reviewrouter_api",
    sourceEnvSha256: `sha256:${"b".repeat(64)}`,
    sourceEnvKeysSha256: `sha256:${"c".repeat(64)}`,
  };
  return {
    ...value,
    serviceContractSha256: renderSourceServiceContractSha256(value),
  };
})();

describe("Render service-transition adapter contract", () => {
  it("is substitutable for the provider-neutral capability port", () => {
    const adapter: TransactionalServiceProvider =
      new RenderTransactionalServicesAdapter("token", async () => {
        throw new Error("unexpected request");
      });

    expect(adapter).toBeInstanceOf(RenderTransactionalServicesAdapter);
    expect(typeof adapter.deployArtifact).toBe("function");
    expect(typeof adapter.deploySourceRevision).toBe("function");
    expect(typeof adapter.quiesceDeployments).toBe("function");
  });

  it("round-trips the immutable v1 evidence schema at the adapter boundary", () => {
    const unsigned = {
      schemaVersion: RENDER_SOURCE_RECOVERY_FORMAT,
      rolloutId: "rollout-1",
      services: [legacyService],
    } as const;
    const legacy = {
      ...unsigned,
      manifestSha256: renderSourceRecoveryManifestSha256(unsigned),
    };

    expect(
      toRenderSourceRecoveryManifestV1(
        fromRenderSourceRecoveryManifestV1(legacy),
      ),
    ).toEqual(legacy);
  });

  it("rejects corrupted legacy evidence before neutral mapping", () => {
    const unsigned = {
      schemaVersion: RENDER_SOURCE_RECOVERY_FORMAT,
      rolloutId: "rollout-1",
      services: [legacyService],
    } as const;

    expect(() =>
      fromRenderSourceRecoveryManifestV1({
        ...unsigned,
        manifestSha256: `sha256:${"f".repeat(64)}`,
      }),
    ).toThrow("render_service_transition_manifest_integrity_invalid");
  });
});
