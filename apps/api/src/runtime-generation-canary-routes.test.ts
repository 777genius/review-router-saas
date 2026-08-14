import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { registerRuntimeGenerationCanaryRoute } from "./runtime-generation-canary-routes.js";

const token = "canary-secret";
const tokenSha256 = createHash("sha256").update(token).digest("hex");
const commit = "a".repeat(40);
const witnessSha256 = "b".repeat(64);
const requestBody = {
  rolloutId: "rollout-w2-proof",
  nonce: "c".repeat(48),
  requestedAt: "2026-08-13T00:00:00.000Z",
  expectedGeneration: {
    systemIdentifier: "200",
    recoveryWitnessSha256: witnessSha256,
  },
  serviceFacts: ["api", "web", "worker"].map((runtimeRole, index) => ({
    runtimeRole,
    serviceId: `srv-${runtimeRole}`,
    deployId: `dep-${runtimeRole}`,
    deploymentProvenance: String(index + 1).repeat(40),
    servicePostconditionSha256: `sha256:${String(index + 4).repeat(64)}`,
  })),
};

const prisma = (proofs: unknown[]) =>
  ({
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes("pg_control_system"))
        return [{ systemIdentifier: "200" }];
      if (sql.includes("request_runtime_canary_challenge")) return [];
      if (sql.includes("read_runtime_canary_challenge_proofs")) return proofs;
      return [{ nonce: requestBody.nonce }];
    }),
  }) as unknown as PrismaClient;

const proofs = ["api", "web", "worker"].map((runtimeRole) => ({
  nonce: requestBody.nonce,
  rolloutId: requestBody.rolloutId,
  requestedAt: new Date(requestBody.requestedAt),
  runtimeRole,
  databaseRole: `reviewrouter_${runtimeRole}`,
  systemIdentifier: "200",
  recoveryWitnessSha256: witnessSha256,
  releaseCommitSha: commit,
  provedAt: new Date("2026-08-13T00:00:01.000Z"),
  serviceId: `srv-${runtimeRole}`,
  deployId: `dep-${runtimeRole}`,
  deploymentProvenance: requestBody.serviceFacts.find(
    (item) => item.runtimeRole === runtimeRole,
  )!.deploymentProvenance,
  servicePostconditionSha256: requestBody.serviceFacts.find(
    (item) => item.runtimeRole === runtimeRole,
  )!.servicePostconditionSha256,
}));

describe("runtime generation canary", () => {
  it("returns only W2 fingerprints after all runtime roles prove boot", async () => {
    const app = Fastify();
    await registerRuntimeGenerationCanaryRoute(app, {
      prisma: prisma(proofs),
      tokenSha256,
      releaseCommitSha: commit,
      expectedRecoveryWitnessSha256: witnessSha256,
      rolloutStartedAt: new Date("2026-08-12T23:59:59.000Z"),
      sleep: async () => undefined,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/internal/release-canary",
      headers: { authorization: `Bearer ${token}` },
      payload: requestBody,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      recoveryWitnessSha256: witnessSha256,
      databaseSystemIdentifier: "200",
      runtimeWitnessProofs: proofs.map((proof) => ({
        runtimeRole: proof.runtimeRole,
        recoveryWitnessSha256: witnessSha256,
        deployId: proof.deployId,
        servicePostconditionSha256: proof.servicePostconditionSha256,
      })),
      serviceFacts: requestBody.serviceFacts,
      writeReadRoundTrip: true,
    });
    expect(response.body).not.toContain(token);
  });

  it.each([
    [proofs.slice(0, 2)],
    [
      proofs.map((proof) =>
        proof.runtimeRole === "worker"
          ? { ...proof, recoveryWitnessSha256: "d".repeat(64) }
          : proof,
      ),
    ],
  ])("fails closed for missing or stale W1 role proof", async (invalid) => {
    const app = Fastify();
    await registerRuntimeGenerationCanaryRoute(app, {
      prisma: prisma(invalid),
      tokenSha256,
      releaseCommitSha: commit,
      expectedRecoveryWitnessSha256: witnessSha256,
      rolloutStartedAt: new Date("2026-08-12T23:59:59.000Z"),
      sleep: async () => undefined,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/internal/release-canary",
      headers: { authorization: `Bearer ${token}` },
      payload: requestBody,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(witnessSha256);
  });

  it.each([
    ["deploy ID", { deployId: "dep-forged" }],
    [
      "service postcondition",
      { servicePostconditionSha256: `sha256:${"f".repeat(64)}` },
    ],
  ])(
    "rejects a database proof with a forged %s binding",
    async (_name, forged) => {
      const app = Fastify();
      await registerRuntimeGenerationCanaryRoute(app, {
        prisma: prisma(
          proofs.map((proof, index) =>
            index === 2 ? { ...proof, ...forged } : proof,
          ),
        ),
        tokenSha256,
        releaseCommitSha: commit,
        expectedRecoveryWitnessSha256: witnessSha256,
        rolloutStartedAt: new Date("2026-08-12T23:59:59.000Z"),
        sleep: async () => undefined,
        now: () => new Date("2026-08-13T00:00:00.000Z"),
      });
      const response = await app.inject({
        method: "POST",
        url: "/internal/release-canary",
        headers: { authorization: `Bearer ${token}` },
        payload: requestBody,
      });
      expect(response.statusCode).toBe(503);
    },
  );
});
