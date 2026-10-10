import { randomBytes } from "node:crypto";
import type {
  Prisma,
  ReviewConfigurationVersion,
  ReviewMutationAuthority,
  ScmRepositoryIdentity,
} from "@prisma/client";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { FastifyInstance } from "fastify";
import { exportPKCS8, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  githubActionsOidcIssuer,
  JoseActionSessionTokenService,
} from "@reviewrouter/features-action-control-plane";
import { createApiApp } from "./app.js";
import { OctokitCodexRotatingGitHubSecretGateway } from "./github/octokit-codex-rotating-github-secret-gateway.js";
import { OctokitGitHubAppCommentTokenIssuer } from "./github/octokit-github-app-comment-token-issuer.js";

const boundary = vi.hoisted(() => ({
  publicKey: undefined as CryptoKey | undefined,
  createPrismaClient: vi.fn(() => {
    throw new Error("unexpected_database_pool_creation");
  }),
}));

// Replace only remote key discovery: the production verifier still verifies
// signatures, issuer, server audience and the real GitHub claim schema.
vi.mock("jose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jose")>()),
  createRemoteJWKSet: () => async () => {
    if (!boundary.publicKey) throw new Error("synthetic_oidc_key_missing");
    return boundary.publicKey;
  },
}));
vi.mock("@reviewrouter/platform-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reviewrouter/platform-db")>()),
  createPrismaClient: boundary.createPrismaClient,
}));

const audience = "synthetic-action-session-audience";
const repositoryFullName = "fixture-owner/disposable-session-fixture";
const workflowPath = ".github/workflows/reviewrouter-codex.yml";
const workflowSha = "a".repeat(40);
const sessionSecret = "synthetic-unit-session-signer-".repeat(2);
const apps: FastifyInstance[] = [];
let signingKey: CryptoKey;

beforeEach(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  signingKey = keys.privateKey;
  boundary.publicKey = keys.publicKey;
  boundary.createPrismaClient.mockClear();
  vi.stubEnv("GITHUB_APP_ID", "123");
  vi.stubEnv("GITHUB_APP_SLUG", "synthetic-unit-app");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", await exportPKCS8(signingKey));
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY_FILE", undefined);
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH", "0");
  vi.stubEnv("REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK", "0");
  vi.stubEnv("REVIEW_ROUTER_DEBUG_ACTION_ERRORS", "0");
  vi.stubEnv("REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected_network_request");
    }),
  );
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  expect(boundary.createPrismaClient).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function compose(
  fixture: ReturnType<typeof queryFixture>,
  env: Readonly<Record<string, string | undefined>> = {},
) {
  // Exercise normal production composition. No injected control-plane object
  // or mocked composer; only the disposable Prisma/query boundary is supplied.
  const app = await createApiApp({
    prisma: fixture.prisma,
    actionSessionSecret: sessionSecret,
    actionOidcAudience: audience,
    reviewActionV2Env: {
      REVIEW_ROUTER_PUBLIC_API_URL: "https://session-fixture.invalid",
      REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: `777genius/review-router@${workflowSha}`,
      ...env,
    },
    healthDependencies: [],
  });
  apps.push(app);
  return app;
}

