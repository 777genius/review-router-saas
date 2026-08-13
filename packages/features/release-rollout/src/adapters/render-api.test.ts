import { describe, expect, it, vi } from "vitest";
import { RenderApiAdapter } from "./render-api";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

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

  it("preserves every env value and verifies the complete replacement digest", async () => {
    const first = [
      {
        envVar: { key: "SECRET_UNCHANGED", value: "never-log-this" },
        cursor: null,
      },
      { envVar: { key: "DATABASE_HOST", value: "old.internal" }, cursor: null },
    ];
    const after = [
      {
        envVar: { key: "DATABASE_HOST", value: "target.internal" },
        cursor: null,
      },
      {
        envVar: { key: "SECRET_UNCHANGED", value: "never-log-this" },
        cursor: null,
      },
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json({}, 200))
      .mockResolvedValueOnce(json(after));
    const result = await new RenderApiAdapter(
      "redacted",
      fetchImpl,
    ).replaceEnvPreservingAll("srv-1", { DATABASE_HOST: "target.internal" });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual([
      { key: "DATABASE_HOST", value: "target.internal" },
      { key: "SECRET_UNCHANGED", value: "never-log-this" },
    ]);
    expect(result.beforeSha256).not.toBe(result.afterSha256);
  });

  it("aborts a delta PUT when the second pre-write snapshot changed", async () => {
    const initial = [
      { envVar: { key: "DATABASE_URL", value: "source" }, cursor: null },
    ];
    const changed = [
      { envVar: { key: "DATABASE_URL", value: "concurrent" }, cursor: null },
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(initial))
      .mockResolvedValueOnce(json(changed));
    await expect(
      new RenderApiAdapter("redacted", fetchImpl).patchEnvPreservingAll({
        serviceId: "srv-1",
        set: { DATABASE_URL: "target" },
        remove: [],
      }),
    ).rejects.toThrow("concurrent_mutation");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
