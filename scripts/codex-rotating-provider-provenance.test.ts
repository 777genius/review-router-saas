import { describe, expect, it, vi } from "vitest";
import {
  captureGitHubWorkflowDrainProvenance,
  captureRenderMigrationProvenance,
  captureRenderProvenance,
} from "./codex-rotating-provider-provenance.mjs";

const response = (body: unknown, link?: string) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: link ? { link } : undefined,
  });

describe("source-bound provider provenance", () => {
  it("binds exactly one canonical caller output to the Render job inventory", async () => {
    const output = {
      caller: "scripts/run-codex-rotating-release-migration.mjs",
      callerCount: 1,
      commit: "a".repeat(40),
      imageDigest: `sha256:${"b".repeat(64)}`,
      databaseIdentity: "db.internal:5432/review_router",
      status: "succeeded",
    };
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      const values: Record<string, unknown> = {
        "/v1/owners/own-1": { id: "own-1" },
        "/v1/postgres/dpg-db": {
          id: "dpg-db",
          name: "reviewrouter-db",
          version: "17",
          ownerId: "own-1",
        },
        "/v1/services/srv-migration": {
          id: "srv-migration",
          serviceDetails: {
            startCommand: "pnpm codex-rotating:release-migration",
          },
        },
        "/v1/services/srv-migration/deploys/dep-1": {
          id: "dep-1",
          commitId: output.commit,
          imageDigest: output.imageDigest,
        },
        "/v1/services/srv-migration/jobs/job-1": {
          id: "job-1",
          status: "succeeded",
          command: "pnpm codex-rotating:release-migration",
          finishedAt: "2026-08-11T00:00:00Z",
        },
        "/v1/services/srv-migration/jobs": [
          {
            id: "job-1",
            deployId: "dep-1",
            status: "succeeded",
            command: "pnpm codex-rotating:release-migration",
          },
        ],
        "/v1/logs": [{ message: JSON.stringify(output) }],
      };
      return response(values[url.pathname]);
    });
    const observation = await captureRenderMigrationProvenance(
      {
        token: "render-token",
        ownerId: "own-1",
        databaseId: "dpg-db",
        serviceId: "srv-migration",
        deployId: "dep-1",
        jobId: "job-1",
      },
      fetchImpl as typeof fetch,
    );
    expect(observation.migrationCaller).toMatchObject({
      callerCount: 1,
      jobId: "job-1",
      command: "pnpm codex-rotating:release-migration",
    });
    expect(observation.migrationOutput).toEqual(output);
  });

  it("captures authenticated Render identity, raw immutable facts, and an independent runtime witness", async () => {
    const values: Record<string, unknown> = {
      "/v1/owners/own-1": { id: "own-1", name: "production" },
      "/v1/postgres/dpg-db": {
        id: "dpg-db",
        name: "reviewrouter-db",
        version: "17.6",
        ownerId: "own-1",
      },
      "/v1/services/srv-migration": {
        id: "srv-migration",
        name: "reviewrouter-release-migration",
      },
      "/v1/services/srv-migration/deploys/dep-migration": {
        id: "dep-migration",
        commitId: "a".repeat(40),
        imageDigest: `sha256:${"b".repeat(64)}`,
      },
      "/v1/services/srv-migration/jobs/job-migration": {
        id: "job-migration",
        status: "succeeded",
        finishedAt: "2026-08-10T00:00:00Z",
      },
      "/v1/services/srv-migration/jobs": [
        {
          id: "job-migration",
          deployId: "dep-migration",
          command: "pnpm codex-rotating:release-migration",
          status: "succeeded",
          finishedAt: "2026-08-10T00:00:00Z",
        },
      ],
      "/v1/services/srv-api/env-vars/REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS": {
        value: "independent-secret",
      },
    };
    for (const role of ["api", "web", "worker"]) {
      values[`/v1/services/srv-${role}`] = {
        id: `srv-${role}`,
        name: `reviewrouter-${role}`,
      };
      values[`/v1/services/srv-${role}/deploys/dep-${role}`] = {
        id: `dep-${role}`,
        commitId: "a".repeat(40),
        imageDigest: `sha256:${"b".repeat(64)}`,
        status: "live",
        updatedAt: "2026-08-10T00:00:00Z",
      };
      values[
        `/v1/services/srv-${role}/env-vars/REVIEW_ROUTER_CODEX_ROTATING_MUTATION_ADMISSION`
      ] = { value: "off" };
    }
    const fetchImpl = vi.fn(async (input: string | URL) =>
      response(values[new URL(input).pathname]),
    );
    const observation = await captureRenderProvenance(
      {
        token: "render-token",
        ownerId: "own-1",
        databaseId: "dpg-db",
        migration: {
          serviceId: "srv-migration",
          deployId: "dep-migration",
          jobId: "job-migration",
        },
        witnessServiceId: "srv-api",
        services: ["api", "web", "worker"].map((role) => ({
          role,
          serviceId: `srv-${role}`,
          deployId: `dep-${role}`,
        })),
      },
      fetchImpl as typeof fetch,
    );
    expect(observation).toMatchObject({
      observationVersion: 2,
      captureIdentity: { ownerId: "own-1", authenticated: true },
      database: { id: "dpg-db", ownerId: "own-1" },
      runtimeWitness: {
        key: "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(observation.rawResponses.length).toBeGreaterThan(8);
    expect(JSON.stringify(observation)).not.toContain("independent-secret");
  });

  it("paginates both exact GitHub statuses and derives schema versions from raw workflow blobs", async () => {
    const workflowContent = Buffer.from(
      "jobs:\n  review:\n    with:\n      workflow_schema_version: 4\n",
    ).toString("base64");
    let queuedPage = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/user")
        return response({ id: 7, login: "release" });
      if (url.pathname === "/repos/acme/review")
        return response({ id: 99, full_name: "acme/review" });
      if (url.pathname.includes("/contents/"))
        return response({ sha: "c".repeat(40), content: workflowContent });
      const status = url.searchParams.get("status");
      if (status === "queued" && ++queuedPage % 2 === 1) {
        return response({
          workflow_runs: [
            {
              id: 10,
              status: "queued",
              path: ".github/workflows/reviewrouter-codex.yml",
              head_sha: "a".repeat(40),
              event: "pull_request",
              repository: { id: 99 },
            },
          ],
        });
      }
      return response({ workflow_runs: [] });
    });
    const observation = await captureGitHubWorkflowDrainProvenance(
      {
        token: "github-token",
        owner: "acme",
        repository: "review",
        workflow: "reviewrouter-codex.yml",
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        intervalMs: 15_000,
        sleep: async () => undefined,
      },
    );
    expect(observation.observations).toHaveLength(2);
    expect(observation.observations[0].runs[0]).toMatchObject({
      workflowSchemaVersion: 4,
      repositoryId: "99",
    });
    expect(
      fetchImpl.mock.calls.filter(
        ([input]) =>
          new URL(input as string).searchParams.get("status") === "in_progress",
      ),
    ).toHaveLength(2);
  });

  it("rejects a full GitHub page without a next-page link", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/user")
        return response({ id: 7, login: "release" });
      if (url.pathname === "/repos/acme/review")
        return response({ id: 99, full_name: "acme/review" });
      return response({
        workflow_runs: Array.from({ length: 100 }, (_, id) => ({ id })),
      });
    });
    await expect(
      captureGitHubWorkflowDrainProvenance(
        {
          token: "github-token",
          owner: "acme",
          repository: "review",
          workflow: "reviewrouter-codex.yml",
        },
        {
          fetchImpl: fetchImpl as typeof fetch,
          intervalMs: 15_000,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow("without an authoritative final page");
  });
});
