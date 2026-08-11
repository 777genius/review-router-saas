import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import {
  resolveCodexReseedInstallRedirect,
  resolveCodexRotatingInstallRedirect,
  resolveCodexRotatingPublicWebUrl,
  resolveCodexRotatingSeedScriptDescriptor,
} from "./codex-rotating-seed-script";

const retiredStableSecretName = "REVIEWROUTER_CODEX_AUTH_JSON";
const testClaimCapability = "codex_claim_11111111-1111-4111-8111-111111111111";
const stableTestIdToken = `e30.${Buffer.from(
  JSON.stringify({
    iss: "https://auth.openai.com",
    sub: "user:test",
    "https://api.openai.com/auth": { chatgpt_account_id: "account:test" },
  }),
).toString("base64url")}.signature`;

describe("resolveCodexRotatingSeedScriptDescriptor", () => {
  it("uses an explicit release-pinned descriptor when provided", () => {
    expect(
      resolveCodexRotatingSeedScriptDescriptor({
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL:
          "https://raw.githubusercontent.com/777genius/review-router/0123456789abcdef0123456789abcdef01234567/scripts/seed-codex-rotating-auth.sh",
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: "v1.0.39",
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      url: "https://raw.githubusercontent.com/777genius/review-router/0123456789abcdef0123456789abcdef01234567/scripts/seed-codex-rotating-auth.sh",
      version: "v1.0.39",
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

  it("rejects an immutable version SHA that disagrees with the Action URL", () => {
    expect(() =>
      resolveCodexRotatingSeedScriptDescriptor({
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL:
          "https://raw.githubusercontent.com/777genius/review-router/0123456789abcdef0123456789abcdef01234567/scripts/seed-codex-rotating-auth.sh",
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: "1".repeat(40),
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: "0".repeat(64),
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("invalid_codex_rotating_installer_version");
  });

  it("builds a local descriptor with a real script hash", () => {
    const descriptor = resolveCodexRotatingSeedScriptDescriptor({
      REVIEW_ROUTER_WEB_URL: "http://localhost:3000",
      REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
        "777genius/review-router@1111111111111111111111111111111111111111",
      NODE_ENV: "development",
    });

    expect(descriptor).toMatchObject({
      url: "http://localhost:3000/install/codex-rotating",
      version: "1111111111111111111111111111111111111111",
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
          REVIEW_ROUTER_WEB_URL: "http://localhost:3000",
          REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          NODE_ENV: "development",
        }),
      ).toMatchObject({
        url: "http://localhost:3000/install/codex-rotating",
        version: "0123456789abcdef0123456789abcdef01234567",
        sha256: expectedSha256,
      });
    } finally {
      process.chdir(repoRoot);
    }
  });

  it("requires an independently issued URL and SHA-256 for hosted bytes", () => {
    expect(() =>
      resolveCodexRotatingSeedScriptDescriptor({
        REVIEW_ROUTER_WEB_URL: "https://reviewrouter.site",
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
        NODE_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("codex_rotating_installer_descriptor_incomplete");
  });

  it("redirects curl clients to the action-pinned raw rotating installer", () => {
    expect(
      resolveCodexRotatingInstallRedirect({
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/0123456789abcdef0123456789abcdef01234567/scripts/seed-codex-rotating-auth.sh",
    );
  });

  it.each([
    "http://reviewrouter.site/installer.sh",
    "ftp://reviewrouter.site/installer.sh",
    "https://user@reviewrouter.site/installer.sh",
    "https://reviewrouter.site/installer.sh#mutable",
    "malformed",
  ])("rejects an unsafe explicit installer URL: %s", (url) => {
    expect(() =>
      resolveCodexRotatingSeedScriptDescriptor({
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL: url,
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: "v1.0.39",
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: "0".repeat(64),
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("invalid_codex_rotating_installer_url");
  });

  it("accepts explicit loopback HTTP installer URLs", () => {
    expect(
      resolveCodexRotatingSeedScriptDescriptor({
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL:
          "http://127.0.0.1:43123/install/codex-rotating",
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION: "local",
        REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256: "0".repeat(64),
      } as unknown as NodeJS.ProcessEnv),
    ).toMatchObject({
      url: "http://127.0.0.1:43123/install/codex-rotating",
    });
  });

  it("never falls back to the mutable general Action channel", () => {
    expect(() =>
      resolveCodexRotatingInstallRedirect({
        REVIEW_ROUTER_ACTION_REF: "777genius/review-router@main",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("missing_env:REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF");
  });

  it("pins the reseed bootstrap to the exact rotating Action SHA", () => {
    expect(
      resolveCodexReseedInstallRedirect({
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/0123456789abcdef0123456789abcdef01234567/scripts/reseed-codex-rotating-auth.sh",
    );
  });

  it("rejects a mutable reseed bootstrap ref", () => {
    expect(() =>
      resolveCodexReseedInstallRedirect({
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: "777genius/review-router@main",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow("invalid_env:REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF");
  });

  it("fails closed without an intentional production setup callback URL", () => {
    expect(() =>
      resolveCodexRotatingPublicWebUrl({
        NODE_ENV: "production",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrowError(new Error("missing_review_router_web_url"));
    expect(
      resolveCodexRotatingPublicWebUrl({
        NODE_ENV: "production",
        REVIEW_ROUTER_WEB_URL: "https://reviewrouter.site/",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("https://reviewrouter.site");
  });

  it("rejects unsafe production setup callback URLs", () => {
    for (const url of [
      "https://localhost:10000",
      "https://127.0.0.1",
      "http://app.reviewrouter.test",
      "https://user@app.reviewrouter.test",
      "https://app.reviewrouter.test?tenant=1",
      "https://app.reviewrouter.test#setup",
      "https://app.reviewrouter.test/setup",
      "malformed",
    ]) {
      expect(() =>
        resolveCodexRotatingSeedScriptDescriptor({
          NODE_ENV: "production",
          REVIEW_ROUTER_WEB_URL: url,
          REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
            "777genius/review-router@1111111111111111111111111111111111111111",
        } as unknown as NodeJS.ProcessEnv),
      ).toThrowError(new Error("invalid_review_router_web_url"));
    }
  });

  it.each([
    "https://reviewrouter.site",
    "http://localhost:43123",
    "http://127.0.0.1:43123",
    "http://setup.localhost:43123",
    "http://[::1]:43123",
  ])(
    "accepts one production or approved loopback ledger origin: %s",
    (origin) => {
      const result = validateInstallerLedgerUrls({
        manifest: `${origin}/api/codex-rotating/setup-manifest`,
        prepare: `${origin}/api/codex-rotating/setup-prepare`,
        dispatch: `${origin}/api/codex-rotating/setup-dispatch`,
        dispatchOutcome: `${origin}/api/codex-rotating/setup-dispatch-outcome`,
        status: `${origin}/api/codex-rotating/setup-status`,
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
  );

  it.each(["prepare", "dispatch", "dispatchOutcome", "status"] as const)(
    "rejects a cross-origin %s ledger endpoint",
    (endpoint) => {
      const urls = {
        manifest: "https://reviewrouter.site/api/codex-rotating/setup-manifest",
        prepare: "https://reviewrouter.site/api/codex-rotating/setup-prepare",
        dispatch: "https://reviewrouter.site/api/codex-rotating/setup-dispatch",
        dispatchOutcome:
          "https://reviewrouter.site/api/codex-rotating/setup-dispatch-outcome",
        status: "https://reviewrouter.site/api/codex-rotating/setup-status",
      };
      urls[endpoint] = `https://attacker.invalid/${endpoint}`;

      const result = validateInstallerLedgerUrls(urls);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Setup ledger URLs must use one HTTPS origin",
      );
    },
  );

  it("rejects non-loopback HTTP ledger URLs", () => {
    const result = validateInstallerLedgerUrls({
      manifest: "http://reviewrouter.site/setup-manifest",
      prepare: "http://reviewrouter.site/setup-prepare",
      dispatch: "http://reviewrouter.site/setup-dispatch",
      dispatchOutcome: "http://reviewrouter.site/setup-dispatch-outcome",
      status: "http://reviewrouter.site/setup-status",
    });

    expect(result.status).not.toBe(0);
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

  it("installer rejects secret-bearing setup manifests as unsupported v2 input", () => {
    const fixture = createRotatingInstallerFixture();
    const manifest = JSON.parse(
      Buffer.from(fixture.manifestBase64, "base64url").toString("utf8"),
    );
    const secretBearingManifest = Buffer.from(
      JSON.stringify({ ...manifest, secretName: retiredStableSecretName }),
    ).toString("base64url");
    const decode = (manifestBase64: string) =>
      spawnSync(
        "bash",
        ["-c", 'source "$1"; decode_manifest', "bash", fixture.scriptPath],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            REVIEW_ROUTER_SEED_LIBRARY_ONLY: "1",
            REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
            REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
            REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
            REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64: manifestBase64,
          },
          encoding: "utf8",
        },
      );

    expect(decode(fixture.manifestBase64).status).toBe(0);
    const result = decode(secretBearingManifest);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      retiredStableSecretName,
    );
  });

  it("installer falls back to sha256sum when shasum is unavailable", () => {
    const fixture = createRotatingInstallerFixture({ shasumFails: true });
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "refresh-token", id_token: stableTestIdToken },
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
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:
            "http://localhost:3000/manifest",
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_PREPARE_URL:
            "http://localhost:3000/prepare",
        },
        encoding: "utf8",
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("[dry-run] one-shot encrypted GitHub PUT");
  });

  it.each([
    ["two", stableTestIdToken.split(".").slice(0, 2).join(".")],
    ["four", `${stableTestIdToken}.extra`],
  ])("installer rejects a %s-segment stable identity token", (_, idToken) => {
    const fixture = createRotatingInstallerFixture({ curlFailsIfCalled: true });
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "refresh-token", id_token: idToken },
      }),
    );

    const result = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: {
        ...recoveryInstallerEnv(fixture, {
          REVIEW_ROUTER_REUSE_EXISTING_CODEX_AUTH_I_KNOW_IT_IS_CURRENT: "1",
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            fixture.manifestBase64,
        }),
      },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "auth.json cannot establish stable provider account identity: not a JWT",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "curl should not have been called",
    );
  });

  it("installer refuses preexisting dedicated auth by default before writing the GitHub secret", () => {
    const fixture = createRotatingInstallerFixture({
      ghSecretSetFailsIfCalled: true,
    });
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          refresh_token: "stale-refresh-token",
          id_token: stableTestIdToken,
        },
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
        tokens: {
          refresh_token: "known-current-refresh-token",
          id_token: stableTestIdToken,
        },
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
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:
            "http://localhost:3000/manifest",
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_PREPARE_URL:
            "http://localhost:3000/prepare",
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[dry-run] one-shot encrypted GitHub PUT");
    expect(result.stdout).toContain("Reusing an existing Codex auth file");
  });

  it("installer force reseed quarantines old dedicated auth and logs in freshly", () => {
    const fixture = createRotatingInstallerFixture();
    const codexArgsPath = join(fixture.home, "codex-args.txt");
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          refresh_token: "old-refresh-token",
          id_token: stableTestIdToken,
        },
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
        tokens: {
          refresh_token: "first-refresh-token",
          id_token: stableTestIdToken,
        },
      }),
    );
    writeFileSync(
      join(accountsDir, "second.auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          refresh_token: "second-refresh-token",
          id_token: stableTestIdToken,
        },
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
        tokens: {
          refresh_token: "shared-refresh-token",
          id_token: stableTestIdToken,
        },
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
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("outside dedicated CODEX_HOME");
    expect(output).toContain(
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
        tokens: {
          refresh_token: "shared-refresh-token",
          id_token: stableTestIdToken,
        },
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
    expect(result.stdout).toContain("[dry-run] one-shot encrypted GitHub PUT");
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
          id_token: stableTestIdToken,
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
          "codex-rotating:123456",
        REVIEW_ROUTER_REPO: "777genius/agent-teams-ai",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:
          "http://localhost:3000/manifest",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_PREPARE_URL:
          "http://localhost:3000/prepare",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_NONCE: "setup-nonce-1234567890",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const confirmation = JSON.parse(readFileSync(confirmCapturePath, "utf8"));
    expect(confirmation).toMatchObject({
      claimId: testClaimCapability,
      attemptId: "attempt:test-12345678",
      outcome: "definite_success",
      responseCode: 204,
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
      providerInstanceId: "codex-rotating:123456",
      secretName:
        "REVIEWROUTER_CODEX_AUTH_JSON_R900001_P0123456789abcdef_E1_0123456789abcdef0123456789abcdef",
      authSource: "explicit-reuse",
    });
    expect(JSON.stringify(state)).not.toContain("refresh-token");
    expect(JSON.stringify(state)).not.toContain("id-token-for-fingerprint");
  });

  it("fetches before login and claims the exact payload before the secret write", () => {
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
          "codex-rotating:123456",
        REVIEW_ROUTER_REPO: "777genius/agent-teams-ai",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:
          "http://localhost:3000/manifest",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_PREPARE_URL:
          "http://localhost:3000/prepare",
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
    const prepareIndex = events.findIndex((event) =>
      event.includes("/prepare"),
    );
    const confirmIndex = events.findIndex((event) =>
      event.includes("/confirm"),
    );

    expect(loginIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeLessThan(loginIndex);
    expect(prepareIndex).toBeGreaterThan(loginIndex);
    expect(writeIndex).toBeGreaterThan(prepareIndex);
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
        tokens: { refresh_token: "refresh-token", id_token: stableTestIdToken },
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
          "codex-rotating:123456",
        REVIEW_ROUTER_REPO: "777genius/agent-teams-ai",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:
          "http://localhost:3000/manifest",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_PREPARE_URL:
          "http://localhost:3000/prepare",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_NONCE: "setup-nonce-1234567890",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.status).toBe(0);
    const confirms = readFileSync(eventCapturePath, "utf8")
      .split("\n")
      .filter((event) => event.includes("/confirm"));
    expect(confirms).toHaveLength(2);
    expect(
      confirms.every(
        (event) =>
          event.includes("--connect-timeout 10") &&
          event.includes("--max-time 30"),
      ),
    ).toBe(true);
  });

  it("retries a lost prepare response with the same safe claim", () => {
    const fixture = createRotatingInstallerFixture();
    const prepareFailure = join(fixture.home, "prepare-failed-once");
    const events = join(fixture.home, "prepare-events.log");
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          refresh_token: "prepare-retry-secret",
          id_token: stableTestIdToken,
        },
      }),
    );
    const result = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: recoveryInstallerEnv(fixture, {
        REVIEW_ROUTER_REUSE_EXISTING_CODEX_AUTH_I_KNOW_IT_IS_CURRENT: "1",
        REVIEW_ROUTER_TEST_EVENT_CAPTURE: events,
        REVIEW_ROUTER_TEST_PREPARE_FAIL_ONCE_MARKER: prepareFailure,
      }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(
      readFileSync(events, "utf8")
        .split("\n")
        .filter((event) => event.includes("/prepare")),
    ).toHaveLength(2);
    expect(
      `${result.stdout}${result.stderr}${readFileSync(events, "utf8")}`,
    ).not.toContain("prepare-retry-secret");
  });

  it("disables shell xtrace before the claim capability is received", () => {
    const fixture = createRotatingInstallerFixture();
    const events = join(fixture.home, "xtrace-events.log");
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          refresh_token: "xtrace-refresh-secret",
          id_token: stableTestIdToken,
        },
      }),
    );

    const result = spawnSync(
      "bash",
      ["-x", fixture.scriptPath, "--confirm-write"],
      {
        cwd: process.cwd(),
        env: recoveryInstallerEnv(fixture, {
          REVIEW_ROUTER_REUSE_EXISTING_CODEX_AUTH_I_KNOW_IT_IS_CURRENT: "1",
          REVIEW_ROUTER_TEST_EVENT_CAPTURE: events,
        }),
        encoding: "utf8",
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(
      `${result.stdout}${result.stderr}${readFileSync(events, "utf8")}`,
    ).not.toContain(testClaimCapability);
  });

  it("retires a lost PUT namespace and ignores later mutable auth", () => {
    const fixture = createRotatingInstallerFixture();
    const putFailure = join(fixture.home, "put-failed-once");
    const firstEvents = join(fixture.home, "put-first.log");
    const first = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: recoveryInstallerEnv(fixture, {
        REVIEW_ROUTER_FORCE_CODEX_RESEED: "1",
        REVIEW_ROUTER_TEST_CODEX_LOGIN_WRITES_AUTH: "1",
        REVIEW_ROUTER_TEST_EVENT_CAPTURE: firstEvents,
        REVIEW_ROUTER_TEST_GH_FAIL_ONCE_MARKER: putFailure,
      }),
      encoding: "utf8",
    });
    expect(first.status).not.toBe(0);
    expect(readFileSync(firstEvents, "utf8")).toContain("gh:secret set");

    const retryEvents = join(fixture.home, "put-retry.log");
    const retry = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: recoveryInstallerEnv(fixture, {
        REVIEW_ROUTER_FORCE_CODEX_RESEED: "1",
        REVIEW_ROUTER_TEST_CODEX_LOGIN_WRITES_AUTH: "1",
        REVIEW_ROUTER_TEST_PAYLOAD_CLAIMED: "true",
        REVIEW_ROUTER_TEST_EVENT_CAPTURE: retryEvents,
      }),
      encoding: "utf8",
    });
    expect(retry.status).toBe(0);
    expect(readFileSync(retryEvents, "utf8")).not.toContain("codex:login");
    const statusRequest = readFileSync(retryEvents, "utf8")
      .split("\n")
      .find((event) => event.includes("/status"));
    expect(statusRequest).toContain("-X POST");
    expect(statusRequest).toContain("--data-binary @");
    expect(statusRequest).not.toContain("claimId=");

    const rotated = createRotatingInstallerFixture();
    const rotatedFailure = join(rotated.home, "put-failed-once");
    const seed = spawnSync("bash", [rotated.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: recoveryInstallerEnv(rotated, {
        REVIEW_ROUTER_FORCE_CODEX_RESEED: "1",
        REVIEW_ROUTER_TEST_CODEX_LOGIN_WRITES_AUTH: "1",
        REVIEW_ROUTER_TEST_GH_FAIL_ONCE_MARKER: rotatedFailure,
      }),
      encoding: "utf8",
    });
    expect(seed.status).not.toBe(0);
    writeFileSync(
      join(rotated.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          refresh_token: "rotated-auth-must-not-dispatch",
          id_token: stableTestIdToken,
        },
      }),
    );
    const rotatedEvents = join(rotated.home, "rotated-retry.log");
    const rejected = spawnSync(
      "bash",
      [rotated.scriptPath, "--confirm-write"],
      {
        cwd: process.cwd(),
        env: recoveryInstallerEnv(rotated, {
          REVIEW_ROUTER_FORCE_CODEX_RESEED: "1",
          REVIEW_ROUTER_TEST_PAYLOAD_CLAIMED: "true",
          REVIEW_ROUTER_TEST_EVENT_CAPTURE: rotatedEvents,
        }),
        encoding: "utf8",
      },
    );
    expect(rejected.status).toBe(0);
    expect(readFileSync(rotatedEvents, "utf8")).toContain("gh:secret set");
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(
      "rotated-auth-must-not-dispatch",
    );

    const tampered = createRotatingInstallerFixture();
    const tamperedFailure = join(tampered.home, "put-failed-once");
    expect(
      spawnSync("bash", [tampered.scriptPath, "--confirm-write"], {
        cwd: process.cwd(),
        env: recoveryInstallerEnv(tampered, {
          REVIEW_ROUTER_FORCE_CODEX_RESEED: "1",
          REVIEW_ROUTER_TEST_CODEX_LOGIN_WRITES_AUTH: "1",
          REVIEW_ROUTER_TEST_GH_FAIL_ONCE_MARKER: tamperedFailure,
        }),
        encoding: "utf8",
      }).status,
    ).not.toBe(0);
    const stateDirectory = join(tampered.codexHome, "pending-secret-payloads");
    const stateFile = readdirSync(stateDirectory)[0];
    expect(stateFile).toBeTruthy();
    writeFileSync(join(stateDirectory, stateFile!), '{"stateVersion":99}', {
      mode: 0o600,
    });
    const tamperedEvents = join(tampered.home, "tampered-retry.log");
    const tamperedRetry = spawnSync(
      "bash",
      [tampered.scriptPath, "--confirm-write"],
      {
        cwd: process.cwd(),
        env: recoveryInstallerEnv(tampered, {
          REVIEW_ROUTER_FORCE_CODEX_RESEED: "1",
          REVIEW_ROUTER_TEST_PAYLOAD_CLAIMED: "true",
          REVIEW_ROUTER_TEST_EVENT_CAPTURE: tamperedEvents,
        }),
        encoding: "utf8",
      },
    );
    expect(tamperedRetry.status).not.toBe(0);
    expect(`${tamperedRetry.stdout}${tamperedRetry.stderr}`).toContain(
      "fresh recovery epoch will retire any authorized namespace permanently",
    );
    expect(readFileSync(tamperedEvents, "utf8")).not.toContain("gh:secret set");
  }, 45_000);

  it("does not redispatch a payload that the server already confirmed", () => {
    const fixture = createRotatingInstallerFixture();
    const firstEvents = join(fixture.home, "confirmed-first.log");
    const first = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: recoveryInstallerEnv(fixture, {
        REVIEW_ROUTER_FORCE_CODEX_RESEED: "1",
        REVIEW_ROUTER_TEST_CODEX_LOGIN_WRITES_AUTH: "1",
        REVIEW_ROUTER_TEST_CONFIRM_ALWAYS_FAIL: "1",
        REVIEW_ROUTER_TEST_EVENT_CAPTURE: firstEvents,
      }),
      encoding: "utf8",
    });
    expect(first.status).not.toBe(0);
    expect(readFileSync(firstEvents, "utf8")).toContain("gh:secret set");

    const retryEvents = join(fixture.home, "confirmed-retry.log");
    const retry = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: recoveryInstallerEnv(fixture, {
        REVIEW_ROUTER_FORCE_CODEX_RESEED: "1",
        REVIEW_ROUTER_TEST_PAYLOAD_CLAIMED: "true",
        REVIEW_ROUTER_TEST_PREPARE_STATUS: "active",
        REVIEW_ROUTER_TEST_EVENT_CAPTURE: retryEvents,
      }),
      encoding: "utf8",
    });
    expect(retry.status).toBe(0);
    expect(readFileSync(retryEvents, "utf8")).not.toContain("codex:login");
    expect(readFileSync(retryEvents, "utf8")).not.toContain("gh:secret set");
    expect(readFileSync(retryEvents, "utf8")).not.toContain("/confirm");
  });

  it("refuses a remote claim when local retry state is missing", () => {
    const fixture = createRotatingInstallerFixture();
    const events = join(fixture.home, "missing-marker.log");
    const result = spawnSync("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: recoveryInstallerEnv(fixture, {
        REVIEW_ROUTER_FORCE_CODEX_RESEED: "1",
        REVIEW_ROUTER_TEST_PAYLOAD_CLAIMED: "true",
        REVIEW_ROUTER_TEST_EVENT_CAPTURE: events,
      }),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("local journal is missing");
    expect(readFileSync(events, "utf8")).not.toContain("codex:login");
    expect(readFileSync(events, "utf8")).not.toContain("gh:secret set");
  });

  it("recovers an abandoned repository lock", () => {
    const fixture = createRotatingInstallerFixture();
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "refresh-token", id_token: stableTestIdToken },
      }),
    );
    const lockDirectory = join(fixture.codexHome, "active-repository-setups");
    mkdirSync(lockDirectory, { recursive: true });
    const lockId = createHash("sha256")
      .update("777genius/agent-teams-ai")
      .digest("hex");
    const exitedPid = spawnSync("bash", ["-c", "printf %s $$"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(exitedPid).toMatch(/^[1-9][0-9]*$/u);
    writeFileSync(join(lockDirectory, `${lockId}.lock`), `${exitedPid}\n`);

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
    expect(result.stdout).toContain("[dry-run] one-shot encrypted GitHub PUT");
  });

  it("rejects a concurrent installer before login, manifest fetch, or secret write", async () => {
    const fixture = createRotatingInstallerFixture();
    const loginReady = join(fixture.home, "login-ready");
    const releaseLogin = join(fixture.home, "release-login");
    const firstEvents = join(fixture.home, "first-events.log");
    const secondEvents = join(fixture.home, "second-events.log");
    const confirmCapture = join(fixture.home, "confirm.json");
    const commonEnv = {
      ...process.env,
      PATH: fixture.path,
      HOME: fixture.home,
      REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
      REVIEW_ROUTER_FORCE_CODEX_RESEED: "1",
      REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
      REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
      REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
      REVIEW_ROUTER_CODEX_ROTATING_PROVIDER_INSTANCE_ID:
        "codex-rotating:123456",
      REVIEW_ROUTER_REPO: "777genius/agent-teams-ai",
      REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL: "http://localhost:3000/manifest",
      REVIEW_ROUTER_CODEX_ROTATING_SETUP_PREPARE_URL:
        "http://localhost:3000/prepare",
      REVIEW_ROUTER_CODEX_ROTATING_SETUP_NONCE: "setup-nonce-1234567890",
      REVIEW_ROUTER_TEST_MANIFEST_B64: fixture.manifestBase64,
      REVIEW_ROUTER_TEST_CONFIRM_CAPTURE: confirmCapture,
      REVIEW_ROUTER_TEST_CODEX_LOGIN_WRITES_AUTH: "1",
    };
    const first = spawn("bash", [fixture.scriptPath, "--confirm-write"], {
      cwd: process.cwd(),
      env: {
        ...commonEnv,
        REVIEW_ROUTER_TEST_EVENT_CAPTURE: firstEvents,
        REVIEW_ROUTER_TEST_CODEX_LOGIN_READY: loginReady,
        REVIEW_ROUTER_TEST_CODEX_LOGIN_RELEASE: releaseLogin,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const firstResultPromise = collectProcess(first);

    try {
      await waitForFile(loginReady);
      const second = spawnSync(
        "bash",
        [fixture.scriptPath, "--confirm-write"],
        {
          cwd: process.cwd(),
          env: {
            ...commonEnv,
            REVIEW_ROUTER_TEST_EVENT_CAPTURE: secondEvents,
          },
          encoding: "utf8",
        },
      );

      expect(second.status).not.toBe(0);
      expect(second.stderr).toContain(
        "A rotating Codex setup is already running",
      );
      const events = readFileSync(secondEvents, "utf8");
      expect(events).not.toContain("codex:");
      expect(events).not.toContain("curl:");
      expect(events).not.toContain("gh:secret set");
    } finally {
      writeFileSync(releaseLogin, "release\n");
    }

    const firstResult = await firstResultPromise;
    expect(firstResult.status).toBe(0);
    expect(firstResult.stderr).toBe("");
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
          "codex-rotating:123456",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:
          "http://localhost:3000/manifest",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_PREPARE_URL:
          "http://localhost:3000/prepare",
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
        tokens: { refresh_token: "refresh-token", id_token: stableTestIdToken },
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
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL:
            "http://localhost:3000/manifest",
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_PREPARE_URL:
            "http://localhost:3000/prepare",
        },
        encoding: "utf8",
      });

    const first = run();
    expect(first.status).not.toBe(0);
    expect(first.stderr).toContain("Missing immutable recovery epoch");
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
      'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "token" ]; then printf "test-provider-token\\n"; exit 0; fi',
      'if [ "${1:-}" = "api" ] && [ "${2:-}" = "repos/777genius/agent-teams-ai" ]; then printf "123456\\n"; exit 0; fi',
      'if [ "${1:-}" = "api" ] && [[ " $* " == *" repos/777genius/agent-teams-ai/actions/secrets/public-key "* ]]; then printf \'{"key_id":"key-test-1","key":"QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE="}\\n\'; exit 0; fi',
      'if [ "${1:-}" = "secret" ] && [ "${2:-}" = "set" ]; then',
      "  cat >/dev/null",
      '  if [ -n "${REVIEW_ROUTER_TEST_GH_FAIL_ONCE_MARKER:-}" ] && [ ! -e "$REVIEW_ROUTER_TEST_GH_FAIL_ONCE_MARKER" ]; then : > "$REVIEW_ROUTER_TEST_GH_FAIL_ONCE_MARKER"; exit 28; fi',
      options.ghSecretSetFailsIfCalled
        ? '  echo "gh secret set should not be called" >&2; exit 43'
        : '  printf "ZW5jcnlwdGVkLXByb3ZpZGVyLXBheWxvYWQ=\\n"; exit 0',
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
      'if [ "${1:-}" = "login" ] && [ -n "${REVIEW_ROUTER_TEST_CODEX_LOGIN_READY:-}" ]; then',
      '  : > "$REVIEW_ROUTER_TEST_CODEX_LOGIN_READY"',
      '  while [ ! -e "${REVIEW_ROUTER_TEST_CODEX_LOGIN_RELEASE:?}" ]; do sleep 0.05; done',
      "fi",
      'if [ "${1:-}" = "login" ] && [ "${REVIEW_ROUTER_TEST_CODEX_LOGIN_WRITES_AUTH:-}" = "1" ]; then',
      '  mkdir -p "${CODEX_HOME:?}"',
      '  printf \'{"auth_mode":"chatgpt","tokens":{"refresh_token":"fresh-refresh-token","access_token":"fresh-access-token","id_token":"e30.eyJpc3MiOiJodHRwczovL2F1dGgub3BlbmFpLmNvbSIsInN1YiI6InVzZXI6dGVzdCIsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2NvdW50OnRlc3QifX0.signature"}}\' > "$CODEX_HOME/auth.json"',
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
      'import crypto from "node:crypto";',
      'import fs from "node:fs";',
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
      'if [ "${1:-}" = "-q" ] && [ "${2:-}" = "--config" ] && [ "${3:-}" = "-" ]; then cat >/dev/null; printf "204"; exit 0; fi',
      'args=" $* "',
      'if [[ "$args" == *"/manifest"* ]]; then',
      '  out=""',
      '  prev=""',
      '  for arg in "$@"; do',
      '    if [ "$prev" = "-o" ]; then out="$arg"; fi',
      '    prev="$arg"',
      "  done",
      '  [ -n "$out" ] || out="/dev/stdout"',
      '  claimed="${REVIEW_ROUTER_TEST_PAYLOAD_CLAIMED:-false}"',
      '  printf \'{"manifestBase64":"%s","recoveryExpiresAt":"2999-01-02T00:00:00.000Z","payloadClaimed":%s,"recoveryEpoch":"1"}\\n\' "$REVIEW_ROUTER_TEST_MANIFEST_B64" "$claimed" > "$out"',
      '  printf "200"',
      "  exit 0",
      "fi",
      'if [[ "$args" == *"/prepare"* ]]; then',
      '  if [ -n "${REVIEW_ROUTER_TEST_PREPARE_FAIL_ONCE_MARKER:-}" ] && [ ! -e "$REVIEW_ROUTER_TEST_PREPARE_FAIL_ONCE_MARKER" ]; then : > "$REVIEW_ROUTER_TEST_PREPARE_FAIL_ONCE_MARKER"; exit 28; fi',
      '  out=""',
      '  prev=""',
      '  for arg in "$@"; do',
      '    if [ "$prev" = "-o" ]; then out="$arg"; fi',
      '    prev="$arg"',
      "  done",
      '  [ -n "$out" ] || out="/dev/stdout"',
      '  printf \'{"status":"%s","claimId":"codex_claim_11111111-1111-4111-8111-111111111111","claimVersion":1,"prepareReplayExpiresAt":"2999-01-01T00:00:00.000Z","recoveryExpiresAt":"2999-01-02T00:00:00.000Z"}\\n\' "${REVIEW_ROUTER_TEST_PREPARE_STATUS:-prepared}" > "$out"',
      '  printf "201"',
      "  exit 0",
      "fi",
      'if [[ "$args" == *"/dispatch"* ]] && [[ "$args" != *"/dispatch-outcome"* ]]; then',
      '  out=""; prev=""; for arg in "$@"; do if [ "$prev" = "-o" ]; then out="$arg"; fi; prev="$arg"; done',
      '  [ -n "$out" ] || out="/dev/stdout"',
      '  printf \'{"claimId":"codex_claim_11111111-1111-4111-8111-111111111111","attemptId":"attempt:test-12345678","namespaceId":"namespace:test-12345678","namespaceEpoch":"1","secretName":"REVIEWROUTER_CODEX_AUTH_JSON_R900001_P0123456789abcdef_E1_0123456789abcdef0123456789abcdef","status":"dispatch_authorized","dispatchExpiresAt":"2999-01-01T00:00:00.000Z"}\\n\' > "$out"',
      '  printf "200"',
      "  exit 0",
      "fi",
      'if [[ "$args" == *"/status"* ]]; then',
      '  out=""; prev=""; for arg in "$@"; do if [ "$prev" = "-o" ]; then out="$arg"; fi; prev="$arg"; done',
      '  [ -n "$out" ] || out="/dev/stdout"',
      '  printf \'{"status":"%s","claimId":"codex_claim_11111111-1111-4111-8111-111111111111","attempt":null}\\n\' "${REVIEW_ROUTER_TEST_STATUS:-prepared}" > "$out"',
      '  printf "200"',
      "  exit 0",
      "fi",
      'if [[ "$args" == *"/confirm"* ]] || [[ "$args" == *"/dispatch-outcome"* ]]; then',
      '  payload=""',
      '  prev=""',
      '  for arg in "$@"; do',
      '    if [ "$prev" = "--data-binary" ]; then payload="${arg#@}"; fi',
      '    prev="$arg"',
      "  done",
      '  cp "$payload" "$REVIEW_ROUTER_TEST_CONFIRM_CAPTURE"',
      '  if [ -n "${REVIEW_ROUTER_TEST_CONFIRM_ALWAYS_FAIL:-}" ]; then exit 28; fi',
      '  if [ -n "${REVIEW_ROUTER_TEST_CONFIRM_FAIL_ONCE_MARKER:-}" ] && [ ! -e "$REVIEW_ROUTER_TEST_CONFIRM_FAIL_ONCE_MARKER" ]; then',
      '    : > "$REVIEW_ROUTER_TEST_CONFIRM_FAIL_ONCE_MARKER"',
      "    exit 28",
      "  fi",
      '  printf "200"',
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
      protocolVersion: 2,
      repositoryFullName: "777genius/agent-teams-ai",
      repositoryId: "123456",
      providerInstanceId: "codex-rotating:123456",
      setupNonce: "setup-nonce-1234567890",
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
    path: `${bin}:${dirname(process.execPath)}:${process.env.REVIEW_ROUTER_TEST_NATIVE_LOCK_PATH ?? process.env.PATH ?? ""}`,
    scriptPath,
  };
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function recoveryInstallerEnv(
  fixture: ReturnType<typeof createRotatingInstallerFixture>,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: fixture.path,
    HOME: fixture.home,
    REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
    REVIEW_ROUTER_INSTALLER_URL: fixture.installerUrl,
    REVIEW_ROUTER_INSTALLER_VERSION: fixture.installerVersion,
    REVIEW_ROUTER_INSTALLER_SHA256: fixture.installerSha256,
    REVIEW_ROUTER_CODEX_ROTATING_PROVIDER_INSTANCE_ID: "codex-rotating:123456",
    REVIEW_ROUTER_REPO: "777genius/agent-teams-ai",
    REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL: "http://localhost:3000/manifest",
    REVIEW_ROUTER_CODEX_ROTATING_SETUP_PREPARE_URL:
      "http://localhost:3000/prepare",
    REVIEW_ROUTER_CODEX_ROTATING_SETUP_DISPATCH_URL:
      "http://localhost:3000/dispatch",
    REVIEW_ROUTER_CODEX_ROTATING_SETUP_DISPATCH_OUTCOME_URL:
      "http://localhost:3000/dispatch-outcome",
    REVIEW_ROUTER_CODEX_ROTATING_SETUP_STATUS_URL:
      "http://localhost:3000/status",
    REVIEW_ROUTER_CODEX_ROTATING_SETUP_NONCE: "setup-nonce-1234567890",
    REVIEW_ROUTER_TEST_MANIFEST_B64: fixture.manifestBase64,
    REVIEW_ROUTER_TEST_CONFIRM_CAPTURE: join(fixture.home, "confirm.json"),
    ...extra,
  };
}

function validateInstallerLedgerUrls(urls: {
  readonly manifest: string;
  readonly prepare: string;
  readonly dispatch: string;
  readonly dispatchOutcome: string;
  readonly status: string;
}) {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; resolve_versioned_ledger_urls',
      "ledger-validator",
      join(process.cwd(), "scripts/seed-codex-rotating-auth.sh"),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REVIEW_ROUTER_SEED_LIBRARY_ONLY: "1",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL: urls.manifest,
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_PREPARE_URL: urls.prepare,
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_DISPATCH_URL: urls.dispatch,
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_DISPATCH_OUTCOME_URL:
          urls.dispatchOutcome,
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_STATUS_URL: urls.status,
      },
      encoding: "utf8",
    },
  );
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function collectProcess(process: ReturnType<typeof spawn>): Promise<{
  readonly status: number | null;
  readonly stderr: string;
}> {
  let stderr = "";
  process.stderr?.setEncoding("utf8");
  process.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    process.once("error", reject);
    process.once("close", resolve);
  });
  return { status, stderr };
}
