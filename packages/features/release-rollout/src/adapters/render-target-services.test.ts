import { describe, expect, it, vi } from "vitest";
import { RenderTargetServicesAdapter } from "./render-target-services";
import { ProviderAuthorityOperation } from "../application/ports";

const json = (value: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const expected = {
  serviceId: "srv-api",
  provenance: { kind: "git" as const, commitSha: "a".repeat(40) },
  databaseEnvKey: "DATABASE_URL",
  databaseName: "reviewrouter",
  databaseRole: "reviewrouter_api",
};
const fence = {
  schemaVersion: 1 as const,
  rolloutId: "rollout-target-switch",
  expectedCommitSha: expected.provenance.commitSha,
  runId: "123",
  runAttempt: 1,
  sourceSystemIdentifier: "100",
  targetSystemIdentifier: "200",
  previousReceiptSha256: `sha256:${"0".repeat(64)}`,
  nonce: "a".repeat(32),
  version: 1,
  fencedAt: "2026-08-12T00:00:00.000Z",
};
const stageDecision = {
  rolloutId: fence.rolloutId,
  operation: ProviderAuthorityOperation.DeployTarget,
  sourceSystemIdentifier: fence.sourceSystemIdentifier,
  targetSystemIdentifier: fence.targetSystemIdentifier,
  expectedReceiptSha256: fence.previousReceiptSha256,
  activationBoundary: "before" as const,
  decision: "allow" as const,
  decisionId: "decision-stage",
  decidedAt: "2026-08-12T00:00:00.000Z",
};
const service = {
  id: expected.serviceId,
  ownerId: "tea-owner",
  type: "web_service",
  suspended: "suspended",
  autoDeploy: "no",
  serviceDetails: {},
};
const deploy = (id: string, status: string) => [
  {
    deploy: { id, status, commit: { id: expected.provenance.commitSha } },
    cursor: null,
  },
];
const env = (value: string) => [
  { envVar: { key: "DATABASE_URL", value }, cursor: null },
  { envVar: { key: "UNCHANGED", value: "yes" }, cursor: null },
];

describe("Render target switch and live canary", () => {
  it("replaces the complete environment and deploys the exact immutable build", async () => {
    const targetUrl =
      "postgresql://reviewrouter_api:secret@target.internal/reviewrouter?sslmode=require";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json(deploy("dep-old", "live")))
      .mockResolvedValueOnce(
        json(
          env("postgresql://reviewrouter_api:old@source.internal/reviewrouter"),
        ),
      )
      .mockResolvedValueOnce(json({}, 200))
      .mockResolvedValueOnce(json(env(targetUrl)))
      .mockResolvedValueOnce(
        json(
          {
            id: "dep-new",
            status: "queued",
            commit: { id: expected.provenance.commitSha },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(json(deploy("dep-new", "live")));
    const observation = await new RenderTargetServicesAdapter(
      fetchImpl,
      async () => undefined,
    ).stage({
      apiKey: "redacted",
      targetInternalHostname: "target.internal",
      targetSystemIdentifier: "200",
      targetDatabaseUrls: { [expected.serviceId]: targetUrl },
      releaseCommitSha: expected.provenance.commitSha,
      services: [expected],
      fence,
      decision: stageDecision,
    });
    expect(observation.facts).toEqual([
      expect.objectContaining({
        deployId: "dep-new",
        databaseHostname: "target.internal",
        databaseName: "reviewrouter",
        databaseRole: "reviewrouter_api",
        databaseSystemIdentifier: "200",
      }),
    ]);
    const replacement = fetchImpl.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/env-vars") && init?.method === "PUT",
    );
    expect(JSON.parse(String(replacement?.[1]?.body))).toEqual([
      { key: "DATABASE_URL", value: targetUrl },
      { key: "UNCHANGED", value: "yes" },
    ]);
  });

  it("rejects a target hostname hidden in a source URL password", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json(deploy("dep-old", "live")));
    await expect(
      new RenderTargetServicesAdapter(fetchImpl).stage({
        apiKey: "redacted",
        targetInternalHostname: "target.internal",
        targetSystemIdentifier: "200",
        targetDatabaseUrls: {
          [expected.serviceId]:
            "postgresql://reviewrouter_api:target.internal@source.internal/reviewrouter",
        },
        releaseCommitSha: expected.provenance.commitSha,
        services: [expected],
        fence,
        decision: stageDecision,
      }),
    ).rejects.toThrow("render_target_database_binding_mismatch");
  });

  it("does not call Render when deploy authority is missing or mismatched", async () => {
    const fetchImpl = vi.fn();
    await expect(
      new RenderTargetServicesAdapter(fetchImpl).stage({
        apiKey: "redacted",
        targetInternalHostname: "target.internal",
        targetSystemIdentifier: "200",
        targetDatabaseUrls: {},
        releaseCommitSha: expected.provenance.commitSha,
        services: [expected],
        fence,
        decision: { ...stageDecision, targetSystemIdentifier: "attacker" },
      }),
    ).rejects.toThrow("render_target_stage_context_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses an authenticated unique no-store POST and binds the write/read response", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer canary-secret",
      );
      return json(
        {
          ...body,
          commitSha: "a".repeat(40),
          databaseSystemIdentifier: "200",
          writeReadRoundTrip: true,
          observedAt: "2026-08-12T00:00:01.000Z",
        },
        200,
        { "cache-control": "private, no-store" },
      );
    });
    const observation = await new RenderTargetServicesAdapter(
      fetchImpl,
      async () => undefined,
      () => new Date("2026-08-12T00:00:00.000Z"),
    ).verifyLiveCanary({
      url: "https://api.example.test/internal/release-canary",
      expectedCommitSha: "a".repeat(40),
      expectedSystemIdentifier: "200",
      rolloutId: "rollout-target-1",
      bearerToken: "canary-secret",
    });
    expect(observation.facts).toMatchObject({
      rolloutId: "rollout-target-1",
      databaseSystemIdentifier: "200",
      writeReadRoundTrip: true,
    });
  });
});
