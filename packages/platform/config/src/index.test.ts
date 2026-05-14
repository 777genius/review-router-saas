import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isConflictReviewFallbackAllowedForRepository,
  isConflictReviewFallbackEnabled,
  isClaudeCodeProviderEnabled,
  isWorkflowProvisioningEnabled,
  loadRuntimeEnv,
  parseConflictReviewFallbackRepositoryAllowlist,
  readGitHubAppPrivateKey,
  requireGitHubAppPrivateKey,
  resolveReviewRouterActionRef,
} from "./index";

describe("platform config", () => {
  it("defaults workflow provisioning to the stable ReviewRouter runtime tag", () => {
    expect(resolveReviewRouterActionRef({})).toBe("777genius/review-router@v1");
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

  it("keeps runtime env default aligned with the resolver", () => {
    const env = loadRuntimeEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/reviewrouter",
      AUTH_SECRET: "0123456789abcdef",
    } as NodeJS.ProcessEnv);

    expect(env.REVIEW_ROUTER_ACTION_VERSION).toBe("v1");
    expect(resolveReviewRouterActionRef(env)).toBe(
      "777genius/review-router@v1",
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

  it("keeps conflict review fallback behind an explicit rollout flag", () => {
    expect(isConflictReviewFallbackEnabled({} as NodeJS.ProcessEnv)).toBe(
      false,
    );
    expect(
      isConflictReviewFallbackEnabled({
        REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("requires an explicit repository rollout allowlist for conflict review fallback", () => {
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
