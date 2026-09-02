import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerActionControlPlaneRoutes } from "@reviewrouter/features-action-control-plane";
import { OctokitGitHubAppCommentTokenIssuer } from "./octokit-github-app-comment-token-issuer.js";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetch: vi.fn(),
}));

vi.stubGlobal("fetch", mocks.fetch);

vi.mock("@octokit/app", () => ({
  App: vi.fn().mockImplementation(function App() {
    return {
      octokit: {
        auth: mocks.auth,
      },
    };
  }),
}));

async function issueHostedCommentToken(
  issuer: OctokitGitHubAppCommentTokenIssuer,
  input: {
    githubInstallationId: string;
    githubRepositoryId: string;
    repositoryFullName: string;
  },
) {
  const prepared = await issuer.prepareCommentToken(input);
  return prepared.send({
    remainingBudgetMs: 60_000,
    budgetStartedAtMonotonicMs: performance.now(),
  });
}

describe("OctokitGitHubAppCommentTokenIssuer", () => {
  beforeEach(() => {
    mocks.auth.mockReset();
    mocks.fetch.mockReset();
  });

  it("issues repository-scoped runtime tokens with read access for private PR diffs", async () => {
    mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: "ghs_reviewrouter_app_token",
          repositories: [{ id: 123456 }],
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: {
            contents: "read",
            pull_requests: "write",
            issues: "write",
            statuses: "write",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );

    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });

    const result = await issueHostedCommentToken(issuer, {
      githubInstallationId: "129500385",
      githubRepositoryId: "123456",
      repositoryFullName: "777genius/example",
    });

    expect(mocks.auth).toHaveBeenCalledWith({ type: "app" });
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/129500385/access_tokens",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        redirect: "error",
        body: JSON.stringify({
          repository_ids: [123456],
          permissions: {
            contents: "read",
            pull_requests: "write",
            issues: "write",
            statuses: "write",
          },
        }),
      }),
    );
    expect(result.permissions).toEqual({
      contents: "read",
      pullRequests: "write",
      issues: "write",
      statuses: "write",
    });
  });

  it("rejects tokens that do not include private PR diff read access", async () => {
    mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: "ghs_reviewrouter_app_token",
          repositories: [{ id: 123456 }],
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: {
            pull_requests: "write",
            issues: "write",
            statuses: "write",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );

    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      issueHostedCommentToken(issuer, {
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
      }),
    ).resolves.toMatchObject({
      token: "ghs_reviewrouter_app_token",
      custody: "unacceptable",
      custodyReason: "permissions_mismatch",
    });
  });

  it("rejects non-numeric GitHub repository ids before token minting", async () => {
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });

    await expect(
      issuer.prepareCommentToken({
        githubInstallationId: "129500385",
        githubRepositoryId: "R_kgDOExample",
        repositoryFullName: "777genius/example",
      }),
    ).rejects.toThrow("comment_token_repository_id_invalid");
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("classifies a provider 4xx as definitely no effect", async () => {
    mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
    mocks.fetch.mockResolvedValueOnce(new Response("denied", { status: 422 }));
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });
    const failure = await issueHostedCommentToken(issuer, {
      githubInstallationId: "1",
      githubRepositoryId: "2",
      repositoryFullName: "a/b",
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "comment_token_provider_rejected",
      effect: "none",
    });
  });

  it("refuses bytes at the actual send boundary after a confirmed deadline", async () => {
    mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });
    const prepared = await issuer.prepareCommentToken({
      githubInstallationId: "1",
      githubRepositoryId: "2",
      repositoryFullName: "a/b",
    });
    const failure = await prepared
      .send({
        remainingBudgetMs: 0,
        budgetStartedAtMonotonicMs: performance.now(),
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "comment_token_send_deadline_expired",
      lateSend: true,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"] as const)(
    "bounds %s even when the caller supplies no signal",
    async (method) => {
      vi.useFakeTimers();
      try {
        mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
        let observedSignal: AbortSignal | undefined;
        mocks.fetch.mockImplementationOnce((_url, init) => {
          observedSignal = init?.signal as AbortSignal;
          return new Promise<Response>((_resolve, reject) => {
            observedSignal!.addEventListener(
              "abort",
              () => reject(observedSignal!.reason),
              { once: true },
            );
          });
        });
        const issuer = new OctokitGitHubAppCommentTokenIssuer({
          appId: "123",
          privateKey: "private-key",
        });
        const operation =
          method === "DELETE"
            ? issuer.revokeCommentToken({ token: "bearer" })
            : issueHostedCommentToken(issuer, {
                githubInstallationId: "1",
                githubRepositoryId: "2",
                repositoryFullName: "a/b",
              });
        const rejection = expect(operation).rejects.toMatchObject({
          name: "AbortError",
        });
        await vi.advanceTimersByTimeAsync(15_001);
        await rejection;
        expect(observedSignal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("fails closed on a monotonic process pause even when wall time lags", async () => {
    mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
    let monotonic = 100;
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(1);
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
      monotonicNow: () => monotonic,
    });
    const prepared = await issuer.prepareCommentToken({
      githubInstallationId: "1",
      githubRepositoryId: "2",
      repositoryFullName: "a/b",
    });
    monotonic = 151;
    await expect(
      prepared.send({
        remainingBudgetMs: 50,
        budgetStartedAtMonotonicMs: 100,
      }),
    ).rejects.toMatchObject({
      message: "comment_token_send_deadline_expired",
      lateSend: true,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    wallClock.mockRestore();
  });

  it("keeps a malformed successful response ambiguous", async () => {
    mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ expires_at: "not-a-token" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });
    const failure = await issueHostedCommentToken(issuer, {
      githubInstallationId: "1",
      githubRepositoryId: "2",
      repositoryFullName: "a/b",
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "comment_token_invalid_response",
    });
    expect(failure).not.toHaveProperty("effect", "none");
  });

  it.each([undefined, "not-a-date"])(
    "returns custody of a known bearer with unbounded expiry %s",
    async (expiresAt) => {
      mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
      mocks.fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "exact-known-bearer",
            repositories: [{ id: 2 }],
            ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
            permissions: {
              contents: "read",
              pull_requests: "write",
              issues: "write",
              statuses: "write",
            },
          }),
          { status: 201 },
        ),
      );

      await expect(
        issueHostedCommentToken(
          new OctokitGitHubAppCommentTokenIssuer({
            appId: "123",
            privateKey: "private-key",
          }),
          {
            githubInstallationId: "1",
            githubRepositoryId: "2",
            repositoryFullName: "a/b",
          },
        ),
      ).resolves.toMatchObject({
        token: "exact-known-bearer",
        expiresAt: new Date("9999-12-31T23:59:59.000Z"),
        custody: "unacceptable",
        custodyReason: "provider_expiry_unbounded",
      });
    },
  );

  it.each([new Date(Date.now() - 1_000), new Date(Date.now() + 62 * 60_000)])(
    "rejects unsafe provider expiry %s",
    async (expiresAt) => {
      mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
      mocks.fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "token",
            repositories: [{ id: 2 }],
            expires_at: expiresAt.toISOString(),
            permissions: {
              contents: "read",
              pull_requests: "write",
              issues: "write",
              statuses: "write",
            },
          }),
          { status: 201 },
        ),
      );
      await expect(
        issueHostedCommentToken(
          new OctokitGitHubAppCommentTokenIssuer({
            appId: "123",
            privateKey: "private-key",
          }),
          {
            githubInstallationId: "1",
            githubRepositoryId: "2",
            repositoryFullName: "a/b",
          },
        ),
      ).resolves.toMatchObject({
        token: "token",
        custody: "unacceptable",
      });
    },
  );

  it.each([
    ["missing", undefined],
    ["wrong", [{ id: 3 }]],
    ["multiple", [{ id: 2 }, { id: 3 }]],
  ] as const)(
    "returns custody for %s repository inventory",
    async (_name, repositories) => {
      mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
      mocks.fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "scoped-bearer",
            ...(repositories === undefined ? {} : { repositories }),
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            permissions: {
              contents: "read",
              pull_requests: "write",
              issues: "write",
              statuses: "write",
            },
          }),
          { status: 201 },
        ),
      );
      await expect(
        issueHostedCommentToken(
          new OctokitGitHubAppCommentTokenIssuer({
            appId: "123",
            privateKey: "private-key",
          }),
          {
            githubInstallationId: "1",
            githubRepositoryId: "2",
            repositoryFullName: "a/b",
          },
        ),
      ).resolves.toMatchObject({
        token: "scoped-bearer",
        custody: "unacceptable",
        custodyReason: "repository_inventory_mismatch",
      });
    },
  );

  it.each([200, 202, 203, 206, 207, 208, 226])(
    "returns custody for non-creation 2xx status %i",
    async (status) => {
      mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
      mocks.fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "status-bearer",
            repositories: [{ id: 2 }],
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            permissions: {
              contents: "read",
              pull_requests: "write",
              issues: "write",
              statuses: "write",
            },
          }),
          { status },
        ),
      );
      await expect(
        issueHostedCommentToken(
          new OctokitGitHubAppCommentTokenIssuer({
            appId: "123",
            privateKey: "private-key",
          }),
          {
            githubInstallationId: "1",
            githubRepositoryId: "2",
            repositoryFullName: "a/b",
          },
        ),
      ).resolves.toMatchObject({
        token: "status-bearer",
        custody: "unacceptable",
        custodyReason: `unexpected_creation_status:${status}`,
      });
    },
  );

  it.each([204, 205])(
    "rejects empty non-creation 2xx status %i",
    async (status) => {
      mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
      mocks.fetch.mockResolvedValueOnce(new Response(null, { status }));
      await expect(
        issueHostedCommentToken(
          new OctokitGitHubAppCommentTokenIssuer({
            appId: "123",
            privateKey: "private-key",
          }),
          {
            githubInstallationId: "1",
            githubRepositoryId: "2",
            repositoryFullName: "a/b",
          },
        ),
      ).rejects.toThrow("comment_token_invalid_response");
    },
  );

  it.each([422, 503])(
    "cancels an unused provider error body for status %i",
    async (status) => {
      const cancel = vi.fn();
      mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
      mocks.fetch.mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), { status }),
      );
      await expect(
        issueHostedCommentToken(
          new OctokitGitHubAppCommentTokenIssuer({
            appId: "123",
            privateKey: "private-key",
          }),
          {
            githubInstallationId: "1",
            githubRepositoryId: "2",
            repositoryFullName: "a/b",
          },
        ),
      ).rejects.toThrow(/comment_token_provider_/u);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [204, "revoked"],
    [401, "already_invalid"],
  ] as const)(
    "accepts trusted revoke status %i as %s",
    async (status, proof) => {
      mocks.fetch.mockResolvedValueOnce(new Response(null, { status }));
      const issuer = new OctokitGitHubAppCommentTokenIssuer({
        appId: "123",
        privateKey: "private-key",
      });
      await expect(
        issuer.revokeCommentToken({ token: "exact-bearer" }),
      ).resolves.toEqual({ proof });
      expect(mocks.fetch).toHaveBeenCalledWith(
        "https://api.github.com/installation/token",
        expect.objectContaining({ method: "DELETE", cache: "no-store" }),
      );
    },
  );

  it("does not treat a revoke 403 as invalidation proof", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });
    await expect(
      issuer.revokeCommentToken({ token: "exact-bearer" }),
    ).rejects.toThrow("comment_token_revoke_failed");
  });

  it.each([307, 308])(
    "never follows a mint redirect %i with a second POST",
    async (status) => {
      mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
      mocks.fetch.mockResolvedValueOnce(
        new Response(null, {
          status,
          headers: { location: "https://evil.invalid/" },
        }),
      );
      const issuer = new OctokitGitHubAppCommentTokenIssuer({
        appId: "123",
        privateKey: "private-key",
      });
      await expect(
        issueHostedCommentToken(issuer, {
          githubInstallationId: "1",
          githubRepositoryId: "2",
          repositoryFullName: "a/b",
        }),
      ).rejects.toThrow("comment_token_provider_unavailable");
      expect(mocks.fetch).toHaveBeenCalledOnce();
      expect(mocks.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "POST", redirect: "error" }),
      );
    },
  );

  it.each([307, 308])(
    "never follows a revoke redirect %i with a second request",
    async (status) => {
      mocks.fetch.mockResolvedValueOnce(
        new Response(null, {
          status,
          headers: { location: "https://evil.invalid/" },
        }),
      );
      const issuer = new OctokitGitHubAppCommentTokenIssuer({
        appId: "123",
        privateKey: "private-key",
      });
      await expect(
        issuer.revokeCommentToken({ token: "exact-bearer" }),
      ).rejects.toThrow("comment_token_revoke_failed");
      expect(mocks.fetch).toHaveBeenCalledOnce();
      expect(mocks.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "DELETE", redirect: "error" }),
      );
    },
  );

  it("rejects oversized GitHub responses before parsing JSON", async () => {
    mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
    mocks.fetch.mockResolvedValueOnce(
      new Response("{}", {
        status: 201,
        headers: { "content-length": String(16 * 1024 + 1) },
      }),
    );
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });
    await expect(
      issueHostedCommentToken(issuer, {
        githubInstallationId: "1",
        githubRepositoryId: "2",
        repositoryFullName: "a/b",
      }),
    ).rejects.toThrow("comment_token_response_too_large");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("cancels a declared-oversize response body", async () => {
    const cancel = vi.fn();
    mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
    mocks.fetch.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        status: 201,
        headers: { "content-length": String(16 * 1024 + 1) },
      }),
    );
    await expect(
      issueHostedCommentToken(
        new OctokitGitHubAppCommentTokenIssuer({
          appId: "123",
          privateKey: "private-key",
        }),
        {
          githubInstallationId: "1",
          githubRepositoryId: "2",
          repositoryFullName: "a/b",
        },
      ),
    ).rejects.toThrow("comment_token_response_too_large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds a streamed response even without Content-Length", async () => {
    mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
    mocks.fetch.mockResolvedValueOnce(
      new Response("x".repeat(16 * 1024 + 1), { status: 201 }),
    );
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });
    await expect(
      issueHostedCommentToken(issuer, {
        githubInstallationId: "1",
        githubRepositoryId: "2",
        repositoryFullName: "a/b",
      }),
    ).rejects.toThrow("comment_token_response_too_large");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("zeroes retained and crossing provider chunks on streamed overflow", async () => {
    const retained = new Uint8Array(16 * 1024);
    retained.fill(97);
    const crossing = new Uint8Array([98]);
    mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(retained);
            controller.enqueue(crossing);
            controller.close();
          },
        }),
        { status: 201 },
      ),
    );
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });
    await expect(
      issueHostedCommentToken(issuer, {
        githubInstallationId: "1",
        githubRepositoryId: "2",
        repositoryFullName: "a/b",
      }),
    ).rejects.toThrow("comment_token_response_too_large");
    expect(Array.from(retained)).toEqual(Array(retained.byteLength).fill(0));
    expect(Array.from(crossing)).toEqual([0]);
  });

  it("keeps the shared issuer functional for action-control-plane consumers", async () => {
    mocks.auth.mockResolvedValueOnce({ token: "app-jwt" });
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: "action-comment-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: {
            contents: "read",
            pull_requests: "write",
            issues: "write",
            statuses: "write",
          },
          repositories: [{ id: 2 }],
        }),
        { status: 201 },
      ),
    );
    await expect(
      issuer.issueCommentToken({
        githubInstallationId: "1",
        githubRepositoryId: "2",
        repositoryFullName: "a/b",
      }),
    ).resolves.toMatchObject({ token: "action-comment-token" });
    expect(mocks.auth).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("keeps both production-composed action comment-token routes functional", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    mocks.auth.mockResolvedValue({ token: "app-jwt" });
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            token: "action-comment-token",
            expires_at: expiresAt.toISOString(),
            permissions: {
              contents: "read",
              pull_requests: "write",
              issues: "write",
              statuses: "write",
            },
            repositories: [{ id: 2 }],
          }),
          { status: 201 },
        ),
    );
    const issuer = new OctokitGitHubAppCommentTokenIssuer({
      appId: "123",
      privateKey: "private-key",
    });
    const repository = {
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      githubRepositoryId: "2",
      githubInstallationId: "1",
      fullName: "a/b",
      owner: "a",
      selected: true,
      installationStatus: "active",
    } as const;
    const app = Fastify({ logger: false });
    await registerActionControlPlaneRoutes(app, {
      commentTokens: issuer,
      clock: { now: () => new Date() },
      repositories: {
        findSelectedRepositoryByGithubId: vi.fn().mockResolvedValue(repository),
      },
      sessions: {
        verify: vi.fn().mockResolvedValue({
          workspaceId: repository.workspaceId,
          repositoryId: repository.repositoryId,
          githubRepositoryId: repository.githubRepositoryId,
          repository: repository.fullName,
          githubActorLogin: "reviewer",
          githubRunId: "100",
          githubRunAttempt: "1",
          eventName: "pull_request",
          protocolVersion: 1,
        }),
      },
      codexRotatingOAuth: {
        findCompletedLeaseWriteTarget: vi.fn().mockResolvedValue({
          status: "ready",
          writeTarget: {
            githubInstallationId: repository.githubInstallationId,
            githubRepositoryId: repository.githubRepositoryId,
            repositoryFullName: repository.fullName,
          },
        }),
      },
    } as unknown as Parameters<typeof registerActionControlPlaneRoutes>[1]);
    try {
      const generic = await app.inject({
        method: "POST",
        url: "/api/action/v1/comment-token",
        headers: { authorization: "Bearer action-session" },
      });
      expect(generic.statusCode).toBe(200);
      expect(generic.json()).toMatchObject({
        protocolVersion: 1,
        token: "action-comment-token",
        repository: repository.fullName,
      });

      const rotating = await app.inject({
        method: "POST",
        url: "/api/action/v1/codex-oauth/comment-token",
        payload: {
          leaseId: "lease-001",
          providerInstanceId: "codex-rotating:2",
          authCleared: true,
        },
      });
      expect(rotating.statusCode).toBe(200);
      expect(rotating.json()).toMatchObject({
        protocolVersion: 1,
        token: "action-comment-token",
        repository: repository.fullName,
      });
      expect(mocks.auth).toHaveBeenCalledTimes(2);
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
