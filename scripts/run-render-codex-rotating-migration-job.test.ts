import { describe, expect, it, vi } from "vitest";
import {
  runRenderMigrationJob,
  runRenderRoleBootstrapJob,
} from "./run-render-codex-rotating-migration-job.mjs";

const environment = {
  REVIEW_ROUTER_RENDER_MIGRATION_SERVICE_ID: "srv-migration",
  REVIEW_ROUTER_RENDER_MIGRATION_DEPLOY_ID: "dep-migration",
  RENDER_API_KEY: "render-token-never-logged",
  REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL:
    "postgres://bootstrap:secret@db/app",
  REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:
    "postgres://release:secret@db/app",
  REVIEW_ROUTER_API_DATABASE_URL: "postgres://api:secret@db/app",
  REVIEW_ROUTER_WEB_DATABASE_URL: "postgres://web:secret@db/app",
  REVIEW_ROUTER_WORKER_DATABASE_URL: "postgres://worker:secret@db/app",
  REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
    "postgres://effect:secret@db/app",
  REVIEW_ROUTER_RENDER_COMMIT_SHA: "a".repeat(40),
  REVIEW_ROUTER_RENDER_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
};

const response = (value: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});

const immutableService = { id: "srv-migration", autoDeployTrigger: "off" };
const immutableDeploy = {
  id: "dep-migration",
  status: "live",
  commit: { id: "a".repeat(40) },
  image: { digest: `sha256:${"b".repeat(64)}` },
};

describe("exclusive Render migration job initiator", () => {
  it("creates one canonical command only after observing no active caller", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(immutableService))
      .mockResolvedValueOnce(response(immutableDeploy))
      .mockResolvedValueOnce(response({ jobs: [] }))
      .mockResolvedValueOnce(
        response({ id: "job-1", deployId: "dep-migration" }, 201),
      )
      .mockResolvedValueOnce(
        response({
          id: "job-1",
          deployId: "dep-migration",
          status: "succeeded",
        }),
      );
    await expect(
      runRenderMigrationJob(environment, {
        fetchImpl: fetchImpl as never,
        poll: async () => undefined,
      }),
    ).resolves.toEqual({
      deployId: "dep-migration",
      jobId: "job-1",
      status: "succeeded",
    });
    const create = fetchImpl.mock.calls[3];
    expect(JSON.parse(create[1].body)).toMatchObject({
      startCommand: "pnpm codex-rotating:release-migration",
    });
    const envVars = JSON.parse(create[1].body).envVars;
    expect(envVars).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL",
        }),
      ]),
    );
    expect(envVars).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL",
        }),
      ]),
    );
  });

  it("isolates bootstrap authority in the dedicated manual job", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(immutableService))
      .mockResolvedValueOnce(response(immutableDeploy))
      .mockResolvedValueOnce(response({ jobs: [] }))
      .mockResolvedValueOnce(
        response({ id: "job-bootstrap", deployId: "dep-migration" }, 201),
      )
      .mockResolvedValueOnce(
        response({
          id: "job-bootstrap",
          deployId: "dep-migration",
          status: "succeeded",
        }),
      );
    await runRenderRoleBootstrapJob(environment, {
      fetchImpl: fetchImpl as never,
      poll: async () => undefined,
    });
    const create = JSON.parse(fetchImpl.mock.calls[3][1].body);
    expect(create.startCommand).toBe("pnpm codex-rotating:role-bootstrap");
    expect(create.envVars).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL",
        }),
      ]),
    );
  });

  it("fails before creation when provider observation is missing or another caller is active", async () => {
    const missing = vi.fn().mockResolvedValue(response({}, 503));
    await expect(
      runRenderMigrationJob(environment, { fetchImpl: missing as never }),
    ).rejects.toThrow("service_failed:503");
    expect(missing).toHaveBeenCalledOnce();

    const active = vi
      .fn()
      .mockResolvedValueOnce(response(immutableService))
      .mockResolvedValueOnce(response(immutableDeploy))
      .mockResolvedValue(
        response({ jobs: [{ id: "job-old", status: "running" }] }),
      );
    await expect(
      runRenderMigrationJob(environment, { fetchImpl: active as never }),
    ).rejects.toThrow("exclusive_caller_already_active");
    expect(active).toHaveBeenCalledTimes(3);
  });

  it("fails before mutation when the pinned deploy is not immutable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(immutableService))
      .mockResolvedValueOnce(
        response({ ...immutableDeploy, commit: { id: "c".repeat(40) } }),
      );
    await expect(
      runRenderMigrationJob(environment, { fetchImpl: fetchImpl as never }),
    ).rejects.toThrow("deploy_identity_mismatch");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
