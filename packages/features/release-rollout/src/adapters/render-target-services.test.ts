import { describe, expect, it, vi } from "vitest";
import { RenderTargetServicesAdapter as ProductionRenderTargetServicesAdapter } from "./render-target-services";
import { ProviderAuthorityOperation } from "../application/ports";
import { fingerprintRuntimeRecoveryWitness } from "./runtime-generation-witness";
import { TestProviderMutationAuthority } from "../test-provider-mutation-authority";
import { environmentSha256 } from "../domain/service-transition";
import { normalizeRenderServicePostcondition } from "./render-service-contract";

class RenderTargetServicesAdapter extends ProductionRenderTargetServicesAdapter {
  constructor(...args: any[]) {
    super(
      args[0] ?? fetch,
      args[1],
      args[2],
      new TestProviderMutationAuthority(),
    );
  }
  override stage(input: any) {
    return super.stage({ mutationOwnerId: "test-owner", ...input });
  }
  override resumeDeployAndObserve(input: any) {
    return super.resumeDeployAndObserve({
      mutationOwnerId: "test-owner",
      ...input,
    });
  }
  withRenderApiKey(apiKey = "render-secret") {
    this.renderApiKey = apiKey;
    return this;
  }
  hasRenderApiKey() {
    return this.renderApiKey !== null;
  }
}

