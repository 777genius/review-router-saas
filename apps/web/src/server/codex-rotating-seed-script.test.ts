import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            fixture.manifestBase64,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[dry-run] gh secret set");
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
      'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then',
      options.ghAuthenticated === false
        ? '  echo "not logged in" >&2; exit 1'
        : "  exit 0",
      "fi",
      'if [ "${1:-}" = "api" ] && [ "${2:-}" = "repos/777genius/agent-teams-ai" ]; then printf "123456\\n"; exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  writeExecutable(
    join(bin, "codex"),
    ["#!/usr/bin/env bash", "exit 0", ""].join("\n"),
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
