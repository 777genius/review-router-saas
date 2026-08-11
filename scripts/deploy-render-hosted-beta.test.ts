import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProviderJson } from "./codex-rotating-provider-provenance.mjs";
import {
  addToEnvironment,
  assertHostedDeployEnv,
  assertMigrationEvidence,
  assertMigrationEvidencePayload,
  assertSelectedDatabaseIdentity,
  buildServiceEnv,
  disableAndVerifyPreDeployCommand,
  ensureDatabase,
  ensureService,
  main,
  parseHostedDeployDotenv,
  readVerifiedInstallerReleaseDescriptor,
  resolveDistinctDatabaseRoleUrls,
  resolveStableSecuritySecrets,
  serviceDetails,
  syncService,
  triggerAndVerifyDeploy,
  verifyControlPlaneScope,
  verifyServiceEnvConvergence,
  withoutRoleBootstrapCredential,
} from "./deploy-render-hosted-beta.mjs";

const actionSha = "0123456789abcdef0123456789abcdef01234567";
const actionRef = `777genius/review-router@${actionSha}`;
const installerTuple = Object.freeze({
  REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: `https://raw.githubusercontent.com/777genius/review-router/${actionSha}/scripts/seed-codex-rotating-auth.sh`,
  REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: "v1.2.3",
  REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: "c".repeat(64),
});

function releaseDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "reviewrouter.codex-rotating-installer-descriptor.v1",
    url: installerTuple.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL,
    version: installerTuple.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION,
    sha256: installerTuple.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256,
    actionRef,
    reseed: {
      url: `https://raw.githubusercontent.com/777genius/review-router/${actionSha}/scripts/reseed-codex-rotating-auth.sh`,
      sha256: "d".repeat(64),
    },
    ...overrides,
  };
}

function descriptorFixture() {
  const directory = mkdtempSync(join(tmpdir(), "render-installer-descriptor-"));
  const file = join(directory, "descriptor.json");
  const bytes = `${JSON.stringify(releaseDescriptor(), null, 2)}\n`;
  writeFileSync(file, bytes);
  return {
    directory,
    file,
    env: {
      REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: actionRef,
      REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_DESCRIPTOR_FILE: file,
      REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_DESCRIPTOR_SHA256: createHash(
        "sha256",
      )
        .update(bytes)
        .digest("hex"),
    },
  };
}

