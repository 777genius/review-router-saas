import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCodexReseedInstallRedirect,
  resolveCodexRotatingInstallRedirect,
  resolveCodexRotatingPublicWebUrl,
  resolveCodexRotatingSeedScriptDescriptor,
} from "./codex-rotating-seed-script";

describe("resolveCodexRotatingSeedScriptDescriptor", () => {
  it("uses an explicit release-pinned descriptor when provided", () => {
    expect(
      resolveCodexRotatingSeedScriptDescriptor({
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL:
          "https://reviewrouter.site/install/codex-rotating?v=v1",
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: "v1",
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      url: "https://reviewrouter.site/install/codex-rotating?v=v1",
      version: "v1",
      sha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
  });

  it("rejects partial explicit descriptors", () => {
    expect(() =>
      resolveCodexRotatingSeedScriptDescriptor({
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL:
          "https://reviewrouter.site/install/codex-rotating",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("codex_rotating_installer_descriptor_incomplete");
  });

  it("builds a local descriptor with a real script hash", () => {
    const descriptor = resolveCodexRotatingSeedScriptDescriptor({
      REVIEW_ROUTER_WEB_URL: "http://localhost:3000",
      REVIEW_ROUTER_ACTION_VERSION: "dev-test",
      NODE_ENV: "development",
    });

    expect(descriptor).toMatchObject({
      url: "http://localhost:3000/install/codex-rotating",
      version: "dev-test",
    });
    expect(descriptor.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("finds the local installer when Next.js runs from the web app directory", () => {
    const repoRoot = process.cwd();
    const expectedSha256 = createHash("sha256")
      .update(
        readFileSync(join(repoRoot, "scripts/seed-codex-rotating-auth.sh")),
      )
      .digest("hex");

    try {
      process.chdir(join(repoRoot, "apps/web"));
      expect(
        resolveCodexRotatingSeedScriptDescriptor({
          REVIEW_ROUTER_WEB_URL: "https://reviewrouter.site",
          REVIEW_ROUTER_ACTION_REF:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          NODE_ENV: "production",
        }),
      ).toMatchObject({
        url: "https://reviewrouter.site/install/codex-rotating",
        version: "0123456789abcdef0123456789abcdef01234567",
        sha256: expectedSha256,
      });
    } finally {
      process.chdir(repoRoot);
    }
  });

  it("redirects curl clients to the action-pinned raw rotating installer", () => {
    expect(
      resolveCodexRotatingInstallRedirect({
        REVIEW_ROUTER_ACTION_REF:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/0123456789abcdef0123456789abcdef01234567/scripts/seed-codex-rotating-auth.sh",
    );
  });

  it("keeps the reseed bootstrap on its own repository ref", () => {
    expect(
      resolveCodexReseedInstallRedirect({
        REVIEW_ROUTER_ACTION_REF:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(
      "https://raw.githubusercontent.com/777genius/review-router-saas/main/scripts/reseed-codex-rotating-auth.sh",
    );
  });

  it("supports pinning the reseed bootstrap independently", () => {
    expect(
      resolveCodexReseedInstallRedirect({
        REVIEW_ROUTER_RESEED_BOOTSTRAP_REF: "v1.2.3",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(
      "https://raw.githubusercontent.com/777genius/review-router-saas/v1.2.3/scripts/reseed-codex-rotating-auth.sh",
    );
  });

  it("uses the hosted web URL for production setup callbacks", () => {
    expect(
      resolveCodexRotatingPublicWebUrl({
        NODE_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("https://reviewrouter.site");
    expect(
      resolveCodexRotatingPublicWebUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_WEB_URL: "https://reviewrouter.site/",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("https://reviewrouter.site");
  });

  it("does not expose localhost from production web URL mistakes", () => {
    expect(
      resolveCodexRotatingPublicWebUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_WEB_URL: "https://localhost:10000",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("https://reviewrouter.site");
    expect(
      resolveCodexRotatingSeedScriptDescriptor({
        NODE_ENV: "production",
        REVIEW_ROUTER_WEB_URL: "https://localhost:10000",
        REVIEW_ROUTER_ACTION_VERSION: "dev-test",
      } as unknown as NodeJS.ProcessEnv),
    ).toMatchObject({
      url: "https://reviewrouter.site/install/codex-rotating",
      version: "dev-test",
    });
  });

  it("installer fails closed when its own SHA256 does not match the setup descriptor", () => {
    const fixture = createRotatingInstallerFixture();
    const result = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: fixture.path,
        REVIEW_ROUTER_INSTALLER_SHA256:
          "0000000000000000000000000000000000000000000000000000000000000000",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64: fixture.manifestBase64,
      },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Installer SHA256 mismatch");
  });

  it("installer falls back to sha256sum when shasum is unavailable", () => {
    const fixture = createRotatingInstallerFixture({ shasumFails: true });
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "refresh-token" },
      }),
    );

    const result = spawnSync(
      "bash",
      [fixture.scriptPath, "--dry-run", "--confirm-write"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: fixture.path,
          HOME: fixture.home,
          REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
          REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
          REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
          REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
          REVIEW_ROUTER_REUSE_EXISTING_CODEX_AUTH_I_KNOW_IT_IS_CURRENT: "1",
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            fixture.manifestBase64,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[dry-run] gh secret set");
  });

  it("installer refuses preexisting dedicated auth by default before writing the GitHub secret", () => {
    const fixture = createRotatingInstallerFixture({
      ghSecretSetFailsIfCalled: true,
    });
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "stale-refresh-token" },
      }),
    );

    const result = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: fixture.path,
        HOME: fixture.home,
        REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
        REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
        REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
        REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64: fixture.manifestBase64,
      },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Refusing to reuse existing Codex auth from",
    );
    expect(result.stderr).toContain("--force-reseed");
    expect(result.stderr).toContain(
      "--reuse-existing-auth-i-know-it-is-current",
    );
    expect(result.stderr).not.toContain("gh secret set should not be called");
  });

  it("installer allows existing auth only with the explicit unsafe reuse flag", () => {
    const fixture = createRotatingInstallerFixture();
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "known-current-refresh-token" },
      }),
    );

    const result = spawnSync(
      "bash",
      [
        fixture.scriptPath,
        "--dry-run",
        "--confirm-write",
        "--reuse-existing-auth-i-know-it-is-current",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: fixture.path,
          HOME: fixture.home,
          REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
          REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
          REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
          REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            fixture.manifestBase64,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[dry-run] gh secret set");
    expect(result.stdout).toContain("Reusing an existing Codex auth file");
  });

  it("installer force reseed quarantines old dedicated auth and logs in freshly", () => {
    const fixture = createRotatingInstallerFixture();
    const codexArgsPath = join(fixture.home, "codex-args.txt");
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "old-refresh-token" },
      }),
    );

    const result = spawnSync(
      "bash",
      [fixture.scriptPath, "--dry-run", "--confirm-write", "--force-reseed"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: fixture.path,
          HOME: fixture.home,
          REVIEW_ROUTER_TEST_CODEX_ARGS_CAPTURE: codexArgsPath,
          REVIEW_ROUTER_TEST_CODEX_LOGIN_WRITES_AUTH: "1",
          REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
          REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
          REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
          REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            fixture.manifestBase64,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(codexArgsPath, "utf8")).toContain(
      "login --device-auth",
    );
    expect(
      readFileSync(join(fixture.codexHome, "auth.json"), "utf8"),
    ).toContain("fresh-refresh-token");
    expect(
      readFileSync(join(fixture.codexHome, "auth.json"), "utf8"),
    ).not.toContain("old-refresh-token");
    const quarantineDir = join(fixture.codexHome, "quarantined-auth");
    expect(existsSync(quarantineDir)).toBe(true);
    expect(readdirSync(quarantineDir).length).toBeGreaterThan(0);
  });

  it("installer can use browser login explicitly instead of device login", () => {
    const fixture = createRotatingInstallerFixture();
    const codexArgsPath = join(fixture.home, "codex-browser-args.txt");

    const result = spawnSync(
      "bash",
      [
        fixture.scriptPath,
        "--dry-run",
        "--confirm-write",
        "--login-method",
        "browser",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: fixture.path,
          HOME: fixture.home,
          REVIEW_ROUTER_TEST_CODEX_ARGS_CAPTURE: codexArgsPath,
          REVIEW_ROUTER_TEST_CODEX_LOGIN_WRITES_AUTH: "1",
          REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
          REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
          REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
          REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            fixture.manifestBase64,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(codexArgsPath, "utf8").trim()).toBe("login");
  });

  it("installer refuses ambiguous account import without an explicit auth file", () => {
    const fixture = createRotatingInstallerFixture();
    const accountsDir = join(fixture.codexHome, "accounts");
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(
      join(accountsDir, "first.auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "first-refresh-token" },
      }),
    );
    writeFileSync(
      join(accountsDir, "second.auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "second-refresh-token" },
      }),
    );

    const result = spawnSync(
      "bash",
      [fixture.scriptPath, "--dry-run", "--confirm-write"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: fixture.path,
          HOME: fixture.home,
          REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
          REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
          REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
          REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
          REVIEW_ROUTER_REUSE_EXISTING_CODEX_AUTH_I_KNOW_IT_IS_CURRENT: "1",
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            fixture.manifestBase64,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Multiple valid Codex auth files found");
    expect(result.stderr).toContain("--auth-file <path>");
  });

  it("installer refuses an explicit auth file outside the dedicated CODEX_HOME", () => {
    const fixture = createRotatingInstallerFixture();
    const sharedAuthPath = join(fixture.home, "shared-auth.json");
    writeFileSync(
      sharedAuthPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "shared-refresh-token" },
      }),
    );

    const result = spawnSync(
      "bash",
      [fixture.scriptPath, "--dry-run", "--confirm-write"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: fixture.path,
          HOME: fixture.home,
          REVIEW_ROUTER_CODEX_AUTH_FILE: sharedAuthPath,
          REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
          REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
          REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
          REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            fixture.manifestBase64,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outside dedicated CODEX_HOME");
    expect(result.stderr).toContain(
      "Do not reuse one rotating auth.json across repositories",
    );
  });

  it("installer allows an external auth file only with the recovery override", () => {
    const fixture = createRotatingInstallerFixture();
    const sharedAuthPath = join(fixture.home, "shared-auth.json");
    writeFileSync(
      sharedAuthPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "shared-refresh-token" },
      }),
    );

    const result = spawnSync(
      "bash",
      [fixture.scriptPath, "--dry-run", "--confirm-write"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: fixture.path,
          HOME: fixture.home,
          REVIEW_ROUTER_ALLOW_EXTERNAL_CODEX_AUTH_FILE: "1",
          REVIEW_ROUTER_REUSE_EXISTING_CODEX_AUTH_I_KNOW_IT_IS_CURRENT: "1",
          REVIEW_ROUTER_CODEX_AUTH_FILE: sharedAuthPath,
          REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
          REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
          REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
          REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            fixture.manifestBase64,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[dry-run] gh secret set");
    expect(result.stdout).toContain("Using external Codex auth file");
  });

  it("installer fetches setup manifest by nonce and confirms safe metadata after write", () => {
    const fixture = createRotatingInstallerFixture();
    const confirmCapturePath = join(fixture.home, "confirm.json");
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          id_token: "id-token-for-fingerprint",
          refresh_token: "refresh-token",
        },
      }),
    );

    const result = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: fixture.path,
        HOME: fixture.home,
        REVIEW_ROUTER_TEST_MANIFEST_B64: fixture.manifestBase64,
        REVIEW_ROUTER_TEST_CONFIRM_CAPTURE: confirmCapturePath,
        REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
        REVIEW_ROUTER_REUSE_EXISTING_CODEX_AUTH_I_KNOW_IT_IS_CURRENT: "1",
        REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
        REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
        REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
        REVIEW_ROUTER_CODEX_ROTATING_PROVIDER_INSTANCE_ID:
          "codex-rotating:777genius:agent-teams-ai",
        REVIEW_ROUTER_REPO: "777genius/agent-teams-ai",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:
          "http://localhost:3000/manifest",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_CONFIRM_URL:
          "http://localhost:3000/confirm",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_NONCE: "setup-nonce-1234567890",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const confirmation = JSON.parse(readFileSync(confirmCapturePath, "utf8"));
    expect(confirmation).toMatchObject({
      protocolVersion: 1,
      repositoryId: "123456",
      providerInstanceId: "codex-rotating:777genius:agent-teams-ai",
      setupNonce: "setup-nonce-1234567890",
      secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
      authByteSizeBucket: "0-4KiB",
      installerVersion: fixture.installerVersion,
    });
    expect(JSON.stringify(confirmation)).not.toContain("refresh-token");
    expect(JSON.stringify(confirmation)).not.toContain(
      "id-token-for-fingerprint",
    );
    const state = JSON.parse(
      readFileSync(
        join(fixture.codexHome, "reviewrouter-codex-auth-state.json"),
        "utf8",
      ),
    );
    expect(state).toMatchObject({
      stateVersion: 1,
      ciOwnsTokenChain: true,
      repositoryFullName: "777genius/agent-teams-ai",
      providerInstanceId: "codex-rotating:777genius:agent-teams-ai",
      secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
      authSource: "explicit-reuse",
    });
    expect(JSON.stringify(state)).not.toContain("refresh-token");
    expect(JSON.stringify(state)).not.toContain("id-token-for-fingerprint");
  });

  it("acquires the server setup lease after login and before the secret write", () => {
    const fixture = createRotatingInstallerFixture();
    const eventCapturePath = join(fixture.home, "events.log");
    const confirmCapturePath = join(fixture.home, "confirm.json");

    const result = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: fixture.path,
        HOME: fixture.home,
        REVIEW_ROUTER_TEST_EVENT_CAPTURE: eventCapturePath,
        REVIEW_ROUTER_TEST_MANIFEST_B64: fixture.manifestBase64,
        REVIEW_ROUTER_TEST_CONFIRM_CAPTURE: confirmCapturePath,
        REVIEW_ROUTER_TEST_CODEX_LOGIN_WRITES_AUTH: "1",
        REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
        REVIEW_ROUTER_FORCE_CODEX_RESEED: "1",
        REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
        REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
        REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
        REVIEW_ROUTER_CODEX_ROTATING_PROVIDER_INSTANCE_ID:
          "codex-rotating:777genius:agent-teams-ai",
        REVIEW_ROUTER_REPO: "777genius/agent-teams-ai",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:
          "http://localhost:3000/manifest",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_CONFIRM_URL:
          "http://localhost:3000/confirm",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_NONCE: "setup-nonce-1234567890",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const events = readFileSync(eventCapturePath, "utf8").trim().split("\n");
    const loginIndex = events.findIndex((event) =>
      event.startsWith("codex:login"),
    );
    const fetchIndex = events.findIndex((event) => event.includes("/manifest"));
    const writeIndex = events.findIndex((event) =>
      event.startsWith("gh:secret set"),
    );
    const confirmIndex = events.findIndex((event) =>
      event.includes("/confirm"),
    );

    expect(loginIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeGreaterThan(loginIndex);
    expect(writeIndex).toBeGreaterThan(fetchIndex);
    expect(confirmIndex).toBeGreaterThan(writeIndex);
  });

  it("retries the same confirmation after a lost response", () => {
    const fixture = createRotatingInstallerFixture();
    const confirmCapturePath = join(fixture.home, "confirm-retry.json");
    const confirmFailureMarker = join(fixture.home, "confirm-failed-once");
    const eventCapturePath = join(fixture.home, "confirm-events.log");
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "refresh-token" },
      }),
    );

    const result = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: fixture.path,
        HOME: fixture.home,
        REVIEW_ROUTER_TEST_EVENT_CAPTURE: eventCapturePath,
        REVIEW_ROUTER_TEST_MANIFEST_B64: fixture.manifestBase64,
        REVIEW_ROUTER_TEST_CONFIRM_CAPTURE: confirmCapturePath,
        REVIEW_ROUTER_TEST_CONFIRM_FAIL_ONCE_MARKER: confirmFailureMarker,
        REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
        REVIEW_ROUTER_REUSE_EXISTING_CODEX_AUTH_I_KNOW_IT_IS_CURRENT: "1",
        REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
        REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
        REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
        REVIEW_ROUTER_CODEX_ROTATING_PROVIDER_INSTANCE_ID:
          "codex-rotating:777genius:agent-teams-ai",
        REVIEW_ROUTER_REPO: "777genius/agent-teams-ai",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:
          "http://localhost:3000/manifest",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_CONFIRM_URL:
          "http://localhost:3000/confirm",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_NONCE: "setup-nonce-1234567890",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Retrying the same idempotent confirmation",
    );
    const confirms = readFileSync(eventCapturePath, "utf8")
      .split("\n")
      .filter((event) => event.includes("/confirm"));
    expect(confirms).toHaveLength(2);
  });

  it("recovers an abandoned repository lock", () => {
    const fixture = createRotatingInstallerFixture();
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "refresh-token" },
      }),
    );
    const lockDirectory = join(fixture.codexHome, "active-repository-setups");
    mkdirSync(lockDirectory, { recursive: true });
    const lockId = createHash("sha256")
      .update("777genius/agent-teams-ai")
      .digest("hex");
    writeFileSync(join(lockDirectory, `${lockId}.lock`), "2147483647\n");

    const result = spawnSync(
      "bash",
      [
        fixture.scriptPath,
        "--dry-run",
        "--confirm-write",
        "--reuse-existing-auth-i-know-it-is-current",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: fixture.path,
          HOME: fixture.home,
          REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
          REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
          REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
          REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            fixture.manifestBase64,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[dry-run] gh secret set");
  });

  it("installer checks gh auth before spending a server-backed setup nonce", () => {
    const fixture = createRotatingInstallerFixture({
      ghAuthenticated: false,
      curlFailsIfCalled: true,
    });

    const result = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: fixture.path,
        HOME: fixture.home,
        REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
        REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
        REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
        REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
        REVIEW_ROUTER_CODEX_ROTATING_PROVIDER_INSTANCE_ID:
          "codex-rotating:777genius:agent-teams-ai",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:
          "http://localhost:3000/manifest",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_CONFIRM_URL:
          "http://localhost:3000/confirm",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_NONCE: "setup-nonce-1234567890",
      },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("gh is not authenticated");
    expect(result.stderr).not.toContain("curl should not have been called");
  });

  it("installer refuses a successfully used setup nonce before reading auth again", () => {
    const fixture = createRotatingInstallerFixture();
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "refresh-token" },
      }),
    );
    const run = () =>
      spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: fixture.path,
          HOME: fixture.home,
          REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
          REVIEW_ROUTER_REUSE_EXISTING_CODEX_AUTH_I_KNOW_IT_IS_CURRENT: "1",
          REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
          REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
          REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            fixture.manifestBase64,
        },
        encoding: "utf8",
      });

    expect(run().status).toBe(0);
    const second = run();

    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain("setup command was already used");
  });
});

