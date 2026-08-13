import { describe, expect, it, vi } from "vitest";
import {
  captureGitHubWorkflowDrainProvenance,
  captureRenderDatabaseProvenance,
  captureRenderProvenance,
} from "./codex-rotating-provider-provenance.mjs";

const response = (body: unknown, link?: string) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: link ? { link } : undefined,
  });

describe("source-bound provider provenance", () => {
  it("captures only the authenticated Render owner and database identity for migration evidence", async () => {
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
      };
      return response(values[url.pathname]);
    });
    const observation = await captureRenderDatabaseProvenance(
      {
        token: "render-token",
        ownerId: "own-1",
        databaseId: "dpg-db",
      },
      fetchImpl as typeof fetch,
    );
    expect(observation).toMatchObject({
      observationVersion: 4,
      captureIdentity: { ownerId: "own-1", authenticated: true },
      database: { id: "dpg-db", ownerId: "own-1", version: "17" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
      "/v1/services/srv-witness/env-vars/REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS":
        {
          value: "independent-secret",
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
    };
    for (const role of ["api", "web", "worker"]) {
      values[`/v1/services/srv-${role}`] = {
        id: `srv-${role}`,
        name: `reviewrouter-${role}`,
        serviceDetails: {
          envSpecificDetails: { preDeployCommand: "" },
        },
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
      values[
        `/v1/services/srv-${role}/env-vars/REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS`
      ] = { value: "independent-secret" };
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
        witnessServiceId: "srv-witness",
        services: ["api", "web", "worker"].map((role) => ({
          role,
          serviceId: `srv-${role}`,
          deployId: `dep-${role}`,
        })),
      },
      fetchImpl as typeof fetch,
    );
    expect(observation).toMatchObject({
      observationVersion: 3,
      captureIdentity: { ownerId: "own-1", authenticated: true },
      database: { id: "dpg-db", ownerId: "own-1" },
      runtimeWitness: {
        key: "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        observations: expect.arrayContaining([
          expect.objectContaining({
            role: "witness",
            serviceId: "srv-witness",
          }),
          expect.objectContaining({ role: "api", serviceId: "srv-api" }),
          expect.objectContaining({ role: "web", serviceId: "srv-web" }),
          expect.objectContaining({ role: "worker", serviceId: "srv-worker" }),
        ]),
      },
      services: expect.arrayContaining([
        expect.objectContaining({
          preDeployCommand: null,
          serviceMigrationCallerEnabled: false,
        }),
      ]),
    });
    expect(observation.rawResponses.length).toBeGreaterThan(8);
    expect(observation.runtimeWitness.observations).toHaveLength(8);
    expect(
      new Set(
        observation.runtimeWitness.observations.map(
          (entry: any) => `${entry.phase}:${entry.role}`,
        ),
      ),
    ).toEqual(
      new Set(
        ["before", "after"].flatMap((phase) =>
          ["api", "web", "worker", "witness"].map((role) => `${phase}:${role}`),
        ),
      ),
    );
    expect(JSON.stringify(observation)).not.toContain("independent-secret");

    values[
      "/v1/services/srv-worker/env-vars/REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS"
    ] = { value: "substituted-secret" };
    await expect(
      captureRenderProvenance(
        {
          token: "render-token",
          ownerId: "own-1",
          databaseId: "dpg-db",
          witnessServiceId: "srv-witness",
          services: ["api", "web", "worker"].map((role) => ({
            role,
            serviceId: `srv-${role}`,
            deployId: `dep-${role}`,
          })),
        },
        fetchImpl as typeof fetch,
      ),
    ).rejects.toThrow("runtime witnesses do not converge");
    values[
      "/v1/services/srv-worker/env-vars/REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS"
    ] = { value: "independent-secret" };

    let apiWitnessCaptures = 0;
    const mixedFetch = vi.fn(async (input: string | URL) => {
      const path = new URL(input).pathname;
      if (
        path ===
          "/v1/services/srv-api/env-vars/REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS" &&
        ++apiWitnessCaptures === 2
      )
        return response({ value: "late-substitution" });
      return response(values[path]);
    });
    await expect(
      captureRenderProvenance(
        {
          token: "render-token",
          ownerId: "own-1",
          databaseId: "dpg-db",
          witnessServiceId: "srv-witness",
          services: ["api", "web", "worker"].map((role) => ({
            role,
            serviceId: `srv-${role}`,
            deployId: `dep-${role}`,
          })),
        },
        mixedFetch as typeof fetch,
      ),
    ).rejects.toThrow("runtime witnesses do not converge");

    values["/v1/services/srv-api"] = {
      ...values["/v1/services/srv-api"],
      id: "srv-substituted",
    };
    await expect(
      captureRenderProvenance(
        {
          token: "render-token",
          ownerId: "own-1",
          databaseId: "dpg-db",
          witnessServiceId: "srv-witness",
          services: ["api", "web", "worker"].map((role) => ({
            role,
            serviceId: `srv-${role}`,
            deployId: `dep-${role}`,
          })),
        },
        fetchImpl as typeof fetch,
      ),
    ).rejects.toThrow("service or deploy identity was substituted");

    values["/v1/services/srv-api"] = {
      id: "srv-api",
      name: "reviewrouter-api",
      serviceDetails: {
        envSpecificDetails: { preDeployCommand: "pnpm db:migrate" },
      },
    };
    const enabledHookObservation = await captureRenderProvenance(
      {
        token: "render-token",
        ownerId: "own-1",
        databaseId: "dpg-db",
        migration: {
          serviceId: "srv-migration",
          deployId: "dep-migration",
          jobId: "job-migration",
        },
        witnessServiceId: "srv-witness",
        services: ["api", "web", "worker"].map((role) => ({
          role,
          serviceId: `srv-${role}`,
          deployId: `dep-${role}`,
        })),
      },
      fetchImpl as typeof fetch,
    );
    expect(enabledHookObservation.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "api",
          preDeployCommand: "pnpm db:migrate",
          serviceMigrationCallerEnabled: true,
        }),
      ]),
    );
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
