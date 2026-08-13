import { describe, expect, it, vi } from "vitest";
import { RenderProviderFreezeAdapter } from "./render-provider-freeze";
import { ProviderAuthorityOperation } from "../application/ports";

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
    ).rejects.toThrow("render_api_suspend_failed:503");
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
    ).compensateAndObserve({
      apiKey: "redacted",
      sourceWriterServiceIds: [service.id],
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
    });
    expect(witness).toMatchObject({
      serviceIds: [service.id],
      deployIds: ["dep-live"],
      resumed: true,
    });
  });

  it("keeps source suspended when activation boundary is authorized", async () => {
    const fetchImpl = vi.fn();
    await expect(
      new RenderProviderFreezeAdapter(fetchImpl).compensateAndObserve({
        apiKey: "redacted",
        sourceWriterServiceIds: [service.id],
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
      }),
    ).rejects.toThrow("render_source_compensation_authority_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-observes an already resumed source after a compensation crash", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response({ ...service, suspended: "not_suspended" }),
      )
      .mockResolvedValueOnce(
        response([
          { deploy: { id: "dep-live", status: "live", commit: { id: "a" } } },
        ]),
      )
      .mockResolvedValueOnce(
        response({ ...service, suspended: "not_suspended" }),
      );
    await expect(
      new RenderProviderFreezeAdapter(fetchImpl).compensateAndObserve({
        apiKey: "redacted",
        sourceWriterServiceIds: [service.id],
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
      }),
    ).resolves.toMatchObject({ resumed: true, deployIds: ["dep-live"] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("safely retries a definite resume failure", async () => {
    let resumeAttempts = 0;
    let resumed = false;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/deploys"))
        return response([{ deploy: { id: "dep-live", status: "live" } }]);
      if (url.endsWith("/resume") && init?.method === "POST") {
        resumeAttempts += 1;
        if (resumeAttempts === 1) return new Response(null, { status: 503 });
        resumed = true;
        return new Response(null, { status: 202 });
      }
      return response({
        ...service,
        suspended: resumed ? "not_suspended" : "suspended",
      });
    });
    const adapter = new RenderProviderFreezeAdapter(
      fetchImpl,
      async () => undefined,
    );
    const input = {
      apiKey: "redacted",
      sourceWriterServiceIds: [service.id],
      sourceSystemIdentifier: "100",
      databaseWitness: {
        systemIdentifier: "100",
        aclSha256: `sha256:${"a".repeat(64)}`,
        observedAt: "2026-08-12T00:00:00.000Z",
        sourceWritesRestored: true as const,
      },
      decision: {
        rolloutId: "rollout-1",
        operation: ProviderAuthorityOperation.ResumeSource,
        sourceSystemIdentifier: "100",
        targetSystemIdentifier: "200",
        expectedReceiptSha256: `sha256:${"b".repeat(64)}`,
        activationBoundary: "before" as const,
        decision: "allow" as const,
        decisionId: "decision-1",
        decidedAt: "2026-08-12T00:00:00.000Z",
      },
    };
    await expect(adapter.compensateAndObserve(input)).rejects.toThrow(
      "render_api_resume_failed:503",
    );
    await expect(adapter.compensateAndObserve(input)).resolves.toMatchObject({
      serviceIds: [service.id],
      resumed: true,
    });
    expect(resumeAttempts).toBe(2);
  });
});
