import { describe, expect, it } from "vitest";
import {
  resolveCodexSeedScriptUrl,
  resolveGitLabCodexInstallRedirect,
  resolveGitLabCodexSeedScriptUrl,
} from "./codex-seed-script-url";

describe("resolveCodexSeedScriptUrl", () => {
  it("defaults to localhost for local beta", () => {
    expect(resolveCodexSeedScriptUrl({} as NodeJS.ProcessEnv)).toBe(
      "http://localhost:3000/install/codex",
    );
  });

  it("fails closed when the production web URL is missing", () => {
    expect(() =>
      resolveCodexSeedScriptUrl({
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toThrowError(new Error("missing_review_router_web_url"));
  });

  it("uses the configured hosted web URL", () => {
    expect(
      resolveCodexSeedScriptUrl({
        NODE_ENV: "test",
        REVIEW_ROUTER_WEB_URL: "https://app.reviewrouter.dev/",
      } as NodeJS.ProcessEnv),
    ).toBe("https://app.reviewrouter.dev/install/codex");
  });

  it("uses NEXTAUTH_URL when REVIEW_ROUTER_WEB_URL is not set", () => {
    expect(
      resolveCodexSeedScriptUrl({
        NODE_ENV: "production",
        NEXTAUTH_URL: "https://reviewrouter.site/",
      } as NodeJS.ProcessEnv),
    ).toBe("https://reviewrouter.site/install/codex");
  });

  it("rejects localhost and loopback production URLs", () => {
    for (const url of [
      "http://localhost:3000",
      "https://localhost:3000",
      "https://127.0.0.1",
      "https://127.1",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:7f00:1]",
    ]) {
      expect(() =>
        resolveCodexSeedScriptUrl({
          NODE_ENV: "production",
          REVIEW_ROUTER_WEB_URL: url,
        } as NodeJS.ProcessEnv),
      ).toThrowError(new Error("invalid_review_router_web_url"));
    }
  });

  it("rejects non-local http URLs", () => {
    expect(() =>
      resolveCodexSeedScriptUrl({
        NODE_ENV: "test",
        REVIEW_ROUTER_WEB_URL: "http://app.reviewrouter.dev",
      } as NodeJS.ProcessEnv),
    ).toThrow("invalid_review_router_web_url");
  });

  it("rejects malformed, credentialed, query, fragment, and path URLs", () => {
    for (const url of [
      "not-a-url",
      "https://token@app.reviewrouter.dev",
      "https://app.reviewrouter.dev?x=1",
      "https://app.reviewrouter.dev#setup",
      "https://app.reviewrouter.dev/setup",
    ]) {
      expect(() =>
        resolveCodexSeedScriptUrl({
          NODE_ENV: "test",
          REVIEW_ROUTER_WEB_URL: url,
        } as NodeJS.ProcessEnv),
      ).toThrowError(new Error("invalid_review_router_web_url"));
    }
  });
});

describe("resolveGitLabCodexSeedScriptUrl", () => {
  it("uses the GitLab seed route without accepting CODEX_AUTH_JSON in browser", () => {
    expect(
      resolveGitLabCodexSeedScriptUrl({
        NODE_ENV: "test",
        REVIEW_ROUTER_WEB_URL: "https://app.reviewrouter.dev/",
      } as NodeJS.ProcessEnv),
    ).toBe("https://app.reviewrouter.dev/install/codex-gitlab");
  });

  it("pins the GitLab seed script redirect to a release SHA when available", () => {
    expect(
      resolveGitLabCodexInstallRedirect({
        NODE_ENV: "test",
        REVIEW_ROUTER_ACTION_REF:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      } as NodeJS.ProcessEnv),
    ).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/0123456789abcdef0123456789abcdef01234567/scripts/seed-codex-gitlab-auth.sh",
    );
  });

  it("pins the GitLab seed script redirect to a release tag", () => {
    expect(
      resolveGitLabCodexInstallRedirect({
        REVIEW_ROUTER_ACTION_REF: "777genius/review-router@v1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/v1/scripts/seed-codex-gitlab-auth.sh",
    );
  });

  it("uses the configured action version for the GitLab seed script redirect", () => {
    expect(
      resolveGitLabCodexInstallRedirect({
        REVIEW_ROUTER_ACTION_VERSION: "v1.0.4",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/v1.0.4/scripts/seed-codex-gitlab-auth.sh",
    );
  });

  it("defaults the GitLab seed script redirect to the live action branch", () => {
    expect(resolveGitLabCodexInstallRedirect({} as NodeJS.ProcessEnv)).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/main/scripts/seed-codex-gitlab-auth.sh",
    );
  });

  it("falls back to main when the action ref is not a safe raw GitHub segment", () => {
    expect(
      resolveGitLabCodexInstallRedirect({
        REVIEW_ROUTER_ACTION_REF: "777genius/review-router@feature/test",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/main/scripts/seed-codex-gitlab-auth.sh",
    );
  });
});
