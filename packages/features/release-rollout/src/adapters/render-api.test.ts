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
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(envResponse({ DATABASE_URL: "source" }))
      .mockResolvedValueOnce(envResponse({ DATABASE_URL: "concurrent" }));
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
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

  it("never reverts an unrelated credential rotation during a key write", async () => {
    const state = { DATABASE_URL: "source", API_TOKEN: "old-secret" };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        state.DATABASE_URL = JSON.parse(String(init.body)).value as string;
        state.API_TOKEN = "rotated-secret";
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
    expect(outcome.status).toBe("conflict");
    expect(state).toEqual({
      DATABASE_URL: "target",
      API_TOKEN: "rotated-secret",
    });
    expect(String(fetchImpl.mock.calls[2]?.[1]?.body)).not.toContain(
      "rotated-secret",
    );
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
      const key = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
      if (init?.method === "DELETE") {
        delete state[key];
        return new Response(null, { status: 204 });
      }
      if (init?.method === "PUT") {
        state[key] = JSON.parse(String(init.body)).value as string;
        return json({}, 200);
      }
      if (init?.method === "POST") {
        const created = JSON.parse(String(init.body)) as {
          key: string;
          value: string;
        };
        state[created.key] = created.value;
        return json({}, 201);
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
      fetchImpl.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(true);
  });
});
