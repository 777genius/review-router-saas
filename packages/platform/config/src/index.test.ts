import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isWorkflowProvisioningEnabled,
  loadRuntimeEnv,
  readGitHubAppPrivateKey,
  requireGitHubAppPrivateKey,
  resolveReviewRouterActionRef,
} from "./index";

describe("platform config", () => {
  it("defaults beta workflow provisioning to live ReviewRouter main", () => {
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
