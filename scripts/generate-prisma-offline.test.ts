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
import {
  assertOfflinePrismaGenerateEnvironment,
  forwardedGenerateEnvironment,
  offlinePrismaGenerateInvocation,
} from "./generate-prisma-offline.mjs";

const temporaryDirectories: string[] = [];
const generatorSecrets = {
  DATABASE_URL: "postgresql://secret@db/prod",
  REVIEW_ROUTER_DATABASE_URL_FILE: "/not-a-real-database-url-file",
  REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_DATABASE_URL:
    "postgresql://secret@db/control",
  REVIEW_ROUTER_RELEASE_WITNESS_SIGNING_PRIVATE_KEY_PEM: "test-signing-key",
  REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "test-witness",
  AUTH_SECRET: "test-auth-secret",
  npm_config__authToken: "test-npm-token",
  NPM_CONFIG__AUTH: "test-npm-auth",
  COREPACK_NPM_TOKEN: "test-corepack-token",
};

type ToolEvent = {
  tool: string;
  secretNames: string[];
  pnpmHome?: string;
  prismaEngine?: string;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("offline Prisma generate", () => {
  function createFakeTools(isolationAvailable = true) {
    const directory = mkdtempSync(
      join(tmpdir(), "reviewrouter-prisma-generate-test-"),
    );
    temporaryDirectories.push(directory);
    const capturePath = join(directory, "capture.json");
    const eventsPath = join(directory, "events.jsonl");
    const fixturePath = join(directory, "capture-tool.mts");
    writeFileSync(
      fixturePath,
      [
        'import { spawnSync } from "node:child_process";',
        'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
        `const path = ${JSON.stringify(capturePath)};`,
        "const tool = process.argv[2];",
        "const args = process.argv.slice(3);",
        `const secretNames = ${JSON.stringify(Object.keys(generatorSecrets))};`,
        `appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({`,
        "  tool, secretNames: secretNames.filter(name => name in process.env),",
        "  pnpmHome: process.env.PNPM_HOME, prismaEngine: process.env.PRISMA_QUERY_ENGINE_LIBRARY,",
        "}) + '\\n');",
        "if (tool === 'sudo') process.exit(1);",
        "if (tool === 'unshare') {",
        `  if (!${isolationAvailable}) process.exit(1);`,
        "  const separator = args.indexOf('--');",
        "  writeFileSync(path, JSON.stringify({",
        "    unshareArgs: args,",
        "    deployKeyPresent: 'SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64' in process.env,",
        "    gitSshCommand: process.env.GIT_SSH_COMMAND ?? null,",
        "  }));",
        "  const command = args[separator + 1];",
        "  if (separator < 0 || !command) process.exit(1);",
        "  const child = spawnSync(command, args.slice(separator + 2), {",
        "    env: process.env,",
        "    stdio: 'inherit',",
        "  });",
        "  process.exit(child.status ?? 1);",
        "}",
        "let captured: Record<string, unknown> = {};",
        "try {",
        "  if (existsSync(path)) captured = JSON.parse(readFileSync(path, 'utf8'));",
        "} catch {}",
        "captured.pnpmArgs = args;",
        "captured.pnpmDeployKeyPresent = 'SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64' in process.env;",
        "captured.pnpmGitSshCommand = process.env.GIT_SSH_COMMAND ?? null;",
        "writeFileSync(path, JSON.stringify(captured));",
      ].join("\n"),
    );
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const tool of ["unshare", "sudo", "pnpm"]) {
      writeFileSync(
        join(directory, tool),
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} ${tool} "$@"\n`,
      );
      chmodSync(join(directory, tool), 0o700);
    }
    const readEvents = (): ToolEvent[] =>
      readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as ToolEvent);
    return { capturePath, directory, readEvents };
  }

  function runGenerate(
    directory: string,
    env: Record<string, string | undefined>,
  ) {
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      REVIEW_ROUTER_PRISMA_GENERATE_PLATFORM: "linux",
    };
    for (const name of [
      "SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64",
      "GIT_SSH_COMMAND",
      "GIT_SSH_VARIANT",
      "REVIEW_ROUTER_PRISMA_NETWORK_ALREADY_ISOLATED",
      "REVIEW_ROUTER_REQUIRE_OFFLINE_PRISMA",
      "REVIEW_ROUTER_PRISMA_GENERATE_USER",
    ])
      delete childEnv[name];
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[name];
      else childEnv[name] = value;
    }
    return spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts/generate-prisma-offline.mjs")],
      {
        encoding: "utf8",
        env: childEnv,
      },
    );
  }

  it("refuses to generate while deploy-key material remains", () => {
    expect(() =>
      assertOfflinePrismaGenerateEnvironment({
        SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64: "abc",
      }),
    ).toThrow(/SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64 still present/u);
    expect(() =>
      assertOfflinePrismaGenerateEnvironment({
        GIT_SSH_COMMAND: "ssh -i /tmp/key",
      }),
    ).toThrow(/GIT_SSH_COMMAND still present/u);
  });

  it("isolates Linux Prisma generate from the network", () => {
    expect(
      offlinePrismaGenerateInvocation(
        {
          REVIEW_ROUTER_PRISMA_GENERATE_PLATFORM: "linux",
        },
        "unshare",
      ),
    ).toEqual({
      command: "unshare",
      args: [
        "--net",
        "--",
        "pnpm",
        "--filter",
        "@reviewrouter/platform-db",
        "db:generate",
      ],
    });
  });

  it("drops back to the caller after privileged network isolation", () => {
    const invocation = offlinePrismaGenerateInvocation(
      {
        ...generatorSecrets,
        REVIEW_ROUTER_PRISMA_GENERATE_PLATFORM: "linux",
        REVIEW_ROUTER_PRISMA_GENERATE_USER: "runner",
        PATH: "/opt/pnpm:/usr/bin",
        HOME: "/home/runner",
        DATABASE_URL: "postgresql://secret@db/prod",
        REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "witness",
        SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64: "must-not-forward",
      },
      "sudo-unshare",
      "/opt/pnpm/pnpm",
    );
    expect(invocation.command).toBe("sudo");
    expect(invocation.args.slice(0, 12)).toEqual([
      "-n",
      "unshare",
      "--net",
      "--",
      "sudo",
      "-n",
      "-u",
      "runner",
      "--",
      "env",
      "-i",
      "--",
    ]);
    expect(invocation.args).toContain("PATH=/opt/pnpm:/usr/bin");
    expect(invocation.args).toContain("HOME=/home/runner");
    expect(invocation.args.join("\n")).not.toContain(
      "SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64",
    );
    expect(invocation.args.join("\n")).not.toContain("DATABASE_URL");
    expect(invocation.args.join("\n")).not.toContain("REVIEW_ROUTER_");
    for (const name of Object.keys(generatorSecrets))
      expect(
        invocation.args.some((argument: string) =>
          argument.startsWith(`${name}=`),
        ),
      ).toBe(false);
    expect(invocation.args.slice(-4)).toEqual([
      "/opt/pnpm/pnpm",
      "--filter",
      "@reviewrouter/platform-db",
      "db:generate",
    ]);
  });

  it("does not forward database or Review Router secrets into sudo env", () => {
    expect(
      forwardedGenerateEnvironment({
        PATH: "/opt/pnpm:/usr/bin",
        HOME: "/home/runner",
        DATABASE_URL: "postgresql://secret@db/prod",
        TEST_DATABASE_URL: "postgresql://secret@db/test",
        REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: "witness",
        REVIEW_ROUTER_PRISMA_GENERATE_USER: "runner",
        AUTH_SECRET: "auth",
        PRISMA_QUERY_ENGINE_LIBRARY: "/opt/prisma/libquery.so",
        PRISMA_SECRET: "must-not-forward",
      }),
    ).toEqual({
      PATH: "/opt/pnpm:/usr/bin",
      HOME: "/home/runner",
      PRISMA_QUERY_ENGINE_LIBRARY: "/opt/prisma/libquery.so",
    });
  });

  it("skips unshare when the caller already isolated the network", () => {
    expect(
      offlinePrismaGenerateInvocation(
        {
          REVIEW_ROUTER_PRISMA_NETWORK_ALREADY_ISOLATED: "1",
        },
        "none",
      ),
    ).toEqual({
      command: "pnpm",
      args: ["--filter", "@reviewrouter/platform-db", "db:generate"],
    });
  });

  it("fails closed on non-Linux when offline isolation is required", () => {
    const { directory } = createFakeTools();
    const result = runGenerate(directory, {
      REVIEW_ROUTER_PRISMA_GENERATE_PLATFORM: "darwin",
      REVIEW_ROUTER_REQUIRE_OFFLINE_PRISMA: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Linux network isolation");
  });

  it("runs unprivileged Prisma generate without deploy-key material", () => {
    const { capturePath, directory } = createFakeTools();
    const result = runGenerate(directory, {
      SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64: undefined,
      GIT_SSH_COMMAND: undefined,
      GIT_SSH_VARIANT: undefined,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
      unshareArgs: [
        "--net",
        "--",
        join(directory, "pnpm"),
        "--filter",
        "@reviewrouter/platform-db",
        "db:generate",
      ],
      deployKeyPresent: false,
      gitSshCommand: null,
      pnpmArgs: ["--filter", "@reviewrouter/platform-db", "db:generate"],
      pnpmDeployKeyPresent: false,
      pnpmGitSshCommand: null,
    });
  });

  it("uses an already-isolated network without calling unshare", () => {
    const { capturePath, directory } = createFakeTools();
    const result = runGenerate(directory, {
      REVIEW_ROUTER_PRISMA_NETWORK_ALREADY_ISOLATED: "1",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
      pnpmArgs: ["--filter", "@reviewrouter/platform-db", "db:generate"],
      pnpmDeployKeyPresent: false,
      pnpmGitSshCommand: null,
    });
  });

  it.each(["unshare", "fallback", "already-isolated"] as const)(
    "keeps secrets out of actual %s probes and generator children",
    (mode) => {
      const { directory, readEvents } = createFakeTools(mode !== "fallback");
      const result = runGenerate(directory, {
        ...generatorSecrets,
        PNPM_HOME: directory,
        PRISMA_QUERY_ENGINE_LIBRARY: "/test/local-prisma-engine.so",
        REVIEW_ROUTER_PRISMA_NETWORK_ALREADY_ISOLATED:
          mode === "already-isolated" ? "1" : undefined,
        REVIEW_ROUTER_REQUIRE_OFFLINE_PRISMA: undefined,
      });

      expect(result.status).toBe(0);
      const events = readEvents();
      expect(events.map((event) => event.tool)).toEqual(
        mode === "unshare"
          ? ["unshare", "unshare", "pnpm"]
          : mode === "fallback"
            ? ["unshare", "sudo", "pnpm"]
            : ["pnpm"],
      );
      for (const event of events) {
        expect(event.secretNames).toEqual([]);
        expect(event.pnpmHome).toBe(directory);
        expect(event.prismaEngine).toBe("/test/local-prisma-engine.so");
      }
      if (mode === "fallback")
        expect(result.stderr).toContain("without network isolation");
    },
  );

  it("does not run pnpm when Linux isolation is unavailable and required", () => {
    const { capturePath, directory, readEvents } = createFakeTools(false);
    const result = runGenerate(directory, {
      ...generatorSecrets,
      REVIEW_ROUTER_PRISMA_NETWORK_ALREADY_ISOLATED: undefined,
      REVIEW_ROUTER_REQUIRE_OFFLINE_PRISMA: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not isolate the network");
    const events = readEvents();
    expect(events.map((event) => event.tool)).toEqual(["unshare", "sudo"]);
    for (const event of events) expect(event.secretNames).toEqual([]);
    expect(existsSync(capturePath)).toBe(false);
  });

  it("does not spawn pnpm when a parent deploy key is still set", () => {
    const { capturePath, directory } = createFakeTools();
    const result = runGenerate(directory, {
      SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64: "not-a-real-key",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "prisma generate refused: SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64 still present",
    );
    expect(existsSync(capturePath)).toBe(false);
  });

  it("keeps private-install consumers on the offline generate helper", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const migration = readFileSync(
      ".github/workflows/codex-rotating-release-migration.yml",
      "utf8",
    );
    const blueprint = readFileSync("render.yaml", "utf8");
    const dockerfile = readFileSync("deploy/self-hosted/Dockerfile", "utf8");
    const helper = "node scripts/generate-prisma-offline.mjs";
    expect(ci.match(new RegExp(helper, "gu"))).toHaveLength(4);
    expect(ci).not.toMatch(/run: pnpm db:generate/u);
    expect(ci).toContain('REVIEW_ROUTER_REQUIRE_OFFLINE_PRISMA: "1"');
    expect(readFileSync("package.json", "utf8")).toContain(
      '"db:generate:offline": "REVIEW_ROUTER_REQUIRE_OFFLINE_PRISMA=1 node scripts/generate-prisma-offline.mjs"',
    );
    expect(migration.match(new RegExp(helper, "gu"))).toHaveLength(2);
    expect(blueprint.match(new RegExp(helper, "gu"))).toHaveLength(2);
    expect(blueprint).toContain(
      "env -u SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64 -u GIT_SSH_COMMAND -u GIT_SSH_VARIANT node scripts/generate-prisma-offline.mjs",
    );
    expect(dockerfile).toContain("RUN --network=none");
    expect(dockerfile).toContain(
      "REVIEW_ROUTER_PRISMA_NETWORK_ALREADY_ISOLATED=1",
    );
    expect(dockerfile).toContain(helper);
    expect(dockerfile).not.toContain(
      "pnpm --filter @reviewrouter/platform-db db:generate",
    );
  });
});
