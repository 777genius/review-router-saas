import { describe, expect, it, vi } from "vitest";
import { runRenderMigrationJob } from "./run-render-codex-rotating-migration-job.mjs";

const environment = {
  REVIEW_ROUTER_RENDER_MIGRATION_SERVICE_ID: "srv-migration",
  RENDER_API_KEY: "render-token-never-logged",
  REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:
    "postgres://release:secret@db/app",
  REVIEW_ROUTER_API_DATABASE_URL: "postgres://api:secret@db/app",
  REVIEW_ROUTER_WEB_DATABASE_URL: "postgres://web:secret@db/app",
  REVIEW_ROUTER_WORKER_DATABASE_URL: "postgres://worker:secret@db/app",
  REVIEW_ROUTER_RENDER_COMMIT_SHA: "a".repeat(40),
  REVIEW_ROUTER_RENDER_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
};

const response = (value: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});

describe("exclusive Render migration job initiator", () => {
  it("creates one canonical command only after observing no active caller", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ jobs: [] }))
      .mockResolvedValueOnce(response({ id: "job-1" }, 201))
      .mockResolvedValueOnce(response({ id: "job-1", status: "succeeded" }));
    await expect(
      runRenderMigrationJob(environment, {
        fetchImpl: fetchImpl as never,
        poll: async () => undefined,
      }),
    ).resolves.toEqual({ jobId: "job-1", status: "succeeded" });
    const create = fetchImpl.mock.calls[1];
    expect(JSON.parse(create[1].body)).toMatchObject({
      startCommand: "pnpm codex-rotating:release-migration",
    });
  });

  it("fails before creation when provider observation is missing or another caller is active", async () => {
    const missing = vi.fn().mockResolvedValue(response({}, 503));
    await expect(
      runRenderMigrationJob(environment, { fetchImpl: missing as never }),
    ).rejects.toThrow("inventory_failed:503");
    expect(missing).toHaveBeenCalledOnce();

    const active = vi
      .fn()
      .mockResolvedValue(
        response({ jobs: [{ id: "job-old", status: "running" }] }),
      );
    await expect(
      runRenderMigrationJob(environment, { fetchImpl: active as never }),
    ).rejects.toThrow("exclusive_caller_already_active");
    expect(active).toHaveBeenCalledOnce();
  });
});