function createRotatingInstallerFixture(
  options: {
    readonly ghAuthenticated?: boolean;
    readonly ghSecretSetFailsIfCalled?: boolean;
    readonly curlFailsIfCalled?: boolean;
    readonly shasumFails?: boolean;
  } = {},
): {
  readonly codexHome: string;
  readonly home: string;
  readonly installerSha256: string;
  readonly installerUrl: string;
  readonly installerVersion: string;
  readonly manifestBase64: string;
  readonly path: string;
  readonly scriptPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "rr-codex-rotating-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeExecutable(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'if [ -n "${REVIEW_ROUTER_TEST_EVENT_CAPTURE:-}" ]; then printf "gh:%s\\n" "$*" >> "$REVIEW_ROUTER_TEST_EVENT_CAPTURE"; fi',
      'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then',
      options.ghAuthenticated === false
        ? '  echo "not logged in" >&2; exit 1'
        : "  exit 0",
      "fi",
      'if [ "${1:-}" = "api" ] && [ "${2:-}" = "repos/777genius/agent-teams-ai" ]; then printf "123456\\n"; exit 0; fi',
      'if [ "${1:-}" = "secret" ] && [ "${2:-}" = "set" ]; then',
      options.ghSecretSetFailsIfCalled
        ? '  echo "gh secret set should not be called" >&2; exit 43'
        : "  cat >/dev/null; exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  writeExecutable(
    join(bin, "codex"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ -n "${REVIEW_ROUTER_TEST_EVENT_CAPTURE:-}" ]; then printf "codex:%s\\n" "$*" >> "$REVIEW_ROUTER_TEST_EVENT_CAPTURE"; fi',
      'if [ -n "${REVIEW_ROUTER_TEST_CODEX_ARGS_CAPTURE:-}" ]; then',
      '  printf "%s\\n" "$*" >> "$REVIEW_ROUTER_TEST_CODEX_ARGS_CAPTURE"',
      "fi",
      'if [ "${1:-}" = "login" ] && [ "${REVIEW_ROUTER_TEST_CODEX_LOGIN_WRITES_AUTH:-}" = "1" ]; then',
      '  mkdir -p "${CODEX_HOME:?}"',
      '  printf \'{"auth_mode":"chatgpt","tokens":{"refresh_token":"fresh-refresh-token","access_token":"fresh-access-token"}}\' > "$CODEX_HOME/auth.json"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  if (options.shasumFails) {
    writeExecutable(
      join(bin, "shasum"),
      [
        "#!/usr/bin/env bash",
        'echo "shasum unavailable" >&2',
        "exit 127",
        "",
      ].join("\n"),
    );
  }
  writeExecutable(
    join(bin, "sha256sum"),
    [
      "#!/usr/bin/env node",
      'const crypto = require("node:crypto");',
      'const fs = require("node:fs");',
      "const file = process.argv[2];",
      'const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");',
      "console.log(`${hash}  ${file}`);",
      "",
    ].join("\n"),
  );
  writeExecutable(
    join(bin, "curl"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ -n "${REVIEW_ROUTER_TEST_EVENT_CAPTURE:-}" ]; then printf "curl:%s\\n" "$*" >> "$REVIEW_ROUTER_TEST_EVENT_CAPTURE"; fi',
      ...(options.curlFailsIfCalled
        ? ['echo "curl should not have been called" >&2', "exit 42"]
        : []),
      'args=" $* "',
      'if [[ "$args" == *"/manifest"* ]]; then',
      '  out=""',
      '  prev=""',
      '  for arg in "$@"; do',
      '    if [ "$prev" = "-o" ]; then out="$arg"; fi',
      '    prev="$arg"',
      "  done",
      '  [ -n "$out" ] || out="/dev/stdout"',
      '  printf \'{"manifestBase64":"%s"}\\n\' "$REVIEW_ROUTER_TEST_MANIFEST_B64" > "$out"',
      "  exit 0",
      "fi",
      'if [[ "$args" == *"/confirm"* ]]; then',
      '  payload=""',
      '  prev=""',
      '  for arg in "$@"; do',
      '    if [ "$prev" = "--data-binary" ]; then payload="${arg#@}"; fi',
      '    prev="$arg"',
      "  done",
      '  cp "$payload" "$REVIEW_ROUTER_TEST_CONFIRM_CAPTURE"',
      '  if [ -n "${REVIEW_ROUTER_TEST_CONFIRM_FAIL_ONCE_MARKER:-}" ] && [ ! -e "$REVIEW_ROUTER_TEST_CONFIRM_FAIL_ONCE_MARKER" ]; then',
      '    : > "$REVIEW_ROUTER_TEST_CONFIRM_FAIL_ONCE_MARKER"',
      "    exit 28",
      "  fi",
      '  printf \'{"status":"accepted"}\\n\'',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );

  const scriptPath = join(process.cwd(), "scripts/seed-codex-rotating-auth.sh");
  const installerSha256 = createHash("sha256")
    .update(readFileSync(scriptPath))
    .digest("hex");
  const installerUrl = "https://reviewrouter.site/install/codex-rotating";
  const installerVersion = "test";
  const manifestBase64 = Buffer.from(
    JSON.stringify({
      protocolVersion: 1,
      repositoryFullName: "777genius/agent-teams-ai",
      repositoryId: "123456",
      providerInstanceId: "codex-rotating:777genius:agent-teams-ai",
      setupNonce: "setup-nonce-1234567890",
      secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
      authMode: "codex_subscription_oauth_rotating",
      generatedAt: "2026-05-25T12:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      installer: {
        url: installerUrl,
        version: installerVersion,
        sha256: installerSha256,
      },
      generationHashSalt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      accountFingerprintSalt: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
  ).toString("base64url");

  return {
    codexHome,
    home,
    installerSha256,
    installerUrl,
    installerVersion,
    manifestBase64,
    path: `${bin}:${process.env.PATH ?? ""}`,
    scriptPath,
  };
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}
