import { describe, expect, it, vi } from "vitest";
import { RenderProviderFreezeAdapter } from "./render-provider-freeze";

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
});
