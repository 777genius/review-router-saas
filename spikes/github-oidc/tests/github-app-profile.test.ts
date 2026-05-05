import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadAppProfile } from "../src/config";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const useProfileScript = path.join(
  repoRoot,
  "scripts/use-github-app-profile.mjs",
);

describe("use-github-app-profile.mjs", () => {
  it("applies a saved GitHub App profile without leaking secrets", async () => {
    const fixture = await createFixture();

    const result = await execFileAsync(
      "node",
      [
        useProfileScript,
        "--profile",
        fixture.profileFile,
        "--env-file",
        fixture.envFile,
      ],
      { cwd: repoRoot },
    );

    const env = await readFile(fixture.envFile, "utf8");
    expect(env).toContain('GITHUB_APP_ID="123456"');
    expect(env).toContain('GITHUB_APP_SLUG="review-router-test"');
    expect(env).toContain(`GITHUB_APP_PRIVATE_KEY_FILE="${fixture.keyFile}"`);
    expect(env).not.toContain("GITHUB_APP_PRIVATE_KEY=");
    expect(env).toContain(`REVIEW_ROUTER_APP_PROFILE="${fixture.profileFile}"`);
    expect(env).toContain('REVIEW_ROUTER_WEB_URL="http://localhost:3000"');
    expect(env).not.toContain("https://reviewrouter.site");
    expect(result.stdout + result.stderr).not.toContain(fixture.clientSecret);
    expect(result.stdout + result.stderr).not.toContain(fixture.webhookSecret);
  });

  it("can intentionally include hosted profile URLs", async () => {
    const fixture = await createFixture();

    await execFileAsync(
      "node",
      [
        useProfileScript,
        "--profile",
        fixture.profileFile,
        "--env-file",
        fixture.envFile,
        "--include-urls",
      ],
      { cwd: repoRoot },
    );

    const env = await readFile(fixture.envFile, "utf8");
    expect(env).toContain('REVIEW_ROUTER_WEB_URL="https://reviewrouter.site"');
    expect(env).toContain(
      'REVIEW_ROUTER_API_URL="https://api.reviewrouter.site"',
    );
  });
});

describe("loadAppProfile", () => {
  it("accepts generated GitHub App profile keys", async () => {
    const fixture = await createFixture();

    const profile = loadAppProfile(fixture.profileFile);

    expect(profile.APP_ID).toBe(123456);
    expect(profile.APP_CLIENT_ID).toBe("client-id");
    expect(profile.APP_SLUG).toBe("review-router-test");
    expect(profile.APP_PRIVATE_KEY_FILE).toBe(fixture.keyFile);
    expect(profile.privateKey).toContain("test-private-key-body");
  });
});

async function createFixture(): Promise<{
  readonly clientSecret: string;
  readonly envFile: string;
  readonly keyFile: string;
  readonly profileFile: string;
  readonly webhookSecret: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "reviewrouter-app-profile-"));
  const keyFile = path.join(root, "review-router-test.pem");
  const profileFile = path.join(root, "review-router-test.env");
  const envFile = path.join(root, ".env.local");
  const clientSecret = "client-secret-that-must-not-leak";
  const webhookSecret = "webhook-secret-that-must-not-leak";

  await mkdir(root, { recursive: true });
  await writeFile(
    keyFile,
    [
      "-----BEGIN RSA PRIVATE KEY-----",
      "test-private-key-body",
      "-----END RSA PRIVATE KEY-----",
      "",
    ].join("\n"),
  );
  await writeFile(
    profileFile,
    [
      'GITHUB_APP_ID="123456"',
      'GITHUB_APP_CLIENT_ID="client-id"',
      `GITHUB_APP_CLIENT_SECRET="${clientSecret}"`,
      'GITHUB_APP_SLUG="review-router-test"',
      `GITHUB_APP_PRIVATE_KEY_FILE="${keyFile}"`,
      `GITHUB_WEBHOOK_SECRET="${webhookSecret}"`,
      'GITHUB_CLIENT_ID="client-id"',
      `GITHUB_CLIENT_SECRET="${clientSecret}"`,
      'REVIEW_ROUTER_WEB_URL="https://reviewrouter.site"',
      'REVIEW_ROUTER_API_URL="https://api.reviewrouter.site"',
      "",
    ].join("\n"),
  );
  await writeFile(
    envFile,
    [
      'DATABASE_URL="postgresql://localhost/review_router"',
      'REVIEW_ROUTER_WEB_URL="http://localhost:3000"',
      'REVIEW_ROUTER_API_URL="http://localhost:4000"',
      'GITHUB_APP_ID="old"',
      'GITHUB_APP_SLUG="old"',
      'GITHUB_APP_PRIVATE_KEY="old-inline-key-that-must-be-removed"',
      "",
    ].join("\n"),
  );

  return { clientSecret, envFile, keyFile, profileFile, webhookSecret };
}
