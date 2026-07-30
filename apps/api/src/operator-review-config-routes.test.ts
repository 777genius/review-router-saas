import { createHash } from "node:crypto";
import Fastify from "fastify";
import {
  HashedReviewConfigurationOperatorAuthorization,
  reviewConfigurationTargetKey,
  resolveReviewConfiguration,
  ReviewConfigurationWriteConflictError,
  type OperatorReviewConfigurationDependencies,
  type PersistedReviewConfiguration,
  type ReviewConfigurationRepositoryPort,
} from "@reviewrouter/features-review-config";
import { afterEach, describe, expect, it } from "vitest";
import { registerOperatorReviewConfigRoutes } from "./operator-review-config-routes.js";

const credential = "route-operator-credential-with-32-characters";

function createDependencies(): OperatorReviewConfigurationDependencies {
  const versions = new Map<string, PersistedReviewConfiguration[]>();
  const configurations: ReviewConfigurationRepositoryPort = {
    async findLatest(target) {
      return versions.get(reviewConfigurationTargetKey(target))?.at(-1) ?? null;
    },
    async saveNextVersion(input) {
      const key = reviewConfigurationTargetKey(input.target);
      const records = versions.get(key) ?? [];
      if (
        input.expectedVersion !== undefined &&
        (records.at(-1)?.version ?? null) !== input.expectedVersion
      ) {
        throw new ReviewConfigurationWriteConflictError();
      }
      const persisted = {
        version: (records.at(-1)?.version ?? 0) + 1,
        config: input.config,
      };
      versions.set(key, [...records, persisted]);
      return persisted;
    },
    async deleteTarget(target) {
      return versions.delete(reviewConfigurationTargetKey(target));
    },
  };
  const mutations: OperatorReviewConfigurationDependencies["mutations"] = {
    async commit(input) {
      const current = await resolveReviewConfiguration(input.target, {
        configurations,
      });
      if (current.revisionToken !== input.expectedRevisionToken) {
        throw new ReviewConfigurationWriteConflictError();
      }
      return configurations.saveNextVersion({
        target: input.target,
        config: input.config,
        expectedVersion:
          current.source === "repository" ? current.version : null,
      });
    },
  };
  return {
    authorization: new HashedReviewConfigurationOperatorAuthorization(
      "operator:route-test",
      createHash("sha256").update(credential).digest("hex"),
    ),
    repositories: {
      async findActiveCandidates(input) {
        return input.repositoryFullName.toLowerCase() === "777genius/example"
          ? [
              {
                id: "repo_1",
                workspaceId: "workspace_1",
                workspaceSlug: "workspace-one",
                provider: "github",
                sourceBaseUrl: "https://github.com",
                fullName: "777genius/example",
              },
            ]
          : [];
      },
    },
    rateLimits: {
      async consume() {
        return true;
      },
    },
    configurations,
    mutations,
    audit: {
      async record() {},
    },
  };
}

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp() {
  const app = Fastify({ logger: false });
  apps.push(app);
  await registerOperatorReviewConfigRoutes(app, createDependencies());
  return app;
}

describe("operator review config routes", () => {
  it("requires a valid bearer credential", async () => {
    const app = await createApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/operator/v1/review-config?repo=777genius/example",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: "unauthorized" } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("sets and reads a repository-specific effort", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const dependencies = createDependencies();
    await registerOperatorReviewConfigRoutes(app, dependencies);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/operator/v1/review-config",
      headers: { authorization: `Bearer ${credential}` },
      payload: {
        repository: "777genius/example",
        effort: "high",
      },
    });
    const get = await app.inject({
      method: "GET",
      url: "/api/operator/v1/review-config?repo=777genius/example",
      headers: { authorization: `Bearer ${credential}` },
    });

    expect(patch.statusCode).toBe(200);
    expect(patch.json().result).toMatchObject({
      changed: true,
      source: "repository",
      reasoningEffort: "high",
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().result).toMatchObject({
      source: "repository",
      reasoningEffort: "high",
    });
  });

  it("rejects invalid input and reports an unknown repository", async () => {
    const app = await createApp();
    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/operator/v1/review-config",
      headers: { authorization: `Bearer ${credential}` },
      payload: {
        repository: "777genius/example",
        effort: "ultra",
      },
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/operator/v1/review-config?repo=777genius/missing",
      headers: { authorization: `Bearer ${credential}` },
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: { code: "invalid_request" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: "repository_not_found" },
    });
  });
});