describe("Render hosted deploy hardening", () => {
  it("keeps beta and agent entry points on dashboard-issued rotating setup and recovery", () => {
    const guidance = ["ai-docs/BETA_RUNBOOK.md", "ai-docs/AGENT_START_HERE.md"]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(guidance).not.toMatch(
      /CODEX_AUTH_JSON|\/install\/codex|gh secret set/u,
    );
    expect(guidance).not.toMatch(/curl[^\n]*\|[^\n]*(?:bash|sh)/u);
    expect(guidance).toContain("dashboard-issued command");
    expect(guidance).toContain("Recover and issue forced reseed");
    expect(guidance).toContain("operations/02-runbooks.md");
  });

  it("checks in immutable exclusive migration and rollout evidence workflows", () => {
    const migration = readFileSync(
      ".github/workflows/codex-rotating-release-migration.yml",
      "utf8",
    );
    const rollout = readFileSync(
      ".github/workflows/codex-rotating-rollout-evidence.yml",
      "utf8",
    );
    const bootstrap = readFileSync(
      ".github/workflows/codex-rotating-role-bootstrap.yml",
      "utf8",
    );
    expect(migration).toContain(
      "node scripts/run-codex-rotating-release-migration.mjs > migration-output.json",
    );
    expect(migration).toContain(
      "group: codex-rotating-database-mutation-production",
    );
    expect(migration).not.toContain("run-render-codex-rotating-migration-job");
    expect(bootstrap).toContain(
      "node scripts/run-codex-rotating-role-bootstrap.mjs > role-bootstrap-output.json",
    );
    expect(bootstrap).toContain(
      "group: codex-rotating-database-mutation-production",
    );
    expect(migration).not.toContain(
      "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL",
    );
    expect(bootstrap).toContain("environment: production-role-bootstrap");
    expect(migration).toContain(
      "node scripts/assemble-codex-rotating-trusted-evidence.mjs",
    );
    expect(migration).toContain(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
    expect(rollout).toContain(
      "node scripts/assemble-codex-rotating-trusted-rollout.mjs",
    );
    expect(rollout).not.toContain("MIGRATION_EVIDENCE_FILE");
    expect(`${migration}\n${bootstrap}\n${rollout}`).not.toMatch(
      /actions\/(?:checkout|upload-artifact)@v\d/u,
    );
  });

  it("pins PostgreSQL 17 in the Blueprint without service pre-deploy migrations", () => {
    const blueprint = readFileSync("render.yaml", "utf8");
    expect(blueprint).toContain('postgresMajorVersion: "17"');
    expect(blueprint).toContain("user: reviewrouter_role_bootstrap");
    expect(blueprint).not.toContain("preDeployCommand:");
    expect(blueprint).not.toContain("property: connectionString");
    expect(blueprint.match(/autoDeployTrigger: off/g)).toHaveLength(3);
    expect(blueprint).not.toContain("autoDeployTrigger: commit");
    for (const key of [
      "REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY",
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL",
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION",
      "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256",
    ]) {
      expect(blueprint.match(new RegExp(`key: ${key}`, "g")), key).toHaveLength(
        1,
      );
    }
  });

  it("derives the exact hosted tuple only from a digest-pinned release descriptor", () => {
    const fixture = descriptorFixture();
    try {
      expect(
        readVerifiedInstallerReleaseDescriptor({
          ...fixture.env,
          REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL:
            "https://attacker.invalid/mutable.sh",
          REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: "v9.9.9",
          REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: "0".repeat(64),
        }),
      ).toMatchObject({
        actionRef,
        descriptorSha256:
          fixture.env.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_DESCRIPTOR_SHA256,
        tuple: {
          url: installerTuple.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL,
          version:
            installerTuple.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION,
          sha256: installerTuple.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256,
        },
      });
      writeFileSync(
        fixture.file,
        `${JSON.stringify(releaseDescriptor({ version: "v9.9.9" }))}\n`,
      );
      expect(() => readVerifiedInstallerReleaseDescriptor(fixture.env)).toThrow(
        "release descriptor digest mismatch",
      );
      expect(() =>
        readVerifiedInstallerReleaseDescriptor({
          ...fixture.env,
          REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_DESCRIPTOR_SHA256:
            fixture.env.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_DESCRIPTOR_SHA256.toUpperCase(),
        }),
      ).toThrow("must be an exact lowercase SHA-256");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
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
        databaseUser: "reviewrouter_role_bootstrap",
        name: "reviewrouter-db",
        version: "17",
      }),
    );
  });

  it("requires only the five non-bootstrap deployment database roles", () => {
    const urls = resolveDistinctDatabaseRoleUrls({
      REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL:
        "this-runtime-only-resolver-must-not-parse-bootstrap-secrets",
      REVIEW_ROUTER_API_DATABASE_URL:
        "postgresql://reviewrouter_api:a@db.internal/review_router",
      REVIEW_ROUTER_WEB_DATABASE_URL:
        "postgresql://reviewrouter_web:b@db.internal/review_router",
      REVIEW_ROUTER_WORKER_DATABASE_URL:
        "postgresql://reviewrouter_worker:c@db.internal/review_router",
      REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
        "postgresql://reviewrouter_codex_effect_authority:e@db.internal/review_router",
      REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:
        "postgresql://reviewrouter_release_migration:d@db.internal/review_router",
    });
    expect(new URL(urls.api).username).toBe("reviewrouter_api");
    expect(urls).not.toHaveProperty("roleBootstrap");
    expect(new URL(urls.releaseMigration).username).toBe(
      "reviewrouter_release_migration",
    );
    expect(new URL(urls.codexEffectAuthority).username).toBe(
      "reviewrouter_codex_effect_authority",
    );
    expect(Object.keys(urls)).toHaveLength(5);
    expect(
      withoutRoleBootstrapCredential({
        KEEP: "value",
        REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL: "must-not-be-retained",
      }),
    ).toEqual({ KEEP: "value" });
    expect(
      parseHostedDeployDotenv(
        "KEEP=value\nREVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL='must-not-be-parsed'\n",
      ),
    ).toEqual({ KEEP: "value" });
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
        REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL:
          "postgresql://reviewrouter_role_bootstrap:z@db.internal/review_router",
        REVIEW_ROUTER_API_DATABASE_URL:
          "postgresql://reviewrouter_api:a@db.internal/review_router",
        REVIEW_ROUTER_WEB_DATABASE_URL:
          "postgresql://reviewrouter_web:b@db.internal/review_router",
        REVIEW_ROUTER_WORKER_DATABASE_URL:
          "postgresql://reviewrouter_worker:c@db.internal/review_router",
        REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
          "postgresql://reviewrouter_codex_effect_authority:e@db.internal/review_router",
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
          ...installerTuple,
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
      REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: `https://raw.githubusercontent.com/777genius/review-router/${"a".repeat(40)}/scripts/seed-codex-rotating-auth.sh`,
      REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: "v1.2.3",
      REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: "c".repeat(64),
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: witness,
      REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
        "postgresql://reviewrouter_codex_effect_authority:authority@db.internal/review_router",
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
      expect(values.REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL).toBe(
        role === "api" || role === "web"
          ? env.REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL
          : undefined,
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
    ["missing", ""],
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
      REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL:
        "postgresql://reviewrouter_role_bootstrap:z@db.internal/review_router",
      REVIEW_ROUTER_API_DATABASE_URL:
        "postgresql://reviewrouter_api:a@DB.INTERNAL./review_router?sslmode=require",
      REVIEW_ROUTER_WEB_DATABASE_URL:
        "postgresql://reviewrouter_web:b@db.internal/review_router",
      REVIEW_ROUTER_WORKER_DATABASE_URL:
        "postgresql://reviewrouter_worker:c@db.internal:5432/review_router",
      REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
        "postgresql://reviewrouter_codex_effect_authority:e@db.internal/review_router",
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

  it("re-reads the pinned installer descriptor after scope checks and before the secret PUT", async () => {
    const fixture = descriptorFixture();
    const initial = readVerifiedInstallerReleaseDescriptor(fixture.env);
    let calls = 0;
    const request = vi.fn(async (method: string, endpoint: string) => {
      calls += 1;
      if (endpoint === "/projects/project-1") {
        return { id: "project-1", ownerId: "owner-1" };
      }
      if (endpoint === "/environments/production") {
        return { id: "production", ownerId: "owner-1", projectId: "project-1" };
      }
      if (endpoint === "/environments/production/resources") {
        return [{ id: "srv-1" }];
      }
      if (method === "GET" && endpoint === "/services/srv-1") {
        writeFileSync(
          fixture.file,
          `${JSON.stringify(releaseDescriptor({ version: "v9.9.9" }))}\n`,
        );
        return {
          service: {
            id: "srv-1",
            ownerId: "owner-1",
            projectId: "project-1",
            environmentId: "production",
          },
        };
      }
      throw new Error(`unexpected request ${method} ${endpoint}`);
    });
    try {
      await expect(
        syncService(
          { request } as never,
          { id: "srv-1", name: "reviewrouter-api" },
          { name: "reviewrouter-api", role: "api" },
          {
            ownerId: "owner-1",
            projectId: "project-1",
            environmentId: "production",
            env: fixture.env,
            installerDescriptor: initial,
          } as never,
        ),
      ).rejects.toThrow("release descriptor digest mismatch");
      expect(calls).toBe(4);
      expect(request).not.toHaveBeenCalledWith(
        "PUT",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("GET-verifies exact environment convergence through hosted readiness contracts", async () => {
    const expected = buildServiceEnv({
      databaseUrl: "postgres://internal/db",
      privateKey: "private-key-not-logged",
      role: "worker",
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
        REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "w".repeat(43),
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: actionRef,
        ...installerTuple,
      },
    });
    const client = {
      request: vi
        .fn()
        .mockResolvedValue(expected.map((envVar) => ({ envVar }))),
    };
    await expect(
      verifyServiceEnvConvergence(
        client as never,
        { id: "srv-1", name: "reviewrouter-worker" },
        expected,
      ),
    ).resolves.toBeUndefined();
    client.request.mockResolvedValueOnce(
      expected.map((item) =>
        item.key === "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256"
          ? { ...item, value: "e".repeat(64) }
          : item,
      ),
    );
    await expect(
      verifyServiceEnvConvergence(
        client as never,
        { id: "srv-1", name: "reviewrouter-worker" },
        expected,
      ),
    ).rejects.toThrow(
      "environment did not converge for REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256",
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
      REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL:
        "postgresql://reviewrouter_role_bootstrap:z@db.internal/review_router",
      REVIEW_ROUTER_API_DATABASE_URL:
        "postgresql://reviewrouter_api:a@db.internal/review_router",
      REVIEW_ROUTER_WEB_DATABASE_URL:
        "postgresql://reviewrouter_web:b@db.internal/review_router",
      REVIEW_ROUTER_WORKER_DATABASE_URL:
        "postgresql://reviewrouter_worker:c@db.internal/review_router",
      REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
        "postgresql://reviewrouter_codex_effect_authority:e@db.internal/review_router",
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
    const evidence: any = {
      version: 5,
      rolloutId: "rollout-1",
      execution: {
        repositoryId: "1",
        repositoryFullName: "777genius/review-router-saas",
        workflowPath: ".github/workflows/codex-rotating-release-migration.yml",
        workflowSha: "c".repeat(40),
        workflowRef: context.commit,
        runId: "101",
        runAttempt: 1,
        jobId: "202",
        jobName: "trusted-release-migration",
        artifactName: "reviewrouter-trusted-rollout-101-1",
        headSha: context.commit,
      },
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
      databaseGeneration: {
        systemIdentifier: "7612345678901234567",
        recoveryWitnessSha256: "f".repeat(64),
      },
      migration: {
        callerCount: 1,
        status: "succeeded",
        preflightStatus: "passed",
        migrationStatus: "succeeded",
        evidenceStatus: "verified",
      },
      migrationOutput: {
        caller: "scripts/run-codex-rotating-release-migration.mjs",
        callerCount: 1,
        version: 3,
        commit: context.commit,
        imageDigest: context.imageDigest,
        databaseIdentity: context.databaseIdentity,
        databaseGeneration: {
          systemIdentifier: "7612345678901234567",
          recoveryWitnessSha256: "f".repeat(64),
        },
        status: "succeeded",
        migrationStatus: "succeeded",
        preflightStatus: "passed",
        preflightOutputSha256: "d".repeat(64),
      },
      runtimeRoles: Object.entries(databaseUrls)
        .filter(([role]) => role !== "roleBootstrap")
        .map(([role, url]) => ({
          role,
          username: new URL(url).username,
          databaseIdentity: context.databaseIdentity,
          login: true,
          superuser: false,
          createDatabase: false,
          createRole: false,
          replication: false,
          bypassRls: false,
          canSetReleaseRole: role === "releaseMigration",
        })),
    };
    evidence.migrationOutput.roles = evidence.runtimeRoles.map((role) =>
      Object.fromEntries(
        Object.entries(role).filter(
          ([key]) => !["role", "databaseIdentity"].includes(key),
        ),
      ),
    );
    const digest = (value: unknown) =>
      createHash("sha256")
        .update(Buffer.from(canonicalProviderJson(value)))
        .digest("hex");
    const providerBodies = [
      { id: "owner-1" },
      { id: "pg-1", ownerId: "owner-1", version: "17" },
    ];
    const rawResponses = providerBodies.map((body, index) => ({
      url:
        index === 0
          ? "https://api.render.com/v1/owners/owner-1"
          : "https://api.render.com/v1/postgres/pg-1",
      status: 200,
      body,
      bodySha256: digest(body),
    }));
    Object.assign(evidence, {
      databaseObservation: {
        observationVersion: 4,
        source: "render-api",
        captureIdentity: {
          ownerId: "owner-1",
          apiHost: "api.render.com",
          authenticated: true,
          observedAt: "2026-08-11T00:00:00.000Z",
          rawResponsesSha256: digest(rawResponses),
        },
        rawResponses,
        database: {
          id: "pg-1",
          name: "reviewrouter-db",
          version: "17",
          ownerId: "owner-1",
        },
      },
    });
    evidence.database.observationSha256 = digest(evidence.databaseObservation);
    evidence.migration.outputSha256 = digest(evidence.migrationOutput);
    expect(assertMigrationEvidencePayload(evidence, context)).toBe(evidence);
    expect(() => assertMigrationEvidence(evidence, context)).toThrow(
      "not bound to an authenticated GitHub artifact observation",
    );
    expect(() =>
      assertMigrationEvidencePayload(
        { ...evidence, databaseObservation: undefined },
        context,
      ),
    ).toThrow("missing a bound Render provider observation");
    const splicedResponses = evidence.databaseObservation.rawResponses.map(
      (response, index) => {
        if (index !== 1) return response;
        const body = { ...response.body, id: "pg-other" };
        return { ...response, body, bodySha256: digest(body) };
      },
    );
    const splicedObservation = {
      ...evidence.databaseObservation,
      rawResponses: splicedResponses,
      captureIdentity: {
        ...evidence.databaseObservation.captureIdentity,
        rawResponsesSha256: digest(splicedResponses),
      },
    };
    expect(() =>
      assertMigrationEvidencePayload(
        {
          ...evidence,
          database: {
            ...evidence.database,
            observationSha256: digest(splicedObservation),
          },
          databaseObservation: splicedObservation,
        },
        context,
      ),
    ).toThrow("Render database observation mismatch");
    expect(() =>
      assertMigrationEvidencePayload(
        {
          ...evidence,
          databaseObservation: {
            ...evidence.databaseObservation,
            rawResponses: evidence.databaseObservation.rawResponses.map(
              (response, index) =>
                index === 0
                  ? { ...response, bodySha256: "0".repeat(64) }
                  : response,
            ),
          },
        },
        context,
      ),
    ).toThrow("missing a bound Render provider observation");
    for (const [label, mutated, message] of [
      [
        "commit",
        {
          ...evidence,
          release: { ...evidence.release, commit: "f".repeat(40) },
        },
        "immutable release",
      ],
      [
        "image",
        {
          ...evidence,
          release: {
            ...evidence.release,
            imageDigest: `sha256:${"f".repeat(64)}`,
          },
        },
        "immutable release",
      ],
      [
        "database",
        { ...evidence, database: { ...evidence.database, id: "pg-other" } },
        "database identity",
      ],
    ] as const) {
      expect(
        () => assertMigrationEvidencePayload(mutated, context),
        label,
      ).toThrow(message);
    }
    expect(() =>
      assertMigrationEvidencePayload(
        {
          ...evidence,
          migration: {
            ...evidence.migration,
            callerCount: 2,
          },
        },
        context,
      ),
    ).toThrow("one successful exclusive");
    expect(() =>
      assertMigrationEvidencePayload(
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
      REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: `https://raw.githubusercontent.com/777genius/review-router/${"a".repeat(40)}/scripts/seed-codex-rotating-auth.sh`,
      REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: "v1.2.3",
      REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: "c".repeat(64),
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

  it("PATCHes an existing migration hook off and GET-verifies the nested empty value", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        autoDeployTrigger: "off",
        serviceDetails: {
          envSpecificDetails: { preDeployCommand: "" },
        },
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
          serviceDetails: { preDeployCommand: "" },
        },
      ],
      ["GET", "/services/srv-1"],
    ]);
  });

  it("aborts before deploy when the canonical disabled GET check fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        serviceDetails: {
          envSpecificDetails: { preDeployCommand: "pnpm db:migrate" },
        },
      });
    await expect(
      disableAndVerifyPreDeployCommand({ request } as never, {
        id: "srv-1",
        name: "api",
      }),
    ).rejects.toThrow("preDeployCommand is not canonically disabled");
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
