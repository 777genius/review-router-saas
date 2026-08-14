import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RenderApiAdapter } from "./render-api";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const envResponse = (environment: Readonly<Record<string, string>>) =>
  json(
    Object.entries(environment).map(([key, value]) => ({
      envVar: { key, value },
      cursor: null,
    })),
  );
const environmentSha256 = (environment: Readonly<Record<string, string>>) =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(environment)
          .map(([key, value]) => ({ key, value }))
          .sort((left, right) => left.key.localeCompare(right.key)),
      ),
    )
    .digest("hex")}`;

describe("Render OpenAPI wrappers", () => {
  it("observes a provider database identity without exposing connection material", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        id: "dpg-target",
        ownerId: "tea-1",
        name: "reviewrouter-target",
        version: "17.6",
        connectionInfo: { externalConnectionString: "must-not-be-returned" },
      }),
    );
    await expect(
      new RenderApiAdapter("redacted", fetchImpl).getPostgres("dpg-target"),
    ).resolves.toEqual({
      id: "dpg-target",
      ownerId: "tea-1",
      name: "reviewrouter-target",
      version: "17.6",
    });
  });

  it.each([
    ["cycle", ["cursor-a", "cursor-a"], "cursor_cycle"],
    ["malformed", ["cursor with space"], "malformed_cursor"],
  ] as const)(
    "fails closed on an incomplete %s inventory",
    async (_name, cursors, reason) => {
      let page = 0;
      const fetchImpl = vi.fn(async () =>
        json([
          {
            service: {
              id: `srv-${page}`,
              ownerId: "tea-1",
              type: "web_service",
              suspended: "suspended",
              autoDeploy: "no",
              serviceDetails: {},
            },
            cursor: cursors[page++] ?? null,
          },
        ]),
      );
      await expect(
        new RenderApiAdapter("redacted", fetchImpl).listAllServices(),
      ).rejects.toThrow(`render_inventory_incomplete:${reason}`);
    },
  );

  it("fails closed on endless and overflowing inventories", async () => {
    let page = 0;
    const endless = new RenderApiAdapter(
      "redacted",
      vi.fn(async () =>
        json([
          {
            service: {
              id: `srv-${page}`,
              ownerId: "tea-1",
              type: "web_service",
              suspended: "suspended",
              autoDeploy: "no",
              serviceDetails: {},
            },
            cursor: `cursor-${++page}`,
          },
        ]),
      ),
      undefined,
      { maxPages: 2, maxItems: 10 },
    );
    await expect(endless.listAllServices()).rejects.toThrow(
      "render_inventory_incomplete:max_pages",
    );
    const overflow = new RenderApiAdapter(
      "redacted",
      vi.fn(async () =>
        json(
          ["one", "two"].map((id) => ({
            service: {
              id,
              ownerId: "tea-1",
              type: "web_service",
              suspended: "suspended",
              autoDeploy: "no",
              serviceDetails: {},
            },
            cursor: null,
          })),
        ),
      ),
      undefined,
      { maxPages: 2, maxItems: 1 },
    );
    await expect(overflow.listAllServices()).rejects.toThrow(
      "render_inventory_incomplete:max_items",
    );
  });

  it("accepts additive service/deploy/job fields and cursor wrappers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          id: "srv-1",
          ownerId: "tea-1",
          type: "private_service",
          suspended: "suspended",
          autoDeploy: "no",
          serviceDetails: {},
          additive: true,
        }),
      )
      .mockResolvedValueOnce(
        json([
          {
            deploy: {
              id: "dep-1",
              status: "live",
              image: { sha: `sha256:${"a".repeat(64)}`, ref: "image" },
              additive: true,
            },
            cursor: "next",
          },
        ]),
      )
      .mockResolvedValueOnce(
        json([
          {
            job: {
              id: "job-1",
              serviceId: "srv-1",
              startCommand: "node runner",
              planId: null,
              status: "succeeded",
              additive: true,
            },
            cursor: null,
          },
        ]),
      );
    const api = new RenderApiAdapter("redacted", fetchImpl);
    expect((await api.getService("srv-1")).autoDeploy).toBe("no");
    expect((await api.listDeploys("srv-1")).nextCursor).toBe("next");
    expect((await api.listJobs("srv-1")).items[0]?.id).toBe("job-1");
  });

  it("requires suspend/resume 202", async () => {
    const api = new RenderApiAdapter(
      "redacted",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(new Response(null, { status: 202 })),
    );
    await expect(api.suspend("srv-1")).resolves.toBeUndefined();
    await expect(api.resume("srv-1")).resolves.toBeUndefined();
  });

  it("fails closed on a malformed provider creation timestamp", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(
        {
          id: "job-1",
          serviceId: "srv-1",
          startCommand: "node runner",
          status: "pending",
          createdAt: "not-a-provider-timestamp",
        },
        201,
      ),
    );

    await expect(
      new RenderApiAdapter("redacted", fetchImpl).createJob("srv-1", {
        startCommand: "node runner",
      }),
    ).rejects.toThrow("render_job_response_invalid");
  });

  it("reports a conflict when the environment mutates before the key write", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response(null, { status: 409 })
        : envResponse(
            fetchImpl.mock.calls.length === 1
              ? { DATABASE_URL: "source" }
              : { DATABASE_URL: "concurrent" },
          ),
    );
    const outcome = await new RenderApiAdapter(
      "redacted",
      fetchImpl,
    ).patchEnvPreservingAll({
      serviceId: "srv-1",
      set: { DATABASE_URL: "target" },
      remove: [],
    });
    expect(outcome).toEqual({
      status: "conflict",
      observedEnvironmentSha256: environmentSha256({
        DATABASE_URL: "concurrent",
      }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reports a targeted mutation that races during the key write", async () => {
    let reads = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return json({}, 200);
      reads += 1;
      return envResponse({
        DATABASE_URL: reads < 3 ? "source" : "operator-rotation",
      });
    });
    const outcome = await new RenderApiAdapter(
      "redacted",
      fetchImpl,
    ).patchEnvPreservingAll({
      serviceId: "srv-1",
      set: { DATABASE_URL: "target" },
      remove: [],
    });
    expect(outcome.status).toBe("conflict");
  });

  it("uses one bulk replacement write for the authority permit", async () => {
    const state = { DATABASE_URL: "source", API_TOKEN: "old-secret" };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const replacement = JSON.parse(String(init.body)) as Array<{
          key: string;
          value: string;
        }>;
        for (const key of Object.keys(state))
          delete state[key as keyof typeof state];
        for (const item of replacement)
          state[item.key as keyof typeof state] = item.value;
        return json({}, 200);
      }
      return envResponse(state);
    });
    const outcome = await new RenderApiAdapter(
      "redacted",
      fetchImpl,
    ).patchEnvPreservingAll({
      serviceId: "srv-1",
      set: { DATABASE_URL: "target" },
      remove: [],
    });
    expect(outcome.status).toBe("applied");
    expect(state).toEqual({
      DATABASE_URL: "target",
      API_TOKEN: "old-secret",
    });
    expect(
      fetchImpl.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(1);
  });

  it("reconciles a completed retry as a replay without another write", async () => {
    const desired = { DATABASE_URL: "target", API_TOKEN: "preserved" };
    const fetchImpl = vi.fn(async () => envResponse(desired));
    const outcome = await new RenderApiAdapter(
      "redacted",
      fetchImpl,
    ).patchEnvPreservingAll({
      serviceId: "srv-1",
      set: { DATABASE_URL: "target" },
      remove: [],
      expectedBeforeSha256: environmentSha256({
        DATABASE_URL: "source",
        API_TOKEN: "preserved",
      }),
      expectedAfterSha256: environmentSha256(desired),
    });
    expect(outcome).toEqual(
      expect.objectContaining({
        status: "applied",
        environmentSha256: environmentSha256(desired),
        replayed: true,
      }),
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns an ambiguous outcome when the provider response is lost", async () => {
    const state = { DATABASE_URL: "source" };
    let loseResponse = true;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        state.DATABASE_URL = "target";
        if (loseResponse) {
          loseResponse = false;
          throw new Error("connection reset after request body was sent");
        }
        return json({}, 200);
      }
      return envResponse(state);
    });
    const expectedBeforeSha256 = environmentSha256({ DATABASE_URL: "source" });
    const expectedAfterSha256 = environmentSha256({ DATABASE_URL: "target" });
    const api = new RenderApiAdapter("redacted", fetchImpl);
    const outcome = await api.patchEnvPreservingAll({
      serviceId: "srv-1",
      set: { DATABASE_URL: "target" },
      remove: [],
      expectedBeforeSha256,
      expectedAfterSha256,
    });
    expect(outcome).toEqual({
      status: "ambiguous",
      observedEnvironmentSha256: environmentSha256({ DATABASE_URL: "target" }),
    });
    expect(JSON.stringify(outcome)).not.toContain("target");
    await expect(
      api.patchEnvPreservingAll({
        serviceId: "srv-1",
        set: { DATABASE_URL: "target" },
        remove: [],
        expectedBeforeSha256,
        expectedAfterSha256,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ status: "applied", replayed: true }),
    );
  });

  it("canonically applies key-scoped deletes and puts", async () => {
    const state: Record<string, string> = {
      DELETE_ME: "obsolete",
      PRESERVED: "secret",
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const replacement = JSON.parse(String(init.body)) as Array<{
          key: string;
          value: string;
        }>;
        for (const key of Object.keys(state)) delete state[key];
        for (const item of replacement) state[item.key] = item.value;
        return json({}, 200);
      }
      return envResponse(state);
    });
    const desired = { ADDED: "value", PRESERVED: "secret" };
    const outcome = await new RenderApiAdapter(
      "redacted",
      fetchImpl,
    ).patchEnvPreservingAll({
      serviceId: "srv-1",
      set: { ADDED: "value" },
      remove: ["DELETE_ME"],
      expectedBeforeSha256: environmentSha256(state),
      expectedAfterSha256: environmentSha256(desired),
    });
    expect(outcome).toEqual(
      expect.objectContaining({
        status: "applied",
        environmentSha256: environmentSha256(desired),
        replayed: false,
      }),
    );
    expect(state).toEqual(desired);
    expect(
      fetchImpl.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(true);
  });
});
