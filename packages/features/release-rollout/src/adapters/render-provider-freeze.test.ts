import { describe, expect, it, vi } from "vitest";
import { RenderProviderFreezeAdapter as ProductionRenderProviderFreezeAdapter } from "./render-provider-freeze";
import type { RenderFetch } from "./render-api";
import { ProviderAuthorityOperation } from "../application/ports";
import { TestProviderMutationAuthority } from "../test-provider-mutation-authority";

class RenderProviderFreezeAdapter extends ProductionRenderProviderFreezeAdapter {
  constructor(
    fetchImpl?: RenderFetch,
    sleep?: (milliseconds: number) => Promise<void>,
  ) {
    const delegate = fetchImpl ?? fetch;
    let cachedUrl: string | undefined;
    let cached: Response | undefined;
    const authorityAwareFetch = async (url: string, init?: RequestInit) => {
      const serviceRead =
        !init?.method && /\/services\/[^/]+$/u.test(new URL(url).pathname);
      if (serviceRead && cachedUrl === url && cached) return cached.clone();
      const response = await delegate(url, init);
      if (serviceRead) {
        cachedUrl = url;
        cached = response.clone();
      } else if (init?.method) {
        cachedUrl = undefined;
        cached = undefined;
      }
      return response;
    };
    super(authorityAwareFetch, sleep, new TestProviderMutationAuthority());
  }
  override freezeAndObserve(input: any) {
    return super.freezeAndObserve({
      rolloutId: "test-rollout",
      mutationOwnerId: "test-owner",
      ...input,
    });
  }
  override resumeFrozenServiceAndObserve(input: any) {
    return super.resumeFrozenServiceAndObserve({
      rolloutId: "test-rollout",
      mutationOwnerId: "test-owner",
      ...input,
    });
  }
}

const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const service = {
  id: "srv-writer",
  ownerId: "tea-owner",
  type: "background_worker",
  suspended: "suspended",
  autoDeploy: "no",
  serviceDetails: {},
};

