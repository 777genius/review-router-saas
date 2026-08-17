import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("private dependency installer", () => {
  function createFakePnpm() {
    const directory = mkdtempSync(join(tmpdir(), "reviewrouter-install-test-"));
    temporaryDirectories.push(directory);
    const capturePath = join(directory, "capture.json");
    const fakePnpmPath = join(directory, "pnpm");
    writeFileSync(
      fakePnpmPath,
      [
        "#!/usr/bin/env node",
        'const { writeFileSync } = require("node:fs");',
        "writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({",
        "  nodeEnv: process.env.NODE_ENV,",
        "  args: process.argv.slice(2),",
        "  deployKeyPresent: 'SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64' in process.env,",
        "  gitSshCommand: process.env.GIT_SSH_COMMAND ?? null,",
        "}));",
      ].join("\n"),
    );
    chmodSync(fakePnpmPath, 0o700);

    return { capturePath, directory };
  }

  function runInstaller(
    directory: string,
    arguments_: string[],
    deployKey: string | undefined,
  ) {
    return spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts/install-private-dependencies.mjs"),
        ...arguments_,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CAPTURE_PATH: join(directory, "capture.json"),
          NODE_ENV: "production",
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64: deployKey,
        },
      },
    );
  }

  it("installs build dependencies when the parent environment is production", () => {
    const { capturePath, directory } = createFakePnpm();

    const result = runInstaller(directory, ["--frozen-lockfile"], "");

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
      nodeEnv: "development",
      args: ["install", "--frozen-lockfile"],
      deployKeyPresent: true,
      gitSshCommand: null,
    });
  });

  it("fails before pnpm when a required deploy key is missing", () => {
    const { capturePath, directory } = createFakePnpm();
    const result = runInstaller(
      directory,
      ["--frozen-lockfile", "--require-deploy-key"],
      "",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64 is required",
    );
    expect(existsSync(capturePath)).toBe(false);
  });

  it("rejects malformed base64 before pnpm", () => {
    const { capturePath, directory } = createFakePnpm();
    const result = runInstaller(
      directory,
      ["--require-deploy-key"],
      "not-base64!",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not valid base64");
    expect(existsSync(capturePath)).toBe(false);
  });

  it("rejects decoded values that are not OpenSSH private keys", () => {
    const { capturePath, directory } = createFakePnpm();
    const result = runInstaller(
      directory,
      ["--require-deploy-key"],
      Buffer.from("not an OpenSSH key", "utf8").toString("base64"),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not an OpenSSH key");
    expect(existsSync(capturePath)).toBe(false);
  });

  it("uses a required key without forwarding the control flag or secret", () => {
    const { capturePath, directory } = createFakePnpm();
    const privateKey = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "test-key-material",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const result = runInstaller(
      directory,
      ["--frozen-lockfile", "--require-deploy-key"],
      Buffer.from(privateKey, "utf8").toString("base64"),
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
      nodeEnv: "development",
      args: ["install", "--frozen-lockfile"],
      deployKeyPresent: false,
      gitSshCommand: expect.stringContaining("StrictHostKeyChecking=yes"),
    });
  });
});
