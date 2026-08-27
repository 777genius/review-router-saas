import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
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
        "  gitSshVariant: process.env.GIT_SSH_VARIANT ?? null,",
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
    cwd = process.cwd(),
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
        cwd,
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
      gitSshVariant: null,
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
    const invalidPrivateKey = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "test-key-material",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const invalidResult = runInstaller(
      directory,
      ["--frozen-lockfile", "--require-deploy-key"],
      Buffer.from(invalidPrivateKey, "utf8").toString("base64"),
    );

    expect(invalidResult.status).toBe(1);
    expect(invalidResult.stderr).toContain(
      "is not a valid OpenSSH private key",
    );
    expect(existsSync(capturePath)).toBe(false);

    const keyPath = join(directory, "test-key");
    const generatedKey = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-f", keyPath],
      { encoding: "utf8" },
    );
    expect(generatedKey.status).toBe(0);

    const result = runInstaller(
      directory,
      ["--frozen-lockfile", "--require-deploy-key"],
      Buffer.from(readFileSync(keyPath, "utf8"), "utf8").toString("base64"),
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
      nodeEnv: "development",
      args: [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--ignore-pnpmfile",
      ],
      deployKeyPresent: false,
      gitSshCommand: expect.stringContaining("StrictHostKeyChecking=yes"),
      gitSshVariant: null,
    });
    expect(result.stderr).toContain(
      "private dependency credential teardown verified",
    );
  });

  it.each([
    [".npmrc", "script-shell=./steal-key.sh\n"],
    [".pnpmfile.cjs", "module.exports = { hooks: {} };\n"],
    ["pnpmfile.cjs", "module.exports = { hooks: {} };\n"],
  ])("rejects tracked executable pnpm config %s before pnpm", (path, value) => {
    const { capturePath, directory } = createFakePnpm();
    const repository = mkdtempSync(join(tmpdir(), "reviewrouter-config-test-"));
    temporaryDirectories.push(repository);
    mkdirSync(join(repository, "scripts"));
    cpSync(
      "scripts/install-private-dependencies.mjs",
      join(repository, "scripts/install-private-dependencies.mjs"),
    );
    writeFileSync(
      join(repository, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n\nonlyBuiltDependencies:\n  - prisma\n",
    );
    writeFileSync(join(repository, path), value);
    expect(spawnSync("git", ["init", "-q"], { cwd: repository }).status).toBe(
      0,
    );
    expect(spawnSync("git", ["add", "."], { cwd: repository }).status).toBe(0);
    const keyPath = join(directory, "test-key");
    expect(
      spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath])
        .status,
    ).toBe(0);
    const result = runInstaller(
      directory,
      ["--require-deploy-key"],
      Buffer.from(readFileSync(keyPath, "utf8")).toString("base64"),
      repository,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "tracked executable pnpm configuration is forbidden",
    );
    expect(existsSync(capturePath)).toBe(false);
  });

  it.each([
    "hooks:\n  readPackage: ./steal-key.mjs\n",
    "configDependencies:\n  hook: ./steal-key.tgz\n",
    "pnpmfile: ./steal-key.cjs\n",
  ])("rejects workspace hook redirection before pnpm", (addition) => {
    const { capturePath, directory } = createFakePnpm();
    const repository = mkdtempSync(
      join(tmpdir(), "reviewrouter-workspace-test-"),
    );
    temporaryDirectories.push(repository);
    mkdirSync(join(repository, "scripts"));
    cpSync(
      "scripts/install-private-dependencies.mjs",
      join(repository, "scripts/install-private-dependencies.mjs"),
    );
    writeFileSync(
      join(repository, "pnpm-workspace.yaml"),
      `packages:\n  - packages/*\n\nonlyBuiltDependencies:\n  - prisma\n${addition}`,
    );
    expect(spawnSync("git", ["init", "-q"], { cwd: repository }).status).toBe(
      0,
    );
    expect(spawnSync("git", ["add", "."], { cwd: repository }).status).toBe(0);
    const keyPath = join(directory, "test-key");
    expect(
      spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath])
        .status,
    ).toBe(0);
    const result = runInstaller(
      directory,
      ["--require-deploy-key"],
      Buffer.from(readFileSync(keyPath, "utf8")).toString("base64"),
      repository,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "pnpm-workspace executable configuration denied",
    );
    expect(existsSync(capturePath)).toBe(false);
  });
});
