import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const seedScript = path.join(repoRoot, "scripts/seed-codex-auth.sh");

describe("seed-codex-auth.sh", () => {
  it("prints a repository secret dry-run without leaking auth JSON", async () => {
    const fixture = await createFixture();

    const result = await runSeedScript(fixture, {}, [
      "--dry-run",
      "--scope",
      "repo",
      "--repo",
      "777genius/example",
    ]);

    expect(result.stdout).toContain("ReviewRouter Codex OAuth secret seeding");
    expect(result.stdout).toContain(
      "Validated auth.json before writing secrets",
    );
    expect(result.stdout).toContain(
      "[dry-run] gh secret set CODEX_AUTH_JSON --repo 777genius/example <",
    );
    expect(result.stdout + result.stderr).not.toContain(fixture.refreshToken);
  });

  it("prints an organization selected-repositories dry-run", async () => {
    const fixture = await createFixture();

    const result = await runSeedScript(fixture, {
      REVIEW_ROUTER_DRY_RUN: "1",
      REVIEW_ROUTER_SECRET_SCOPE: "org",
      REVIEW_ROUTER_REPO: "agent-teams-ai/tvaity",
      REVIEW_ROUTER_ORG: "agent-teams-ai",
      REVIEW_ROUTER_ORG_SECRET_REPOS: "tvaity,docs",
    });

    expect(result.stdout).toContain(
      "[dry-run] gh secret set CODEX_AUTH_JSON --org agent-teams-ai --repos tvaity,docs --app actions <",
    );
    expect(result.stdout + result.stderr).not.toContain(fixture.refreshToken);
  });

  it("fails before secret writes when auth.json is not ChatGPT OAuth", async () => {
    const fixture = await createFixture({
      authJson: { auth_mode: "api_key", tokens: { refresh_token: "bad" } },
    });

    await expect(
      runSeedScript(fixture, {
        REVIEW_ROUTER_DRY_RUN: "1",
        REVIEW_ROUTER_SECRET_SCOPE: "repo",
        REVIEW_ROUTER_REPO: "777genius/example",
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("auth.json auth_mode must be chatgpt"),
    });
  });

  it("prints a reseed auth.json recovery hint before any secret write", async () => {
    const fixture = await createFixture({
      authJson: { auth_mode: "chatgpt", tokens: {} },
    });

    await expect(
      runSeedScript(fixture, {
        REVIEW_ROUTER_CONFIRM_WRITE: "1",
        REVIEW_ROUTER_SECRET_SCOPE: "repo",
        REVIEW_ROUTER_REPO: "777genius/example",
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("To reseed auth.json"),
    });
  });

  it("warns when Codex OAuth looks stale without leaking token values", async () => {
    const fixture = await createFixture({
      authJson: {
        auth_mode: "chatgpt",
        last_refresh: "2026-01-01T00:00:00.000Z",
        tokens: { refresh_token: "stale-refresh-token-that-must-not-leak" },
      },
    });

    const result = await runSeedScript(
      fixture,
      { REVIEW_ROUTER_DRY_RUN: "1" },
      ["--scope", "repo", "--repo", "777genius/example", "--stale-days", "1"],
    );

    expect(result.stderr).toContain(
      "WARN auth.json last_refresh is older than 1 day",
    );
    expect(result.stdout + result.stderr).not.toContain(
      "stale-refresh-token-that-must-not-leak",
    );
  });

  it("warns when Codex OAuth last_refresh metadata is missing", async () => {
    const fixture = await createFixture();

    const result = await runSeedScript(fixture, {
      REVIEW_ROUTER_DRY_RUN: "1",
      REVIEW_ROUTER_SECRET_SCOPE: "repo",
      REVIEW_ROUTER_REPO: "777genius/example",
    });

    expect(result.stderr).toContain("WARN auth.json last_refresh is missing");
  });

  it("refuses non-interactive secret writes without explicit confirmation", async () => {
    const fixture = await createFixture();

    await expect(
      runSeedScript(fixture, {
        REVIEW_ROUTER_SECRET_SCOPE: "repo",
        REVIEW_ROUTER_REPO: "777genius/example",
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Refusing to write secrets in non-interactive mode without confirmation",
      ),
    });
  });

  it("writes repository secrets only after explicit non-interactive confirmation", async () => {
    const fixture = await createFixture();

    const result = await runSeedScript(fixture, {
      REVIEW_ROUTER_CONFIRM_WRITE: "1",
      REVIEW_ROUTER_SECRET_SCOPE: "repo",
      REVIEW_ROUTER_REPO: "777genius/example",
    });

    expect(result.stdout).toContain(
      "Stored repo secret CODEX_AUTH_JSON for 777genius/example",
    );
    expect(result.stdout + result.stderr).not.toContain(fixture.refreshToken);
  });

  it("prints help without requiring gh or auth.json", async () => {
    const fixture = await createFixture();

    const result = await runSeedScript(fixture, {}, ["--help"]);

    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("--confirm-write");
  });
});

async function createFixture(input?: {
  readonly authJson?: Record<string, unknown>;
}): Promise<{
  readonly root: string;
  readonly codexHome: string;
  readonly binDir: string;
  readonly refreshToken: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "reviewrouter-seed-test-"));
  const codexHome = path.join(root, ".codex");
  const binDir = path.join(root, "bin");
  await mkdir(codexHome, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const refreshToken = "refresh-token-that-must-not-leak";
  await writeFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify(
      input?.authJson ?? {
        auth_mode: "chatgpt",
        tokens: { refresh_token: refreshToken },
      },
    ),
  );

  const ghPath = path.join(binDir, "gh");
  await writeFile(
    ghPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then exit 0; fi',
      'if [ "${1:-}" = "secret" ] && [ "${2:-}" = "set" ]; then cat >/dev/null; exit 0; fi',
      'echo "unexpected gh call: $*" >&2',
      "exit 2",
      "",
    ].join("\n"),
  );
  await chmod(ghPath, 0o755);

  return { root, codexHome, binDir, refreshToken };
}

async function runSeedScript(
  fixture: {
    readonly root: string;
    readonly codexHome: string;
    readonly binDir: string;
  },
  env: Record<string, string>,
  args: readonly string[] = [],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return execFileAsync("bash", [seedScript, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      HOME: fixture.root,
      REVIEW_ROUTER_CODEX_HOME: fixture.codexHome,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    },
  });
}
