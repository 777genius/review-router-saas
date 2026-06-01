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

  it("defaults to hosted URL in production when Render env is incomplete", () => {
    expect(
      resolveCodexSeedScriptUrl({
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toBe("https://reviewrouter.site/install/codex");
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

  it("does not expose localhost from production env mistakes", () => {
    expect(
      resolveCodexSeedScriptUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_WEB_URL: "http://localhost:3000",
      } as NodeJS.ProcessEnv),
    ).toBe("https://reviewrouter.site/install/codex");
  });

  it("rejects non-local http URLs", () => {
    expect(() =>
      resolveCodexSeedScriptUrl({
        NODE_ENV: "test",
        REVIEW_ROUTER_WEB_URL: "http://app.reviewrouter.dev",
      } as NodeJS.ProcessEnv),
    ).toThrow("invalid_review_router_web_url");
  });

  it("rejects URL credentials, query, or fragment", () => {
    for (const url of [
      "https://token@app.reviewrouter.dev",
      "https://app.reviewrouter.dev?x=1",
      "https://app.reviewrouter.dev#setup",
    ]) {
      expect(() =>
        resolveCodexSeedScriptUrl({
          NODE_ENV: "test",
          REVIEW_ROUTER_WEB_URL: url,
        } as NodeJS.ProcessEnv),
      ).toThrow("invalid_review_router_web_url");
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

  it("defaults the GitLab seed script redirect to the stable action version", () => {
    expect(resolveGitLabCodexInstallRedirect({} as NodeJS.ProcessEnv)).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/v1/scripts/seed-codex-gitlab-auth.sh",
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
