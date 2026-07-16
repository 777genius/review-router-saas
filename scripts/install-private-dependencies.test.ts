import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
  it("installs build dependencies when the parent environment is production", () => {
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
        "}));",
      ].join("\n"),
    );
    chmodSync(fakePnpmPath, 0o700);

    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts/install-private-dependencies.mjs"),
        "--frozen-lockfile",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CAPTURE_PATH: capturePath,
          NODE_ENV: "production",
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64: "",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
      nodeEnv: "development",
      args: ["install", "--frozen-lockfile"],
    });
  });
});
