import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isCodexRotatingOAuthAllowedForRepository,
  isCodexRotatingOAuthAllowedForWorkspaceDefault,
  isCodexRotatingOAuthEnabled,
  isConflictReviewFallbackAllowedForRepository,
  isConflictReviewFallbackEnabled,
  isClaudeCodeProviderEnabled,
  isHostedCodexPoolEnabled,
  isHostedCodexCustodyEnabled,
  isHostedCodexAdmissionEnabled,
  isHostedCodexRelayEnabled,
  isHostedCodexFailoverEnabled,
  isWorkflowProvisioningEnabled,
  loadRuntimeEnv,
  parseCodexRotatingOAuthRepositoryAllowlist,
  parseConflictReviewFallbackRepositoryAllowlist,
  parseReviewRouterActionRefList,
  readGitHubAppPrivateKey,
  requireReviewRouterDatabaseRecoveryWitness,
  requireGitHubAppPrivateKey,
  resolveReviewRouterActionRef,
  resolveReviewRouterCodexRotatingActionRef,
  resolveReviewRouterCodexRotatingTrustedActionRefs,
  resolveReviewRouterPublicApiUrl,
  resolveReviewRouterTrustedActionRefs,
} from "./index";

describe("platform config", () => {
  it("defaults workflow provisioning to the live ReviewRouter main channel", () => {
    expect(resolveReviewRouterActionRef({})).toBe(
      "777genius/review-router@main",
    );
  });

  it("allows pinning a release version without changing callers", () => {
    expect(
      resolveReviewRouterActionRef({
        REVIEW_ROUTER_ACTION_VERSION: "v1.0.4",
      }),
    ).toBe("777genius/review-router@v1.0.4");
  });

  it("allows overriding the full action ref for smoke tests", () => {
    expect(
      resolveReviewRouterActionRef({
        REVIEW_ROUTER_ACTION_REF: "777genius/review-router@feature/test",
        REVIEW_ROUTER_ACTION_VERSION: "v1.0.4",
      }),
    ).toBe("777genius/review-router@feature/test");
  });

  it("resolves the public API endpoint used by managed workflows", () => {
    expect(
      resolveReviewRouterPublicApiUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_API_URL: "https://internal.example.test/",
        REVIEW_ROUTER_PUBLIC_API_URL: "https://api.example.test/",
      }),
    ).toBe("https://api.example.test");
    expect(resolveReviewRouterPublicApiUrl({})).toBe("http://localhost:4000");
    expect(() =>
      resolveReviewRouterPublicApiUrl({ NODE_ENV: "production" }),
    ).toThrow("missing_env:REVIEW_ROUTER_PUBLIC_API_URL");
    expect(() =>
      resolveReviewRouterPublicApiUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_PUBLIC_API_URL: "not-a-url",
      }),
    ).toThrow("invalid_workflow_api_url");
  });

  it("rejects every production loopback origin regardless of HTTPS", () => {
    for (const origin of [
      "https://localhost",
      "https://127.0.0.1",
      "https://127.1",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:7f00:1]",
    ]) {
      expect(
        () =>
          resolveReviewRouterPublicApiUrl({
            NODE_ENV: "production",
            REVIEW_ROUTER_PUBLIC_API_URL: origin,
          }),
        origin,
      ).toThrow("invalid_workflow_api_url");
    }
  });

  it("builds a unique full-SHA trusted action ref rollout window", () => {
    expect(
      resolveReviewRouterTrustedActionRefs({
        REVIEW_ROUTER_ACTION_REF:
          "777genius/review-router@AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        REVIEW_ROUTER_ALLOWED_ACTION_REFS:
          "777genius/review-router@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, 777genius/review-router@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toEqual([
      "777genius/review-router@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "777genius/review-router@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("does not trust non-SHA channel refs for Codex OIDC allowlists", () => {
    expect(
      resolveReviewRouterTrustedActionRefs({
        REVIEW_ROUTER_ACTION_REF: "777genius/review-router@v1",
      }),
    ).toEqual([]);
    expect(() =>
      parseReviewRouterActionRefList("777genius/review-router@main"),
    ).toThrow("invalid_env:REVIEW_ROUTER_ALLOWED_ACTION_REFS");
  });

  it("requires a separate exact-SHA release for rotating Codex workflows", () => {
    expect(
      resolveReviewRouterCodexRotatingActionRef({
        REVIEW_ROUTER_ACTION_REF: "777genius/review-router@main",
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
          "777genius/review-router@AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toBe("777genius/review-router@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect(() =>
      resolveReviewRouterCodexRotatingActionRef({
        REVIEW_ROUTER_ACTION_REF: "777genius/review-router@main",
      }),
    ).toThrow("missing_env:REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF");
    for (const value of [
      "777genius/review-router@main",
      "777genius/review-router@v1",
      "777genius/review-router@abc123",
    ]) {
      expect(() =>
        resolveReviewRouterCodexRotatingActionRef({
          REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: value,
        }),
      ).toThrow("invalid_env:REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF");
    }
  });

  it("trusts the rotating primary plus an explicit same-repository SHA overlap", () => {
    expect(
      resolveReviewRouterCodexRotatingTrustedActionRefs({
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
          "777genius/review-router@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS:
          "777genius/review-router@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 777genius/review-router@AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toEqual([
      "777genius/review-router@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "777genius/review-router@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);

    expect(() =>
      resolveReviewRouterCodexRotatingTrustedActionRefs({
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
          "777genius/review-router@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS:
          "attacker/review-router@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toThrow("invalid_env:REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS");
  });

  it("requires a strong recovery witness without exposing it in errors", () => {
    const witness = "A".repeat(43);
    expect(
      requireReviewRouterDatabaseRecoveryWitness({
        REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: ` ${witness} `,
      }),
    ).toBe(witness);
    expect(() => requireReviewRouterDatabaseRecoveryWitness({})).toThrow(
      "missing_env:REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
    );
    try {
      requireReviewRouterDatabaseRecoveryWitness({
        REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "too-short-secret",
      });
      throw new Error("expected invalid witness");
    } catch (error) {
      expect(String(error)).toBe(
        "Error: invalid_env:REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
      );
      expect(String(error)).not.toContain("too-short-secret");
    }
  });

  it("keeps runtime env default aligned with the resolver", () => {
    const env = loadRuntimeEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/reviewrouter",
      AUTH_SECRET: "0123456789abcdef",
    } as NodeJS.ProcessEnv);

    expect(env.REVIEW_ROUTER_ACTION_VERSION).toBe("main");
    expect(env.REVIEW_ROUTER_DEFAULT_EFFORT).toBe("xhigh");
    expect(resolveReviewRouterActionRef(env)).toBe(
      "777genius/review-router@main",
    );
  });

  it("requires explicit workflow provisioning enablement and lets disable win", () => {
    expect(isWorkflowProvisioningEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isWorkflowProvisioningEnabled({
        REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isWorkflowProvisioningEnabled({
        REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING: "1",
        REVIEW_ROUTER_DISABLE_WORKFLOW_PROVISIONING: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("enables conflict review fallback by default and keeps an explicit rollback flag", () => {
    expect(isConflictReviewFallbackEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(
      isConflictReviewFallbackEnabled({
        REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isConflictReviewFallbackEnabled({
        REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("allows conflict review fallback for all repositories by default and supports a restrictive allowlist", () => {
    const enabledEnv = {
      REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK: "1",
      REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES:
        "777genius/example, Other-Org/Repo.Name",
    } as NodeJS.ProcessEnv;

    expect(
      parseConflictReviewFallbackRepositoryAllowlist(
        enabledEnv.REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES,
      ),
    ).toEqual(["777genius/example", "other-org/repo.name"]);
    expect(
      isConflictReviewFallbackAllowedForRepository(
        "777genius/example",
        enabledEnv,
      ),
    ).toBe(true);
    expect(
      isConflictReviewFallbackAllowedForRepository(
        "777genius/not-enabled",
        enabledEnv,
      ),
    ).toBe(false);
    expect(
      isConflictReviewFallbackAllowedForRepository("777genius/not-enabled", {
        REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK: "1",
        REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES: "",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isConflictReviewFallbackAllowedForRepository(
        "777genius/not-enabled",
        {} as NodeJS.ProcessEnv,
      ),
    ).toBe(true);
    expect(
      isConflictReviewFallbackAllowedForRepository("777genius/example", {
        ...enabledEnv,
        REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(() =>
      parseConflictReviewFallbackRepositoryAllowlist("../bad/repo"),
    ).toThrow(
      "invalid_env:REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES",
    );
  });

  it("enables Claude Code provider UI by default and keeps an explicit rollback switch", () => {
    expect(isClaudeCodeProviderEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(
      isClaudeCodeProviderEnabled({
        REVIEW_ROUTER_ENABLE_CLAUDE_CODE_PROVIDER: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isClaudeCodeProviderEnabled({
        REVIEW_ROUTER_ENABLE_CLAUDE_CODE_PROVIDER: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("enables production rotating Codex OAuth for all repos with an optional allowlist", () => {
    const enabledEnv = {
      REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
      REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES:
        "777genius/agent-teams-ai, Other-Org/Repo.Name",
    } as NodeJS.ProcessEnv;

    expect(isCodexRotatingOAuthEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCodexRotatingOAuthEnabled(enabledEnv)).toBe(true);
    expect(
      parseCodexRotatingOAuthRepositoryAllowlist(
        enabledEnv.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES,
      ),
    ).toEqual(["777genius/agent-teams-ai", "other-org/repo.name"]);
    expect(
      isCodexRotatingOAuthAllowedForRepository(
        "777genius/agent-teams-ai",
        enabledEnv,
      ),
    ).toBe(true);
    expect(
      isCodexRotatingOAuthAllowedForRepository(
        "777genius/not-enabled",
        enabledEnv,
      ),
    ).toBe(false);
    expect(
      isCodexRotatingOAuthAllowedForRepository("777genius/agent-teams-ai", {
        ...enabledEnv,
        REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      isCodexRotatingOAuthAllowedForRepository("777genius/agent-teams-ai", {
        REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
        REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES: "",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isCodexRotatingOAuthAllowedForWorkspaceDefault({
        REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH: "1",
        REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES: "",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(isCodexRotatingOAuthAllowedForWorkspaceDefault(enabledEnv)).toBe(
      false,
    );
    expect(() =>
      parseCodexRotatingOAuthRepositoryAllowlist("../bad/repo"),
    ).toThrow("invalid_env:REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES");
  });

  it("keeps hosted Codex pool behind an explicit rollback-safe gate", () => {
    expect(isHostedCodexPoolEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isHostedCodexPoolEnabled({
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isHostedCodexPoolEnabled({
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("keeps every hosted Codex subsystem independently disabled by default", () => {
    expect(isHostedCodexCustodyEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isHostedCodexAdmissionEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isHostedCodexRelayEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isHostedCodexFailoverEnabled({} as NodeJS.ProcessEnv)).toBe(false);

    expect(
      isHostedCodexCustodyEnabled({
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isHostedCodexAdmissionEnabled({
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isHostedCodexRelayEnabled({
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isHostedCodexFailoverEnabled({
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("reads GitHub App private key from an inline hosted secret", () => {
    expect(
      readGitHubAppPrivateKey({
        GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
      }),
    ).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  });

  it("prefers an inline GitHub App private key over a local file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "review-router-config-"));
    try {
      const keyFile = join(tempDir, "app.pem");
      writeFileSync(keyFile, "file-key");

      expect(
        readGitHubAppPrivateKey({
          GITHUB_APP_PRIVATE_KEY: "inline-key",
          GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
        }),
      ).toBe("inline-key");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("reads GitHub App private key from a local file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "review-router-config-"));
    try {
      const keyFile = join(tempDir, "app.pem");
      writeFileSync(keyFile, "file-key");

      expect(
        readGitHubAppPrivateKey({
          GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
        }),
      ).toBe("file-key");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("throws a clear error when GitHub App private key is missing", () => {
    expect(() => requireGitHubAppPrivateKey({})).toThrow(
      "missing_env:GITHUB_APP_PRIVATE_KEY",
    );
  });
});