const recoveryWitness = "w".repeat(64);
const recoveryWitnessSha256 =
  fingerprintRuntimeRecoveryWitness(recoveryWitness);
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
const resumeDecision = {
  ...stageDecision,
  operation: ProviderAuthorityOperation.ResumeTarget,
  activationBoundary: "activated" as const,
  decisionId: "decision-resume",
};
const service = {
  id: expected.serviceId,
  ownerId: "tea-owner",
  type: "web_service",
  suspended: "suspended",
  autoDeploy: "no",
  autoDeployTrigger: "off",
  image: { imagePath: `registry.example.test/app@sha256:${"d".repeat(64)}` },
  serviceDetails: {
    runtime: "image",
    preDeployCommand: "",
    region: "frankfurt",
    plan: "starter",
    maxShutdownDelaySeconds: 60,
    numInstances: 1,
  },
};
const canaryEnvironment = [{ key: "DATABASE_URL", value: "redacted" }];
const canaryService = (runtimeRole: string) => ({
  ...service,
  id: `srv-${runtimeRole}`,
  suspended: "not_suspended" as const,
  type: runtimeRole === "worker" ? "background_worker" : "web_service",
});
const expectedCanaryServices = ["api", "web", "worker"].map((runtimeRole) => ({
  runtimeRole: runtimeRole as "api" | "web" | "worker",
  serviceId: `srv-${runtimeRole}`,
  deployId: `dep-${runtimeRole}`,
  provenance: {
    kind: "git" as const,
    commitSha: "a".repeat(40),
  },
  servicePostcondition: normalizeRenderServicePostcondition(
    canaryService(runtimeRole) as never,
    environmentSha256(canaryEnvironment),
  ),
}));
const deploy = (id: string, status: string) => [
  {
    deploy: { id, status, commit: { id: expected.provenance.commitSha } },
    cursor: null,
  },
];
const finalRenderResponse = (url: string) => {
  const parsed = new URL(url);
  const match = parsed.pathname.match(
    /^\/v1\/services\/(srv-(api|web|worker))(.*)$/u,
  );
  if (!match) throw new Error(`unexpected Render URL: ${url}`);
  const [, serviceId, runtimeRole, suffix] = match;
  if (suffix === "/env-vars")
    return json(canaryEnvironment.map((envVar) => ({ envVar, cursor: null })));
  if (suffix === "/deploys") return json(deploy(`dep-${runtimeRole}`, "live"));
  if (suffix === `/deploys/dep-${runtimeRole}`)
    return json({
      id: `dep-${runtimeRole}`,
      status: "live",
      commit: { id: "a".repeat(40) },
    });
  if (suffix === "") return json(canaryService(runtimeRole!));
  throw new Error(`unexpected Render path: ${serviceId}${suffix}`);
};
describe("Render target switch and live canary", () => {
  it("patches environment keys and deploys the exact immutable build", async () => {
    const targetUrl =
      "postgresql://reviewrouter_api:secret@target.internal/reviewrouter?sslmode=require";
    const environment: Record<string, string> = {
      DATABASE_URL:
        "postgresql://reviewrouter_api:old@source.internal/reviewrouter",
      UNCHANGED: "yes",
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/env-vars") && init?.method === "PUT") {
        const replacement = JSON.parse(String(init.body)) as Array<{
          key: string;
          value: string;
        }>;
        for (const key of Object.keys(environment)) delete environment[key];
        for (const item of replacement) environment[item.key] = item.value;
        return json({}, 200);
      }
      if (pathname.endsWith("/env-vars"))
        return json(
          Object.entries(environment).map(([key, value]) => ({
            envVar: { key, value },
            cursor: null,
          })),
        );
      if (pathname.endsWith("/deploys") && init?.method === "POST")
        return json(
          {
            id: "dep-new",
            status: "queued",
            commit: { id: expected.provenance.commitSha },
          },
          201,
        );
      if (pathname.endsWith("/deploys"))
        return json(
          deploy(
            fetchImpl.mock.calls.some(([, call]) => call?.method === "POST")
              ? "dep-new"
              : "dep-old",
            "live",
          ),
        );
      return json(service);
    });
    const observation = await new RenderTargetServicesAdapter(
      fetchImpl,
      async () => undefined,
    ).stage({
      apiKey: "redacted",
      targetInternalHostname: "target.internal",
      targetSystemIdentifier: "200",
      targetDatabaseUrls: { [expected.serviceId]: targetUrl },
      releaseCommitSha: expected.provenance.commitSha,
      targetRecoveryWitness: recoveryWitness,
      targetRecoveryWitnessSha256: recoveryWitnessSha256,
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
    const replacements = fetchImpl.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/env-vars") &&
        (init?.method === "PUT" || init?.method === "POST"),
    );
    expect(replacements).toHaveLength(1);
    expect(environment).toMatchObject({
      DATABASE_URL: targetUrl,
      UNCHANGED: "yes",
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: recoveryWitness,
      REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: recoveryWitnessSha256,
    });
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
        targetRecoveryWitness: recoveryWitness,
        targetRecoveryWitnessSha256: recoveryWitnessSha256,
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
        targetRecoveryWitness: recoveryWitness,
        targetRecoveryWitnessSha256: recoveryWitnessSha256,
        services: [expected],
        fence,
        decision: { ...stageDecision, targetSystemIdentifier: "attacker" },
      }),
    ).rejects.toThrow("render_target_stage_context_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reconciles a lost resume response without replaying the unsafe write", async () => {
    let suspended: "suspended" | "not_suspended" = "suspended";
    const environment = [{ key: "DATABASE_URL", value: "redacted" }];
    const fetchImpl = vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/resume")) {
        suspended = "not_suspended";
        throw new Error("lost provider response");
      }
      if (pathname.endsWith("/env-vars"))
        return json(environment.map((envVar) => ({ envVar, cursor: null })));
      if (pathname.endsWith("/deploys")) return json(deploy("dep-new", "live"));
      return json({ ...service, suspended });
    });
    const stagedService = {
      serviceId: expected.serviceId,
      deployId: "dep-new",
      provenance: expected.provenance,
      servicePostcondition: normalizeRenderServicePostcondition(
        service as never,
        environmentSha256(environment),
      ),
    };
    const adapter = new RenderTargetServicesAdapter(
      fetchImpl,
      async () => undefined,
    );
    const input = {
      apiKey: "redacted",
      services: [expected],
      stagedServices: [stagedService],
      rolloutId: fence.rolloutId,
      sourceSystemIdentifier: fence.sourceSystemIdentifier,
      targetSystemIdentifier: fence.targetSystemIdentifier,
      expectedReceiptSha256: fence.previousReceiptSha256,
      decision: resumeDecision,
    };
    await expect(adapter.resumeDeployAndObserve(input)).resolves.toMatchObject({
      facts: [{ serviceId: expected.serviceId, resumed: true }],
    });
    expect(adapter.hasRenderApiKey()).toBe(true);
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/resume")),
    ).toHaveLength(1);
  });

  it("accepts an exact durable resume replay after fresh read-only observation without replaying resume", async () => {
    const environment = [{ key: "DATABASE_URL", value: "redacted" }];
    const fetchImpl = vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/env-vars"))
        return json(environment.map((envVar) => ({ envVar, cursor: null })));
      if (pathname.endsWith("/deploys")) return json(deploy("dep-new", "live"));
      if (pathname.endsWith("/resume"))
        throw new Error("resume replay issued provider I/O");
      return json({ ...service, suspended: "not_suspended" });
    });
    const stagedService = {
      serviceId: expected.serviceId,
      deployId: "dep-new",
      provenance: expected.provenance,
      servicePostcondition: normalizeRenderServicePostcondition(
        service as never,
        environmentSha256(environment),
      ),
    };
    const authority = {
      recover: vi.fn(async (request: any) => ({
        status: "terminal" as const,
        outcome: {
          status: "terminal" as const,
          result: "exact_postcondition" as const,
          rolloutId: request.rolloutId,
          operation: request.operation,
          resource: request.resource,
          ownerId: request.ownerId,
          epoch: 1,
          permitId: "permit-replay",
          receiptId: "receipt-replay",
          expected: request.expected,
          consumedAt: "2026-08-12T00:00:00.000Z",
          completedAt: "2026-08-12T00:00:01.000Z",
          observation: {
            resource: request.resource,
            state: request.expected,
            observedAt: "2026-08-12T00:00:01.000Z",
            resultIdentity: {
              kind: "service" as const,
              id: request.resource.id,
            },
          },
        },
      })),
      issue: vi.fn(),
      consume: vi.fn(),
      validateExecution: vi.fn(),
      complete: vi.fn(),
      reconcile: vi.fn(),
    };
    const observation = await new ProductionRenderTargetServicesAdapter(
      fetchImpl,
      async () => undefined,
      undefined,
      authority as never,
    ).resumeDeployAndObserve({
      apiKey: "redacted",
      services: [expected],
      stagedServices: [stagedService],
      rolloutId: fence.rolloutId,
      sourceSystemIdentifier: fence.sourceSystemIdentifier,
      targetSystemIdentifier: fence.targetSystemIdentifier,
      expectedReceiptSha256: fence.previousReceiptSha256,
      decision: resumeDecision,
      mutationOwnerId: "test-owner",
    });
    expect(observation.facts).toEqual([
      expect.objectContaining({ serviceId: expected.serviceId, resumed: true }),
    ]);
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/resume")),
    ).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalled();
    expect(authority.issue).not.toHaveBeenCalled();
  });

  it("uses an authenticated unique no-store POST and binds the write/read response", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (new URL(url).hostname === "api.render.com")
        return finalRenderResponse(url);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const serviceFacts = body.serviceFacts as Array<Record<string, unknown>>;
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer canary-secret",
      );
      return json(
        {
          ...body,
          commitSha: "a".repeat(40),
          databaseSystemIdentifier: "200",
          recoveryWitnessSha256: recoveryWitnessSha256,
          runtimeWitnessProofs: ["api", "web", "worker"].map((runtimeRole) => ({
            ...serviceFacts.find((item) => item.runtimeRole === runtimeRole),
            runtimeRole,
            databaseRole: `reviewrouter_${runtimeRole}`,
            recoveryWitnessSha256: recoveryWitnessSha256,
            provedAt: "2026-08-12T00:00:00.500Z",
            systemIdentifier: "200",
            releaseCommitSha: "a".repeat(40),
            nonce: body.nonce,
            requestedAt: body.requestedAt,
          })),
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
    )
      .withRenderApiKey()
      .verifyLiveCanary({
        url: "https://api.example.test/internal/release-canary",
        expectedCommitSha: "a".repeat(40),
        expectedSystemIdentifier: "200",
        expectedRecoveryWitnessSha256: recoveryWitnessSha256,
        rolloutId: "rollout-target-1",
        bearerToken: "canary-secret",
        expectedServices: expectedCanaryServices,
      });
    expect(observation.facts).toMatchObject({
      rolloutId: "rollout-target-1",
      databaseSystemIdentifier: "200",
      writeReadRoundTrip: true,
    });
  });

  it.each([
    [
      "wrong nonce",
      (proof: Record<string, unknown>) => ({ ...proof, nonce: "f".repeat(48) }),
    ],
    [
      "stale proof",
      (proof: Record<string, unknown>) => ({
        ...proof,
        provedAt: "2026-08-11T23:59:59.999Z",
      }),
    ],
    [
      "forged deploy ID",
      (proof: Record<string, unknown>) => ({
        ...proof,
        deployId: "dep-attacker",
      }),
    ],
    [
      "forged service postcondition",
      (proof: Record<string, unknown>) => ({
        ...proof,
        servicePostconditionSha256: `sha256:${"f".repeat(64)}`,
      }),
    ],
  ])(
    "rejects %s reuse for the current canary challenge",
    async (_name, mutate) => {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (new URL(url).hostname === "api.render.com")
          return finalRenderResponse(url);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const serviceFacts = body.serviceFacts as Array<
          Record<string, unknown>
        >;
        return json(
          {
            ...body,
            commitSha: "a".repeat(40),
            databaseSystemIdentifier: "200",
            recoveryWitnessSha256,
            runtimeWitnessProofs: ["api", "web", "worker"].map((runtimeRole) =>
              mutate({
                ...serviceFacts.find(
                  (item) => item.runtimeRole === runtimeRole,
                ),
                runtimeRole,
                databaseRole: `reviewrouter_${runtimeRole}`,
                recoveryWitnessSha256,
                systemIdentifier: "200",
                releaseCommitSha: "a".repeat(40),
                nonce: body.nonce,
                requestedAt: body.requestedAt,
                provedAt: "2026-08-12T00:00:00.500Z",
              }),
            ),
            writeReadRoundTrip: true,
            observedAt: "2026-08-12T00:00:01.000Z",
          },
          200,
          { "cache-control": "private, no-store" },
        );
      });
      await expect(
        new RenderTargetServicesAdapter(
          fetchImpl,
          async () => undefined,
          () => new Date("2026-08-12T00:00:00.000Z"),
        )
          .withRenderApiKey()
          .verifyLiveCanary({
            url: "https://api.example.test/internal/release-canary",
            expectedCommitSha: "a".repeat(40),
            expectedSystemIdentifier: "200",
            expectedRecoveryWitnessSha256: recoveryWitnessSha256,
            rolloutId: "rollout-target-1",
            bearerToken: "canary-secret",
            expectedServices: expectedCanaryServices,
          }),
      ).rejects.toThrow("render_target_canary_identity_mismatch");
    },
  );

  it("rejects a deploy that drifts after all runtime proofs complete", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (new URL(url).hostname === "api.render.com") {
        const response = finalRenderResponse(url);
        if (url.endsWith("/services/srv-worker/deploys/dep-worker"))
          return json({
            id: "dep-attacker",
            status: "live",
            commit: { id: "a".repeat(40) },
          });
        return response;
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const serviceFacts = body.serviceFacts as Array<Record<string, unknown>>;
      return json(
        {
          ...body,
          commitSha: "a".repeat(40),
          databaseSystemIdentifier: "200",
          recoveryWitnessSha256,
          runtimeWitnessProofs: serviceFacts.map((fact) => ({
            ...fact,
            databaseRole: `reviewrouter_${fact.runtimeRole}`,
            recoveryWitnessSha256,
            systemIdentifier: "200",
            releaseCommitSha: "a".repeat(40),
            nonce: body.nonce,
            requestedAt: body.requestedAt,
            provedAt: "2026-08-12T00:00:00.500Z",
          })),
          writeReadRoundTrip: true,
          observedAt: "2026-08-12T00:00:01.000Z",
        },
        200,
        { "cache-control": "private, no-store" },
      );
    });
    await expect(
      new RenderTargetServicesAdapter(
        fetchImpl,
        async () => undefined,
        () => new Date("2026-08-12T00:00:00.000Z"),
      )
        .withRenderApiKey()
        .verifyLiveCanary({
          url: "https://api.example.test/internal/release-canary",
          expectedCommitSha: "a".repeat(40),
          expectedSystemIdentifier: "200",
          expectedRecoveryWitnessSha256: recoveryWitnessSha256,
          rolloutId: "rollout-target-1",
          bearerToken: "canary-secret",
          expectedServices: expectedCanaryServices,
        }),
    ).rejects.toThrow("render_target_canary_final_observation_mismatch");
  });

  it("does not expose target canary bodies, cookies, or bearer tokens", async () => {
    const error = await new RenderTargetServicesAdapter(
      vi.fn().mockResolvedValue(
        new Response("target-body-canary", {
          status: 200,
          headers: { "set-cookie": "target-cookie-canary" },
        }),
      ),
    )
      .withRenderApiKey()
      .verifyLiveCanary({
        url: "https://api.example.test/internal/release-canary",
        expectedCommitSha: "a".repeat(40),
        expectedSystemIdentifier: "200",
        expectedRecoveryWitnessSha256: recoveryWitnessSha256,
        rolloutId: "rollout-target-1",
        bearerToken: "target-bearer-canary",
        expectedServices: expectedCanaryServices,
      })
      .catch((value: unknown) => value);
    const output = `${String(error)}${JSON.stringify(error)}`;
    expect(output.length).toBeLessThan(1_536);
    expect(output).not.toMatch(
      /target-body-canary|target-cookie-canary|target-bearer-canary/u,
    );
  });
});
