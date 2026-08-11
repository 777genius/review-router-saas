import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  addToEnvironment,
  assertHostedDeployEnv,
  assertMigrationEvidence,
  assertSelectedDatabaseIdentity,
  buildServiceEnv,
  disableAndVerifyPreDeployCommand,
  ensureDatabase,
  ensureService,
  main,
  resolveDistinctDatabaseRoleUrls,
  resolveStableSecuritySecrets,
  serviceDetails,
  syncService,
  triggerAndVerifyDeploy,
  verifyControlPlaneScope,
} from "./deploy-render-hosted-beta.mjs";

describe("Render hosted deploy hardening", () => {
  it("pins PostgreSQL 17 in the Blueprint without service pre-deploy migrations", () => {
    const blueprint = readFileSync("render.yaml", "utf8");
    expect(blueprint).toContain('postgresMajorVersion: "17"');
    expect(blueprint).toContain("user: reviewrouter_release_migration");
    expect(blueprint).not.toContain("preDeployCommand:");
    expect(blueprint).not.toContain("property: connectionString");
    expect(blueprint.match(/autoDeployTrigger: off/g)).toHaveLength(3);
    expect(blueprint).not.toContain("autoDeployTrigger: commit");
  });
  it("creates the hosted database on PostgreSQL 17", async () => {
    const client = {
      list: vi.fn().mockResolvedValue([]),
      request: vi.fn().mockResolvedValue({ id: "pg-1" }),
    };
    await ensureDatabase(client as never, {
      ownerId: "owner-1",
      projectId: "project-1",
      environmentId: "environment-1",
    });
    expect(client.request).toHaveBeenCalledWith(
      "POST",
      "/postgres",
      expect.objectContaining({
        databaseUser: "reviewrouter_release_migration",
        name: "reviewrouter-db",
        version: "17",
      }),
    );
  });

  it("requires four distinct canonical database roles on one database", () => {
    const urls = resolveDistinctDatabaseRoleUrls({
      REVIEW_ROUTER_API_DATABASE_URL:
        "postgresql://reviewrouter_api:a@db.internal/review_router",
      REVIEW_ROUTER_WEB_DATABASE_URL:
        "postgresql://reviewrouter_web:b@db.internal/review_router",
      REVIEW_ROUTER_WORKER_DATABASE_URL:
        "postgresql://reviewrouter_worker:c@db.internal/review_router",
      REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:
        "postgresql://reviewrouter_release_migration:d@db.internal/review_router",
    });
    expect(new URL(urls.api).username).toBe("reviewrouter_api");
    expect(new URL(urls.releaseMigration).username).toBe(
      "reviewrouter_release_migration",
    );
  });

  it.each([
    [
      "forged runtime label",
      {
        REVIEW_ROUTER_API_DATABASE_URL:
          "postgresql://reviewrouter_release_migration:a@db.internal/review_router",
      },
      "must authenticate as reviewrouter_api",
    ],
    [
      "different database",
      {
        REVIEW_ROUTER_API_DATABASE_URL:
          "postgresql://reviewrouter_api:a@other.internal/review_router",
      },
      "must target one database generation",
    ],
  ])("rejects %s database credentials", (_name, override, message) => {
    expect(() =>
      resolveDistinctDatabaseRoleUrls({
        REVIEW_ROUTER_API_DATABASE_URL:
          "postgresql://reviewrouter_api:a@db.internal/review_router",
        REVIEW_ROUTER_WEB_DATABASE_URL:
          "postgresql://reviewrouter_web:b@db.internal/review_router",
        REVIEW_ROUTER_WORKER_DATABASE_URL:
          "postgresql://reviewrouter_worker:c@db.internal/review_router",
        REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:
          "postgresql://reviewrouter_release_migration:d@db.internal/review_router",
        ...override,
      }),
    ).toThrow(message);
  });

  it("rejects an existing hosted database on an older PostgreSQL major", async () => {
    const client = {
      list: vi.fn().mockResolvedValue([
        {
          postgres: {
            id: "pg-legacy",
            name: "reviewrouter-db",
            version: "16",
            ownerId: "owner-1",
            projectId: "project-1",
            environmentId: "environment-1",
          },
        },
      ]),
      request: vi.fn(),
    };
    await expect(
      ensureDatabase(client as never, {
        ownerId: "owner-1",
        projectId: "project-1",
        environmentId: "environment-1",
      }),
    ).rejects.toThrow("must use PostgreSQL 17");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("selects only the same-name database in the exact owner/project/environment", async () => {
    const scoped = {
      id: "pg-production",
      name: "reviewrouter-db",
      version: "17",
      ownerId: "owner-1",
      projectId: "project-1",
      environmentId: "production",
    };
    const client = {
      list: vi.fn().mockResolvedValue([
        {
          postgres: {
            ...scoped,
            id: "pg-staging",
            environmentId: "staging",
          },
        },
        { postgres: scoped },
      ]),
      request: vi.fn(),
    };
    await expect(
      ensureDatabase(client as never, {
        ownerId: "owner-1",
        projectId: "project-1",
        environmentId: "production",
      }),
    ).resolves.toBe(scoped);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("requires the environment to belong to the exact owner and project", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ id: "project-1", ownerId: "owner-1" })
      .mockResolvedValueOnce({
        id: "environment-1",
        ownerId: "owner-1",
        projectId: "other-project",
      });
    await expect(
      verifyControlPlaneScope({ request } as never, {
        ownerId: "owner-1",
        projectId: "project-1",
        environmentId: "environment-1",
      }),
    ).rejects.toThrow("environment does not match requested owner/project");
  });

  it("selects only the same-name service in the exact scope", async () => {
    const scoped = {
      id: "srv-production",
      name: "reviewrouter-api",
      ownerId: "owner-1",
      projectId: "project-1",
      environmentId: "production",
    };
    const client = {
      list: vi.fn().mockResolvedValue([
        {
          service: {
            ...scoped,
            id: "srv-staging",
            environmentId: "staging",
          },
        },
        { service: scoped },
      ]),
      request: vi.fn(),
    };
    await expect(
      ensureService(
        client as never,
        { name: "reviewrouter-api", role: "api", type: "web_service" },
        {
          ownerId: "owner-1",
          projectId: "project-1",
          environmentId: "production",
        } as never,
      ),
    ).resolves.toBe(scoped);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("refuses to skip prepare by creating resources during runtime-deploy", async () => {
    const client = { list: vi.fn().mockResolvedValue([]), request: vi.fn() };
    await expect(
      ensureDatabase(client as never, {
        ownerId: "owner-1",
        projectId: "project-1",
        environmentId: "production",
        allowCreate: false,
      }),
    ).rejects.toThrow("existing database from the prepare phase");
    await expect(
      ensureService(
        client as never,
        { name: "reviewrouter-api", role: "api", type: "web_service" },
        {
          ownerId: "owner-1",
          projectId: "project-1",
          environmentId: "production",
          allowCreate: false,
        } as never,
      ),
    ).rejects.toThrow("existing service reviewrouter-api");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("forces every cutover-sensitive flag dormant despite stale input", () => {
    const result = Object.fromEntries(
      buildServiceEnv({
        databaseUrl: "postgres://internal/db",
        privateKey: "private-key-not-logged",
        role: "api",
        webUrl: "https://reviewrouter.example",
        apiUrl: "https://api.reviewrouter.example",
        env: {
          GITHUB_APP_CLIENT_ID: "client",
          GITHUB_APP_CLIENT_SECRET: "secret",
          GITHUB_APP_ID: "1",
          GITHUB_APP_SLUG: "reviewrouter",
          GITHUB_WEBHOOK_SECRET: "secret",
          AUTH_SECRET: "a".repeat(32),
          REVIEW_ROUTER_ACTION_SESSION_SECRET: "s".repeat(32),
          REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY: "t".repeat(32),
          REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "w".repeat(43),
          REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
          REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED: "1",
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED: "1",
          REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: "1",
          REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED: "1",
          REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: "1",
        },
      }).map(({ key, value }) => [key, value]),
    );
    for (const key of [
      "REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH",
      "REVIEW_ROUTER_CODEX_ROTATING_NEW_WORK_ADMISSION_ENABLED",
      "REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED",
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED",
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED",
      "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED",
    ]) {
      expect(result[key], key).toBe("0");
    }
    expect(
      serviceDetails({ type: "web_service", startCommand: "start" }),
    ).toHaveProperty("preDeployCommand", null);
  });

  it("converges every service on one explicit rotating SHA and recovery witness", () => {
    const witness = "shared-recovery-witness-".padEnd(43, "x");
    const env = {
      GITHUB_APP_CLIENT_ID: "client",
      GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_ID: "1",
      GITHUB_APP_SLUG: "reviewrouter",
      GITHUB_WEBHOOK_SECRET: "secret",
      AUTH_SECRET: "a".repeat(32),
      REVIEW_ROUTER_ACTION_SESSION_SECRET: "s".repeat(32),
      REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY: "t".repeat(32),
      REVIEW_ROUTER_ACTION_REF: "777genius/review-router@main",
      REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
        "777genius/review-router@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS:
        "777genius/review-router@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: witness,
    };
    const results = [];
    for (const role of ["web", "api", "worker", "api"] as const) {
      const values = Object.fromEntries(
        buildServiceEnv({
          databaseUrl: "postgres://internal/db",
          privateKey: "private-key-not-logged",
          role,
          webUrl: "https://reviewrouter.example",
          apiUrl: "https://api.reviewrouter.example",
          env,
        }).map(({ key, value }) => [key, value]),
      );
      expect(values.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS).toBe(witness);
      expect(values.REVIEW_ROUTER_ACTION_REF).toBe(
        "777genius/review-router@main",
      );
      expect(values.REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF).toBe(
        "777genius/review-router@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );
      expect(values.REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS).toBe(
        "777genius/review-router@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      );
      results.push(values);
    }
    for (const key of [
      "AUTH_SECRET",
      "REVIEW_ROUTER_ACTION_SESSION_SECRET",
      "REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY",
      "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
    ]) {
      expect(new Set(results.map((result) => result[key]))).toEqual(
        new Set([env[key as keyof typeof env]]),
      );
    }
  });

  it.each([
    ["missing", undefined],
    ["placeholder", "replace-with-a-strong-random-secret"],
    ["too short", "short"],
  ])("rejects %s stable security secrets", (_name, value) => {
    expect(() =>
      resolveStableSecuritySecrets({
        AUTH_SECRET: value,
        REVIEW_ROUTER_ACTION_SESSION_SECRET: "s".repeat(32),
        REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY: "t".repeat(32),
        REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "w".repeat(43),
      }),
    ).toThrow("AUTH_SECRET");
  });

  it("matches the selected Render database identity to every role URL", () => {
    const urls = resolveDistinctDatabaseRoleUrls({
      REVIEW_ROUTER_API_DATABASE_URL:
        "postgresql://reviewrouter_api:a@DB.INTERNAL./review_router?sslmode=require",
      REVIEW_ROUTER_WEB_DATABASE_URL:
        "postgresql://reviewrouter_web:b@db.internal/review_router",
      REVIEW_ROUTER_WORKER_DATABASE_URL:
        "postgresql://reviewrouter_worker:c@db.internal:5432/review_router",
      REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:
        "postgresql://reviewrouter_release_migration:d@db.internal/review_router",
    });
    expect(
      assertSelectedDatabaseIdentity(
        "postgresql://owner:x@db.internal/review_router",
        urls,
      ),
    ).toBe("db.internal:5432/review_router");
    expect(() =>
      assertSelectedDatabaseIdentity(
        "postgresql://owner:x@other.internal/review_router",
        urls,
      ),
    ).toThrow("selected Render database identity");
  });

  it("revalidates exact scope immediately before a secret PUT", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ id: "project-1", ownerId: "owner-1" })
      .mockResolvedValueOnce({
        id: "production",
        ownerId: "owner-1",
        projectId: "project-1",
      })
      .mockResolvedValueOnce([{ id: "srv-1" }])
      .mockResolvedValueOnce({
        service: {
          id: "srv-1",
          ownerId: "owner-1",
          projectId: "project-1",
          environmentId: "staging",
        },
      });
    await expect(
      syncService(
        { request } as never,
        { id: "srv-1" },
        { name: "reviewrouter-api", role: "api" },
        {
          ownerId: "owner-1",
          projectId: "project-1",
          environmentId: "production",
        } as never,
      ),
    ).rejects.toThrow("environmentId does not match requested scope");
    expect(request).toHaveBeenCalledTimes(4);
    expect(request).not.toHaveBeenCalledWith(
      "PUT",
      expect.anything(),
      expect.anything(),
    );
  });

  it("treats environment linking and its observed membership as fatal", async () => {
    const rejected = {
      request: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("link denied")),
    };
    await expect(
      addToEnvironment(rejected as never, "environment-1", ["srv-1"]),
    ).rejects.toThrow("link denied");

    const missing = {
      request: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce([]),
    };
    await expect(
      addToEnvironment(missing as never, "environment-1", ["srv-1"]),
    ).rejects.toThrow("environment link verification failed for srv-1");
  });

  it("requires exact exclusive migration and coherent role evidence", () => {
    const databaseUrls = resolveDistinctDatabaseRoleUrls({
      REVIEW_ROUTER_API_DATABASE_URL:
        "postgresql://reviewrouter_api:a@db.internal/review_router",
      REVIEW_ROUTER_WEB_DATABASE_URL:
        "postgresql://reviewrouter_web:b@db.internal/review_router",
      REVIEW_ROUTER_WORKER_DATABASE_URL:
        "postgresql://reviewrouter_worker:c@db.internal/review_router",
      REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:
        "postgresql://reviewrouter_release_migration:d@db.internal/review_router",
    });
    const context = {
      scope: {
        ownerId: "owner-1",
        projectId: "project-1",
        environmentId: "environment-1",
      },
      databaseId: "pg-1",
      databaseIdentity: "db.internal:5432/review_router",
      commit: "a".repeat(40),
      imageDigest: `sha256:${"b".repeat(64)}`,
      databaseUrls,
    };
    const evidence = {
      version: 1,
      scope: context.scope,
      release: {
        commit: context.commit,
        imageDigest: context.imageDigest,
      },
      database: {
        id: context.databaseId,
        postgresMajorVersion: "17",
        identity: context.databaseIdentity,
      },
      exclusiveMigration: {
        jobId: "job-1",
        callerCount: 1,
        status: "succeeded",
        preflightStatus: "passed",
        migrationStatus: "succeeded",
        evidenceStatus: "verified",
      },
      runtimeRoles: Object.entries(databaseUrls).map(([role, url]) => ({
        role,
        username: new URL(url).username,
        databaseIdentity: context.databaseIdentity,
        login: true,
        canSetReleaseRole: false,
      })),
    };
    expect(assertMigrationEvidence(evidence, context)).toBe(evidence);
    expect(() =>
      assertMigrationEvidence(
        {
          ...evidence,
          exclusiveMigration: {
            ...evidence.exclusiveMigration,
            callerCount: 2,
          },
        },
        context,
      ),
    ).toThrow("one successful exclusive");
    expect(() =>
      assertMigrationEvidence(
        {
          ...evidence,
          runtimeRoles: evidence.runtimeRoles.map((role, index) =>
            index === 0 ? { ...role, canSetReleaseRole: true } : role,
          ),
        },
        context,
      ),
    ).toThrow("role verification failed");
  });

  it("fails closed on an absent or invalid witness without echoing it", () => {
    const base = {
      GITHUB_APP_CLIENT_ID: "client",
      GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_ID: "1",
      GITHUB_APP_SLUG: "reviewrouter",
      GITHUB_WEBHOOK_SECRET: "secret",
      AUTH_SECRET: "a".repeat(32),
      REVIEW_ROUTER_ACTION_SESSION_SECRET: "s".repeat(32),
      REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY: "t".repeat(32),
      REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
        "777genius/review-router@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    vi.stubEnv("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS", "");
    expect(() =>
      buildServiceEnv({
        databaseUrl: "postgres://internal/db",
        privateKey: "private-key-not-logged",
        role: "api",
        webUrl: "https://reviewrouter.example",
        apiUrl: "https://api.reviewrouter.example",
        env: base,
      }),
    ).toThrow(
      "Missing required value: REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
    );

    const invalid = "secret-that-must-never-be-logged";
    try {
      buildServiceEnv({
        databaseUrl: "postgres://internal/db",
        privateKey: "private-key-not-logged",
        role: "api",
        webUrl: "https://reviewrouter.example",
        apiUrl: "https://api.reviewrouter.example",
        env: {
          ...base,
          REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: invalid,
        },
      });
      throw new Error("expected invalid witness");
    } catch (error) {
      expect(String(error)).not.toContain(invalid);
      expect(String(error)).toContain(
        "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
      );
    }
    vi.unstubAllEnvs();
  });

  it("rejects a missing witness before any hosted API request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const [name, value] of Object.entries({
      REVIEW_ROUTER_RENDER_ENV_FILE: "/tmp/reviewrouter-missing-env-file",
      RENDER_OWNER_ID: "owner-1",
      RENDER_PROJECT_ID: "project-1",
      RENDER_ENVIRONMENT_ID: "environment-1",
      REVIEW_ROUTER_RENDER_PHASE: "prepare",
      RENDER_REPO: "https://github.com/777genius/review-router-saas",
      REVIEW_ROUTER_RENDER_COMMIT_SHA: "a".repeat(40),
      REVIEW_ROUTER_RENDER_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
      REVIEW_ROUTER_WEB_URL: "https://reviewrouter.example",
      REVIEW_ROUTER_API_URL: "https://api.reviewrouter.example",
      REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
        "777genius/review-router@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "",
      AUTH_SECRET: "a".repeat(32),
      REVIEW_ROUTER_ACTION_SESSION_SECRET: "s".repeat(32),
      REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY: "t".repeat(32),
    })) {
      vi.stubEnv(name, value);
    }

    await expect(main()).rejects.toThrow(
      "Missing required value: REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rejects production loopback aliases even with the local-env override", () => {
    for (const apiUrl of [
      "https://127.0.0.2",
      "https://127.255.255.255",
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:7f00:1]",
      "https://service.localhost.",
    ]) {
      expect(() =>
        assertHostedDeployEnv({
          apiUrl,
          webUrl: "https://reviewrouter.example",
          envFile: ".env.production",
          env: { REVIEW_ROUTER_ALLOW_LOCAL_DEPLOY_ENV: "1" },
        }),
      ).toThrow("REVIEW_ROUTER_API_URL");
    }
  });

  it("PATCHes an existing migration hook off and GET-verifies null", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        autoDeployTrigger: "off",
        serviceDetails: { preDeployCommand: null },
      });
    await disableAndVerifyPreDeployCommand({ request } as never, {
      id: "srv-1",
      name: "api",
    });
    expect(request.mock.calls).toEqual([
      [
        "PATCH",
        "/services/srv-1",
        {
          autoDeployTrigger: "off",
          serviceDetails: { preDeployCommand: null },
        },
      ],
      ["GET", "/services/srv-1"],
    ]);
  });

  it("aborts before deploy when the canonical null GET check fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        serviceDetails: { preDeployCommand: "pnpm db:migrate" },
      });
    await expect(
      disableAndVerifyPreDeployCommand({ request } as never, {
        id: "srv-1",
        name: "api",
      }),
    ).rejects.toThrow("preDeployCommand is not canonical null");
  });

  it.each([
    [
      "commit",
      "a".repeat(40),
      `sha256:${"c".repeat(64)}`,
      "resolved commit mismatch",
    ],
    [
      "image",
      "b".repeat(40),
      `sha256:${"d".repeat(64)}`,
      "resolved image digest mismatch",
    ],
  ])(
    "aborts on resolved %s mismatch",
    async (_kind, observedCommit, observedImage, message) => {
      const expectedCommit = "b".repeat(40);
      const expectedImage = `sha256:${"c".repeat(64)}`;
      const request = vi
        .fn()
        .mockResolvedValueOnce({ id: "dep-1" })
        .mockResolvedValueOnce({
          id: "dep-1",
          status: "live",
          commitId: observedCommit,
          imageDigest: observedImage,
        });
      await expect(
        triggerAndVerifyDeploy(
          { request } as never,
          { id: "srv-1", name: "api" },
          {
            commit: expectedCommit,
            imageDigest: expectedImage,
            maxAttempts: 1,
          },
        ),
      ).rejects.toThrow(message);
    },
  );

  it("waits for the resolved deploy identifier and exact immutable facts", async () => {
    const commit = "a".repeat(40);
    const imageDigest = `sha256:${"b".repeat(64)}`;
    const request = vi
      .fn()
      .mockResolvedValueOnce({ deploy: { id: "dep-1" } })
      .mockResolvedValueOnce({ id: "dep-1", status: "building" })
      .mockResolvedValueOnce({
        id: "dep-1",
        status: "live",
        commitId: commit,
        imageDigest,
      });
    const poll = vi.fn(async () => undefined);
    await expect(
      triggerAndVerifyDeploy(
        { request } as never,
        { id: "srv-1", name: "api" },
        { commit, imageDigest, poll, maxAttempts: 2 },
      ),
    ).resolves.toMatchObject({ id: "dep-1", commit, imageDigest });
    expect(poll).toHaveBeenCalledOnce();
  });

  it("aborts when Render does not return a deploy identifier", async () => {
    await expect(
      triggerAndVerifyDeploy(
        { request: vi.fn().mockResolvedValue({}) } as never,
        { id: "srv-1", name: "api" },
        {
          commit: "a".repeat(40),
          imageDigest: `sha256:${"b".repeat(64)}`,
        },
      ),
    ).rejects.toThrow("did not return a deploy id");
  });

  it("aborts on terminal Render status or an unresolved deploy", async () => {
    const terminal = vi
      .fn()
      .mockResolvedValueOnce({ id: "dep-1" })
      .mockResolvedValueOnce({ id: "dep-1", status: "build_failed" });
    await expect(
      triggerAndVerifyDeploy(
        { request: terminal } as never,
        { id: "srv-1", name: "api" },
        {
          commit: "a".repeat(40),
          imageDigest: `sha256:${"b".repeat(64)}`,
          maxAttempts: 1,
        },
      ),
    ).rejects.toThrow("deploy terminated as build_failed");

    const unresolved = vi
      .fn()
      .mockResolvedValueOnce({ id: "dep-2" })
      .mockResolvedValueOnce({ id: "dep-2", status: "building" });
    await expect(
      triggerAndVerifyDeploy(
        { request: unresolved } as never,
        { id: "srv-1", name: "api" },
        {
          commit: "a".repeat(40),
          imageDigest: `sha256:${"b".repeat(64)}`,
          poll: async () => undefined,
          maxAttempts: 1,
        },
      ),
    ).rejects.toThrow("deploy did not resolve");
  });
});