async function oidcToken(
  overrides: Record<string, unknown> = {},
  tokenAudience = audience,
) {
  return new SignJWT({
    repository: repositoryFullName,
    repository_id: "777",
    repository_owner: "fixture-owner",
    event_name: "workflow_dispatch",
    run_id: "9001",
    run_attempt: "2",
    workflow_ref: `${repositoryFullName}/${workflowPath}@refs/heads/main`,
    workflow_sha: workflowSha,
    actor: "fixture-actor",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(githubActionsOidcIssuer)
    .setAudience(tokenAudience)
    .setSubject(`repo:${repositoryFullName}:ref:refs/heads/main`)
    .setJti(randomBytes(16).toString("hex"))
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

function exchange(app: FastifyInstance, token: string) {
  return app.inject({
    method: "POST",
    url: "/api/action/v1/session/exchange",
    payload: { oidcToken: token },
  });
}

describe("default production action-session composition", () => {
  it.each([undefined, "0"])(
    "registers shared HTTP routes without legacy witness/authority (flag=%s)",
    async (flag) => {
      const fixture = queryFixture();
      const app = await compose(fixture, {
        REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: flag,
      });
      const badBody = await app.inject({
        method: "POST",
        url: "/api/action/v1/session/exchange",
        payload: {},
      });
      expect(badBody.statusCode).toBe(400);
      expect(badBody.json().error.code).toBe("invalid_action_request");
      const signed = await oidcToken();
      const signatureStart = signed.lastIndexOf(".") + 1;
      const tampered =
        signed.slice(0, signatureStart) +
        (signed[signatureStart] === "A" ? "B" : "A") +
        signed.slice(signatureStart + 1);
      const invalidOidc = await exchange(app, tampered);
      expect(invalidOidc.statusCode).toBe(401);
      expect(invalidOidc.json().error.code).toBe("invalid_action_token");
      const unauthenticated = await app.inject({
        method: "GET",
        url: "/api/action/v1/config",
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json().error.code).toBe(
        "missing_action_session_token",
      );
      const prelease = await app.inject({
        method: "POST",
        url: "/api/action/v1/codex-oauth/prelease",
        payload: {
          oidcToken: "synthetic-unused-token",
          providerInstanceId: "codex-rotating:777",
          workflowSchemaVersion: 2,
        },
      });
      expect(prelease.statusCode).toBe(503);
      expect(prelease.json().error.code).toBe(
        "codex_rotating_oauth_unavailable",
      );
      const writeback = await app.inject({
        method: "POST",
        url: "/api/action/v1/codex-oauth/writeback",
        payload: {},
      });
      expect(writeback.statusCode).toBe(503);
      expect(writeback.json().error.code).toBe(
        "codex_rotating_oauth_unavailable",
      );
      expect(fixture.queryRaw).not.toHaveBeenCalled();
      expect(fixture.repositoryFind).not.toHaveBeenCalled();
      expect(fixture.unexpectedAccess).toEqual([]);
    },
  );

  it("does not resolve or open an unused legacy effect-authority pool", async () => {
    const fixture = queryFixture();
    const app = await compose(fixture, {
      REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "0",
      REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL: "unused-disabled-url",
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/action/v1/config" }))
        .statusCode,
    ).toBe(401);
    expect(fixture.queryRaw).not.toHaveBeenCalled();
    expect(fixture.unexpectedAccess).toEqual([]);
  });

  it("exchanges managed-V2 OIDC under V2 authority and reads current MiMo gateway config", async () => {
    const fixture = queryFixture();
    const verifier = vi
      .spyOn(
        OctokitCodexRotatingGitHubSecretGateway.prototype,
        "verifyManagedV2SessionBootstrapSource",
      )
      .mockResolvedValue({ compatible: true });
    const comments = vi
      .spyOn(OctokitGitHubAppCommentTokenIssuer.prototype, "issueCommentToken")
      .mockResolvedValue({
        token: "synthetic-comment-token",
        custody: "acceptable",
        expiresAt: new Date(Date.now() + 60_000),
        repository: repositoryFullName,
        permissions: {
          contents: "read",
          pullRequests: "write",
          issues: "write",
          statuses: "write",
        },
      });
    const app = await compose(fixture);
    const token = await oidcToken();
    const exchanged = await exchange(app, token);
    expect(exchanged.statusCode).toBe(200);
    expect(verifier).toHaveBeenCalledExactlyOnceWith({
      githubInstallationId: "1234",
      githubRepositoryId: "777",
      repositoryFullName,
      owner: "fixture-owner",
      workflowPath,
      workflowSha,
    });
    const sessionToken: string = exchanged.json().sessionToken;
    const claims = await new JoseActionSessionTokenService(
      sessionSecret,
    ).verify({
      token: sessionToken,
      now: new Date(),
    });
    expect(claims).toMatchObject({
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      githubRepositoryId: "777",
      workflowPath,
      eventName: "workflow_dispatch",
      identityBindingEpoch: `1:${fixture.boundAt.toISOString()}`,
    });
    const headers = { authorization: `Bearer ${sessionToken}` };
    const config = await app.inject({
      method: "GET",
      url: "/api/action/v1/config",
      headers,
    });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      configVersion: 7,
      provider: {
        kind: "codex",
        authMode: "codex_account_gateway",
        model: "mimo-v2-pro",
        reasoningEffort: "high",
        fastMode: false,
        secretBackedProviderEnabled: false,
      },
      runtimeEnv: {
        REVIEW_AUTH_MODE: "codex-account-gateway",
        CODEX_MODEL: "mimo-v2-pro",
        CODEX_REASONING_EFFORT: "high",
        CODEX_FAST_MODE: "false",
        REVIEW_ROUTER_GATEWAY_BINDING_ID: "binding-safe",
        REVIEW_ROUTER_GATEWAY_PROFILE_REF: "profile-mimo",
      },
    });
    expect(fixture.configFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_targetKey: {
            workspaceId: "workspace-1",
            targetKey: "repo:repository-1",
          },
          active: true,
        },
      }),
    );
    const comment = await app.inject({
      method: "POST",
      url: "/api/action/v1/comment-token",
      headers,
    });
    expect(comment.statusCode).toBe(200);
    expect(comments).toHaveBeenCalledExactlyOnceWith({
      githubInstallationId: "1234",
      githubRepositoryId: "777",
      repositoryFullName,
    });
    expect(fixture.entitlementFind).toHaveBeenCalled();
    expect(fixture.rateKeys).toEqual([
      "action:oidc_exchange:repository-1:9001:2",
    ]);
    const replay = await exchange(app, token);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("invalid_action_token");
    expect(verifier).toHaveBeenCalledOnce();
    fixture.repository.selected = false;
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/action/v1/config",
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(fixture.unexpectedAccess).toEqual([]);
  });

  it.each([
    "paused",
    "incompatible source",
    "unselected",
    "entitlement",
    "rate limit",
    "workflow ref",
    "missing workflow sha",
  ])("preserves %s denial with legacy OAuth disabled", async (scenario) => {
    const fixture = queryFixture();
    const verifier = vi
      .spyOn(
        OctokitCodexRotatingGitHubSecretGateway.prototype,
        "verifyManagedV2SessionBootstrapSource",
      )
      .mockResolvedValue({ compatible: scenario !== "incompatible source" });
    if (scenario === "paused") fixture.authority.mode = "paused";
    if (scenario === "unselected") fixture.repository.selected = false;
    if (scenario === "entitlement") fixture.entitlement.status = "paused";
    if (scenario === "rate limit") fixture.rateLimitCount = 21;
    const app = await compose(fixture);
    const response = await exchange(
      app,
      await oidcToken(
        scenario === "workflow ref"
          ? {
              job_workflow_ref:
                "untrusted-owner/runtime/.github/workflows/review.yml@refs/heads/main",
            }
          : scenario === "missing workflow sha"
            ? { workflow_sha: undefined }
            : {},
      ),
    );
    expect(response.statusCode).toBe(scenario === "rate limit" ? 429 : 403);
    if (
      ["paused", "incompatible source", "missing workflow sha"].includes(
        scenario,
      )
    ) {
      expect(response.json().error.code).toBe("legacy_review_mutation_blocked");
    }
    if (scenario === "incompatible source")
      expect(verifier).toHaveBeenCalledOnce();
    else expect(verifier).not.toHaveBeenCalled();
    expect(fixture.unexpectedAccess).toEqual([]);
  });

  it("retains the server-owned audience and rejects a caller-selected audience", async () => {
    const fixture = queryFixture();
    const app = await compose(fixture);
    const response = await app.inject({
      method: "POST",
      url: "/api/action/v1/session/exchange",
      payload: { oidcToken: await oidcToken(), audience: "caller-selected" },
    });
    expect(response.statusCode).toBe(401);
    expect(fixture.repositoryFind).not.toHaveBeenCalled();
    const wrongAudience = await exchange(
      app,
      await oidcToken({}, "untrusted-audience"),
    );
    // Preserve the existing mapper for JOSE's unexpected "aud" claim error.
    expect(wrongAudience.statusCode).toBe(400);
    expect(wrongAudience.json().error.code).toBe("invalid_action_request");
    expect(fixture.repositoryFind).not.toHaveBeenCalled();
  });

  it("denies managed bootstrap when the durable repository identity is absent", async () => {
    const fixture = queryFixture();
    fixture.identityFind.mockResolvedValueOnce(null);
    const verifier = vi
      .spyOn(
        OctokitCodexRotatingGitHubSecretGateway.prototype,
        "verifyManagedV2SessionBootstrapSource",
      )
      .mockResolvedValue({ compatible: true });
    const response = await exchange(await compose(fixture), await oidcToken());
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_action_request");
    expect(verifier).not.toHaveBeenCalled();
    expect(fixture.unexpectedAccess).toEqual([]);
  });

  it("keeps hosted snapshot/checkpoint access available while rejecting legacy provider identities", async () => {
    const fixture = queryFixture();
    const app = await compose(fixture);
    const payload = {
      protocolVersion: 1,
      leaseId: "synthetic-grant-1",
      providerInstanceId: "hosted-pool:repository:777",
      pullRequestNumber: 118,
      baseSha: "b".repeat(40),
    };
    const restored = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/review-snapshot/restore",
      payload,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({
      protocolVersion: 1,
      status: "missing",
      expectedVersion: 0,
    });
    expect(fixture.snapshotFind).toHaveBeenCalledWith({
      where: {
        workspaceId_repositoryId_pullRequestNumber: {
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          pullRequestNumber: 118,
        },
      },
    });
    const checkpoint = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/review-execution-checkpoint/restore",
      payload: {
        ...payload,
        headSha: "c".repeat(40),
        compatibilityKey: "d".repeat(64),
        planHash: "e".repeat(64),
      },
    });
    expect(checkpoint.statusCode).toBe(200);
    expect(checkpoint.json()).toEqual({
      protocolVersion: 1,
      status: "missing",
      expectedVersion: 0,
    });
    expect(fixture.checkpointFind).toHaveBeenCalledOnce();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/action/v1/codex-oauth/review-snapshot/restore",
      payload: { ...payload, providerInstanceId: "codex-rotating:777" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(fixture.snapshotFind).toHaveBeenCalledOnce();
    expect(fixture.unexpectedAccess).toEqual([]);
  });

  it("still requires the recovery witness when legacy rotation is enabled", async () => {
    await expect(
      compose(queryFixture(), {
        REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
      }),
    ).rejects.toThrow("missing_env:REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS");
  });

  it("still requires real effect authority when enabled legacy has a witness", async () => {
    await expect(
      compose(queryFixture(), {
        REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
        REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS:
          randomBytes(32).toString("base64url"),
      }),
    ).rejects.toThrow("codex_oauth_database_effect_authority_unavailable");
  });
});