describe("Render provider writer inventory", () => {
  it("durably reports the first mutation before a later suspension fails", async () => {
    const services = [
      { ...service, id: "srv-a", suspended: "not_suspended" },
      { ...service, id: "srv-b", suspended: "not_suspended" },
    ];
    let aSuspended = false;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/services"))
        return response(services.map((value) => ({ service: value })));
      if (url.includes("/env-vars"))
        return response([
          { envVar: { key: "DATABASE_URL", value: "redacted" } },
        ]);
      if (url.includes("/deploys"))
        return response([
          {
            deploy: {
              id: url.includes("srv-a") ? "dep-a" : "dep-b",
              status: "live",
            },
          },
        ]);
      if (url.endsWith("/services/srv-a/suspend") && init?.method === "POST") {
        aSuspended = true;
        return new Response(null, { status: 202 });
      }
      if (url.endsWith("/services/srv-a"))
        return response({
          ...services[0],
          suspended: aSuspended ? "suspended" : "not_suspended",
        });
      if (url.endsWith("/services/srv-b/suspend") && init?.method === "POST")
        return new Response(null, { status: 503 });
      if (url.endsWith("/services/srv-b")) return response(services[1]);
      throw new Error(`unexpected:${url}`);
    });
    const prepareMutation = vi.fn(async () => true);
    const recordMutation = vi.fn(async () => undefined);
    await expect(
      new RenderProviderFreezeAdapter(
        fetchImpl,
        async () => undefined,
      ).freezeAndObserve({
        apiKey: "redacted",
        ownerId: service.ownerId,
        sourceWriterServiceIds: ["srv-a", "srv-b"],
        prepareMutation,
        recordMutation,
      }),
    ).rejects.toThrow("provider_mutation_forward_repair_required");
    expect(recordMutation).toHaveBeenCalledTimes(1);
    expect(prepareMutation).toHaveBeenCalledTimes(2);
    expect(recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: "srv-a",
        latestSuccessfulDeployId: "dep-a",
      }),
    );
  });

  it("does not record or later resume a service that was already suspended", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/services")) return response([{ service }]);
      if (url.includes("/env-vars"))
        return response([
          { envVar: { key: "DATABASE_URL", value: "redacted" } },
        ]);
      if (url.includes("/deploys"))
        return response([{ deploy: { id: "dep-live", status: "live" } }]);
      return response(service);
    });
    const prepareMutation = vi.fn(async () => false);
    const recordMutation = vi.fn(async () => undefined);
    await new RenderProviderFreezeAdapter(fetchImpl).freezeAndObserve({
      apiKey: "redacted",
      ownerId: service.ownerId,
      sourceWriterServiceIds: [service.id],
      prepareMutation,
      recordMutation,
    });
    expect(prepareMutation).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: service.id, beforeSuspended: true }),
    );
    expect(recordMutation).not.toHaveBeenCalled();
  });

  it("fails immediately when authority denies a needed suspension", async () => {
    const running = { ...service, suspended: "not_suspended" };
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/services")) return response([{ service: running }]);
      if (url.includes("/env-vars"))
        return response([
          { envVar: { key: "DATABASE_URL", value: "redacted" } },
        ]);
      if (url.includes("/deploys"))
        return response([{ deploy: { id: "dep-live", status: "live" } }]);
      return response(running);
    });

    await expect(
      new RenderProviderFreezeAdapter(fetchImpl, sleep).freezeAndObserve({
        apiKey: "redacted",
        ownerId: service.ownerId,
        sourceWriterServiceIds: [service.id],
        prepareMutation: vi.fn(async () => false),
      }),
    ).rejects.toThrow("render_freeze_preparation_state_contradiction");
    expect(sleep).not.toHaveBeenCalled();
    expect(
      fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/suspend")),
    ).toBe(false);
  });

  it("completes a durable prior intent when crash replay finds the service suspended", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/services")) return response([{ service }]);
      if (url.includes("/env-vars"))
        return response([
          { envVar: { key: "DATABASE_URL", value: "redacted" } },
        ]);
      if (url.includes("/deploys"))
        return response([{ deploy: { id: "dep-live", status: "live" } }]);
      return response(service);
    });
    const recordMutation = vi.fn(async () => undefined);
    await new RenderProviderFreezeAdapter(fetchImpl).freezeAndObserve({
      apiKey: "redacted",
      ownerId: service.ownerId,
      sourceWriterServiceIds: [service.id],
      prepareMutation: vi.fn(async () => true),
      recordMutation,
    });
    expect(recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: service.id }),
    );
    expect(
      fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/suspend")),
    ).toBe(false);
  });
  it.each([
    ["duplicate", [service.id, service.id]],
    ["unsafe", ["../../unsafe"]],
    [
      "too many",
      Array.from({ length: 101 }, (_, index) => `srv-writer${index}`),
    ],
  ])(
    "rejects %s writer IDs before contacting Render",
    async (_label, serviceIds) => {
      const fetchImpl = vi.fn();

      await expect(
        new RenderProviderFreezeAdapter(fetchImpl).freezeAndObserve({
          apiKey: "redacted",
          ownerId: service.ownerId,
          sourceWriterServiceIds: serviceIds,
        }),
      ).rejects.toThrow("render_freeze_context_invalid");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("discovers every database-credential service before accepting the declaration", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/env-vars"))
        return response([
          { envVar: { key: "DATABASE_URL", value: "redacted" } },
        ]);
      if (url.includes("/deploys"))
        return response([
          { deploy: { id: "dep-live", status: "live", commit: { id: "a" } } },
        ]);
      if (url.endsWith("/services")) return response([{ service }]);
      return response(service);
    });
    const observation = await new RenderProviderFreezeAdapter(
      fetchImpl,
    ).freezeAndObserve({
      apiKey: "redacted",
      ownerId: service.ownerId,
      sourceWriterServiceIds: [service.id],
    });
    expect(observation.facts).toEqual(
      expect.objectContaining({
        complete: true,
        writerInventory: [
          {
            serviceId: service.id,
            serviceType: service.type,
            credentialKeys: ["DATABASE_URL"],
          },
        ],
        writerInventorySha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        discoveryScope: "provider_hint_only_database_fence_authoritative",
      }),
    );
  });

  it("rejects an undeclared cron/background/one-off credential surface", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/env-vars")
        ? response([{ envVar: { key: "PGPASSWORD", value: "redacted" } }])
        : response([{ service }]),
    );
    await expect(
      new RenderProviderFreezeAdapter(fetchImpl).freezeAndObserve({
        apiKey: "redacted",
        ownerId: service.ownerId,
        sourceWriterServiceIds: ["srv-declared-but-incomplete"],
      }),
    ).rejects.toThrow("render_freeze_writer_inventory_mismatch");
  });

  it("resumes source only with independent ACL and authority witnesses", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(service))
      .mockResolvedValueOnce(
        response([
          { deploy: { id: "dep-live", status: "live", commit: { id: "a" } } },
        ]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        response({ ...service, suspended: "not_suspended" }),
      );
    const witness = await new RenderProviderFreezeAdapter(
      fetchImpl,
      async () => undefined,
    ).resumeFrozenServiceAndObserve({
      apiKey: "redacted",
      serviceId: service.id,
      expectedDeployId: "dep-live",
      sourceSystemIdentifier: "100",
      databaseWitness: {
        systemIdentifier: "100",
        aclSha256: `sha256:${"a".repeat(64)}`,
        observedAt: "2026-08-12T00:00:00.000Z",
        sourceWritesRestored: true,
      },
      decision: {
        rolloutId: "rollout-1",
        operation: ProviderAuthorityOperation.ResumeSource,
        sourceSystemIdentifier: "100",
        targetSystemIdentifier: "200",
        expectedReceiptSha256: `sha256:${"b".repeat(64)}`,
        activationBoundary: "before",
        decision: "allow",
        decisionId: "decision-1",
        decidedAt: "2026-08-12T00:00:00.000Z",
      },
      executionPermit: {
        epoch: 1,
        token: "c".repeat(64),
        executionReceipt: "d".repeat(64),
      },
      executeAuthorized: (io: () => Promise<unknown>) => io(),
    });
    expect(witness).toMatchObject({
      serviceId: service.id,
      deployId: "dep-live",
      resumed: true,
    });
  });

  it("does not resume when durable freeze deployment identity changed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(service))
      .mockResolvedValueOnce(
        response([{ deploy: { id: "dep-other", status: "live" } }]),
      );
    await expect(
      new RenderProviderFreezeAdapter(fetchImpl).resumeFrozenServiceAndObserve({
        apiKey: "redacted",
        serviceId: service.id,
        expectedDeployId: "dep-frozen",
        sourceSystemIdentifier: "100",
        databaseWitness: {
          systemIdentifier: "100",
          aclSha256: `sha256:${"a".repeat(64)}`,
          observedAt: "2026-08-12T00:00:00.000Z",
          sourceWritesRestored: true,
        },
        decision: {
          rolloutId: "rollout-1",
          operation: ProviderAuthorityOperation.ResumeSource,
          sourceSystemIdentifier: "100",
          targetSystemIdentifier: "200",
          expectedReceiptSha256: `sha256:${"b".repeat(64)}`,
          activationBoundary: "before",
          decision: "allow",
          decisionId: "decision-1",
          decidedAt: "2026-08-12T00:00:00.000Z",
        },
        executionPermit: {
          epoch: 1,
          token: "c".repeat(64),
          executionReceipt: "d".repeat(64),
        },
        executeAuthorized: (io: () => Promise<unknown>) => io(),
      }),
    ).rejects.toThrow("render_source_compensation_deploy_identity_changed");
    expect(
      fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/resume")),
    ).toBe(false);
  });

  it("keeps source suspended when activation boundary is authorized", async () => {
    const fetchImpl = vi.fn();
    await expect(
      new RenderProviderFreezeAdapter(fetchImpl).resumeFrozenServiceAndObserve({
        apiKey: "redacted",
        serviceId: service.id,
        expectedDeployId: "dep-live",
        sourceSystemIdentifier: "100",
        databaseWitness: {
          systemIdentifier: "100",
          aclSha256: `sha256:${"a".repeat(64)}`,
          observedAt: "2026-08-12T00:00:00.000Z",
          sourceWritesRestored: true,
        },
        decision: {
          rolloutId: "rollout-1",
          operation: ProviderAuthorityOperation.ResumeSource,
          sourceSystemIdentifier: "100",
          targetSystemIdentifier: "200",
          expectedReceiptSha256: `sha256:${"b".repeat(64)}`,
          activationBoundary: "activated",
          decision: "allow",
          decisionId: "decision-1",
          decidedAt: "2026-08-12T00:00:00.000Z",
        },
        executionPermit: {
          epoch: 1,
          token: "c".repeat(64),
          executionReceipt: "d".repeat(64),
        },
        executeAuthorized: (io: () => Promise<unknown>) => io(),
      }),
    ).rejects.toThrow("render_source_compensation_authority_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-observes exact recovery after a compensation response loss", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response({ ...service, suspended: "not_suspended" }),
      )
      .mockResolvedValueOnce(
        response([
          { deploy: { id: "dep-live", status: "live", commit: { id: "a" } } },
        ]),
      );
    await expect(
      new RenderProviderFreezeAdapter(fetchImpl).observeFrozenServiceRecovery({
        apiKey: "redacted",
        serviceId: service.id,
        expectedDeployId: "dep-live",
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed execution permit before provider I/O", async () => {
    const fetchImpl = vi.fn();
    await expect(
      new RenderProviderFreezeAdapter(fetchImpl).resumeFrozenServiceAndObserve({
        apiKey: "redacted",
        serviceId: service.id,
        expectedDeployId: "dep-live",
        sourceSystemIdentifier: "100",
        databaseWitness: {
          systemIdentifier: "100",
          aclSha256: `sha256:${"a".repeat(64)}`,
          observedAt: "2026-08-12T00:00:00.000Z",
          sourceWritesRestored: true,
        },
        decision: {
          rolloutId: "rollout-1",
          operation: ProviderAuthorityOperation.ResumeSource,
          sourceSystemIdentifier: "100",
          targetSystemIdentifier: "200",
          expectedReceiptSha256: `sha256:${"b".repeat(64)}`,
          activationBoundary: "before",
          decision: "allow",
          decisionId: "decision-1",
          decidedAt: "2026-08-12T00:00:00.000Z",
        },
        executionPermit: {
          epoch: 0,
          token: "invalid",
          executionReceipt: "d".repeat(64),
        },
        executeAuthorized: (io: () => Promise<unknown>) => io(),
      }),
    ).rejects.toThrow("render_source_compensation_authority_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
