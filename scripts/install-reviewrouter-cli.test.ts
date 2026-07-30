import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("reviewrouter CLI installer", () => {
  it("installs a self-contained bundle and atomically replaces a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reviewrouter-cli-"));
    const binDirectory = path.join(root, "bin");
    const dataDirectory = path.join(root, "data");
    const sentinelPath = path.join(root, "sentinel");
    const installedPath = path.join(binDirectory, "reviewrouter");

    await writeFile(sentinelPath, "unchanged", { mode: 0o600 });
    await mkdir(binDirectory, { recursive: true });
    await symlink(sentinelPath, installedPath);

    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/install-reviewrouter-cli.mjs"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          REVIEW_ROUTER_CLI_BIN_DIR: binDirectory,
          REVIEW_ROUTER_CLI_DATA_DIR: dataDirectory,
        },
      },
    );

    expect(stdout.trim()).toBe(installedPath);
    expect(await readFile(sentinelPath, "utf8")).toBe("unchanged");
    expect((await lstat(installedPath)).isSymbolicLink()).toBe(false);
    const wrapper = await readFile(installedPath, "utf8");
    expect(wrapper).toContain(dataDirectory);
    expect(wrapper).not.toContain(process.cwd());

    const help = await execFileAsync(installedPath, ["--help"]);
    expect(help.stdout).toContain("reviewrouter config set");
  });
});