function queryFixture() {
  const boundAt = new Date("2026-10-01T00:00:00Z");
  const repository = {
    id: "repository-1",
    workspaceId: "workspace-1",
    githubRepositoryId: 777n,
    fullName: repositoryFullName,
    owner: "fixture-owner",
    selected: true,
    workspace: { orgRulesets: [] },
    provisioning: [],
    installation: { status: "active", githubInstallationId: 1234n },
  };
  const identity = {
    scmRepositoryIdentityId: "identity-1",
    provider: "github",
    normalizedSourceBaseUrl: "https://github.com",
    externalRepositoryId: "777",
    version: 1,
    currentWorkspaceId: "workspace-1",
    currentRepositoryConnectionId: "repository-1",
    createdAt: boundAt,
    boundAt,
    unboundAt: null,
  } satisfies ScmRepositoryIdentity;
  const authority: ReviewMutationAuthority = {
    scmRepositoryIdentityId: "identity-1",
    laneKind: "hosted_reviewrouter_app",
    version: 1,
    epoch: 1n,
    mode: "v2_active",
    initializedAt: boundAt,
    activatedAt: boundAt,
    pausedAt: null,
    drainPolicyVersion: null,
    drainStartedAt: null,
    v1AdmissionClosedAt: null,
    drainNotBefore: null,
    managedWorkflowInventoryHash: null,
    activationSafetyDecisionHash: null,
  };
  const version = {
    id: "config-version-7",
    configurationId: "config-1",
    operationId: null,
    operationIntentHash: null,
    workspaceId: "workspace-1",
    version: 7,
    schemaVersion: 2,
    providerKind: "codex",
    providerAuthMode: "codex_account_gateway",
    gatewayBindingId: "binding-safe",
    gatewayProfileRef: "profile-mimo",
    model: "mimo-v2-pro",
    reasoningEffort: "high",
    agenticContext: false,
    fastMode: false,
    failOnSeverity: "critical",
    inlineMaxComments: 50,
    providerLimit: 1,
    providerMaxParallel: 1,
    inlineMinAgreement: 1,
    targetTokensPerBatch: 50000,
    reviewLanguage: null,
    investigationRecordingEnabled: false,
    investigationShadowEnabled: false,
    investigationContextCriticEnabled: false,
    investigationVerifiedCleanEnabled: false,
    investigationCrossRevisionReplayEnabled: false,
    investigationProductionEffectsEnabled: false,
    createdAt: boundAt,
  } satisfies ReviewConfigurationVersion;
  const entitlement = {
    plan: "free_beta",
    status: "active",
    flags: { action_control_plane: true },
    limits: {},
  };
  const repositoryFind = vi.fn(
    async (_args: Prisma.RepositoryConnectionFindFirstArgs) => {
      void _args;
      return repository;
    },
  );
  const configFind = vi.fn(
    async (_args: Prisma.ReviewConfigurationFindUniqueArgs) => {
      void _args;
      return {
        versions: [{ ...version, providers: [] }],
      };
    },
  );
  const entitlementFind = vi.fn(
    async (_args: Prisma.WorkspaceEntitlementFindUniqueArgs) => {
      void _args;
      return entitlement;
    },
  );
  const snapshotFind = vi.fn(
    async (_args: Prisma.ReviewSnapshotFindUniqueArgs) => {
      void _args;
      return null;
    },
  );
  const checkpointFind = vi.fn(
    async (_args: Prisma.ReviewExecutionCheckpointFindUniqueArgs) => {
      void _args;
      return null;
    },
  );
  const identityFind = vi.fn(
    async (
      _args: Prisma.ScmRepositoryIdentityFindUniqueArgs,
    ): Promise<ScmRepositoryIdentity | null> => {
      void _args;
      return identity;
    },
  );
  const unexpectedAccess: string[] = [];
  const nonceKeys = new Set<string>();
  const rateKeys: unknown[] = [];
  const state = { rateLimitCount: 1 };
  const queryRaw = vi.fn(
    async (query: TemplateStringsArray, ...values: unknown[]) => {
      const sql = query.join("?");
      if (sql.includes('FROM "ScmRepositoryIdentity"'))
        return [{ version: 1, boundAt }];
      if (sql.includes('INSERT INTO "ActionOidcReplayNonce"')) {
        const key = String(values[0]);
        if (nonceKeys.has(key)) return [];
        nonceKeys.add(key);
        return [{ key }];
      }
      if (sql.includes('INSERT INTO "RateLimitBucket"')) {
        rateKeys.push(values[0]);
        return [
          {
            count: state.rateLimitCount,
            limit: 20,
            windowEndsAt: new Date(Date.now() + 600_000),
          },
        ];
      }
      unexpectedAccess.push("raw_query");
      throw new Error("unexpected_query_boundary");
    },
  );
  const grant = {
    status: "issued",
    revokedAt: null,
    expiresAt: new Date(Date.now() + 600_000),
    workspaceId: "workspace-1",
    poolId: "pool-1",
    repositoryConnectionId: "repository-1",
    repositoryBindingId: "hosted-binding-1",
    reviewRequestId: "intent-1",
    runId: "9001",
    runAttempt: 2,
    bindingRevision: 7n,
    authzEpoch: 3n,
    runtimeAuthzEpoch: 5n,
    binding: {
      id: "hosted-binding-1",
      workspaceId: "workspace-1",
      poolId: "pool-1",
      repositoryConnectionId: "repository-1",
      status: "active",
      revision: 7n,
      attestedGithubRepositoryId: 777n,
      attestedBindingRevision: 7n,
      pool: { status: "active", authzEpoch: 3n },
      repository: {
        ...repository,
        provider: "github",
        archived: false,
        visibility: "private",
      },
    },
  };
  const queries = {
    $queryRaw: queryRaw,
    repositoryConnection: { findFirst: repositoryFind },
    reviewConfiguration: { findUnique: configFind },
    workspaceEntitlement: { findUnique: entitlementFind },
    scmRepositoryIdentity: { findUnique: identityFind },
    reviewMutationAuthority: { findUnique: vi.fn(async () => authority) },
    hostedCodexInvocationGrant: { findUnique: vi.fn(async () => grant) },
    hostedCodexRuntimeGate: {
      findUnique: vi.fn(async () => ({ status: "active", authzEpoch: 5n })),
    },
    reviewRequestedIntent: {
      findUnique: vi.fn(async () => ({
        requestId: "intent-1",
        workspaceId: "workspace-1",
        repositoryConnectionId: "repository-1",
        pullRequestNumber: 118,
        sourceRunId: "9001",
        sourceRunAttempt: "2",
        admissionState: "admitted",
        state: "dispatched",
      })),
    },
    reviewSnapshot: { findUnique: snapshotFind },
    reviewExecutionCheckpoint: { findUnique: checkpointFind },
  };
  const transactionBoundary = new Proxy(queries, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      unexpectedAccess.push(String(key));
      throw new Error("unexpected_prisma_delegate");
    },
  });
  // A single cast represents the deliberately partial, in-memory Prisma wire
  // boundary. Query inputs and persisted configuration/authority rows are typed.
  const prisma = new Proxy(
    {
      ...queries,
      $transaction: vi.fn(
        async <T>(effect: (transaction: typeof queries) => Promise<T>) =>
          effect(transactionBoundary),
      ),
    },
    {
      get(target, key) {
        if (key in target) return Reflect.get(target, key);
        unexpectedAccess.push(String(key));
        throw new Error("unexpected_prisma_delegate");
      },
    },
  ) as unknown as PrismaClient;
  return {
    prisma,
    boundAt,
    repository,
    authority,
    entitlement,
    repositoryFind,
    configFind,
    entitlementFind,
    identityFind,
    snapshotFind,
    checkpointFind,
    queryRaw,
    rateKeys,
    unexpectedAccess,
    get rateLimitCount() {
      return state.rateLimitCount;
    },
    set rateLimitCount(value: number) {
      state.rateLimitCount = value;
    },
  };
}
