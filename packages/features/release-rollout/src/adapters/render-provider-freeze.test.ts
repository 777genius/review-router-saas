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
});
