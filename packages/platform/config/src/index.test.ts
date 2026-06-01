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
  isWorkflowProvisioningEnabled,
  loadRuntimeEnv,
  parseCodexRotatingOAuthRepositoryAllowlist,
  parseConflictReviewFallbackRepositoryAllowlist,
  parseReviewRouterActionRefList,
  readGitHubAppPrivateKey,
  requireGitHubAppPrivateKey,
  resolveReviewRouterActionRef,
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

  it("keeps runtime env default aligned with the resolver", () => {
    const env = loadRuntimeEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/reviewrouter",
      AUTH_SECRET: "0123456789abcdef",
    } as NodeJS.ProcessEnv);

    expect(env.REVIEW_ROUTER_ACTION_VERSION).toBe("main");
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
