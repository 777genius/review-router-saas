import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExactActionReleaseWorktree,
  createDetachedActionReleaseCheckout,
} from "./support/paired-action-saas-e2e-harness.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

describe("paired Action release worktree", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("accepts the exact clean Action commit", async () => {
    const fixture = await createActionRepository();

    await expect(
      assertExactActionReleaseWorktree(fixture.root, fixture.head),
    ).resolves.toBeUndefined();
  });

  it("isolates the exact committed release from a dirty source worktree", async () => {
    const fixture = await createActionRepository();
    await mkdir(path.join(fixture.root, "node_modules"));
    await writeFile(path.join(fixture.root, "dist/index.js"), "dirty\n");
    await writeFile(
      path.join(fixture.root, "src/untracked.ts"),
      "export {};\n",
    );
    const detachedRoot = await mkdtemp(
      path.join(tmpdir(), "reviewrouter-paired-action-detached-"),
    );
    temporaryRoots.push(detachedRoot);
    const detached = path.join(detachedRoot, "action-release");

    await createDetachedActionReleaseCheckout({
      sourceActionDir: fixture.root,
      targetDirectory: detached,
      actionRef: fixture.head,
    });

    await expect(
      assertExactActionReleaseWorktree(detached, fixture.head),
    ).resolves.toBeUndefined();
    await expect(
      readFile(path.join(detached, "dist/index.js"), "utf8"),
    ).resolves.toBe("committed\n");
    await expect(
      readFile(path.join(detached, "src/untracked.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects tracked and untracked release-relevant changes", async () => {
    const tracked = await createActionRepository();
    await writeFile(path.join(tracked.root, "dist/index.js"), "dirty\n");

    await expect(
      assertExactActionReleaseWorktree(tracked.root, tracked.head),
    ).rejects.toThrow("paired_action_release_worktree_dirty");

    const untracked = await createActionRepository();
    await writeFile(
      path.join(untracked.root, "src/untracked.ts"),
      "export {};\n",
    );

    await expect(
      assertExactActionReleaseWorktree(untracked.root, untracked.head),
    ).rejects.toThrow("paired_action_release_worktree_dirty");
  });

  it("ignores unrelated files but rejects a different Action HEAD", async () => {
    const fixture = await createActionRepository();
    await writeFile(path.join(fixture.root, "README.md"), "local notes\n");

    await expect(
      assertExactActionReleaseWorktree(fixture.root, fixture.head),
    ).resolves.toBeUndefined();
    await expect(
      assertExactActionReleaseWorktree(fixture.root, "a".repeat(40)),
    ).rejects.toThrow("paired_action_ref_checkout_mismatch");
  });

  it("rejects a dirty checkout before the child runner imports Action modules", async () => {
    const fixture = await createActionRepository();
    const configPath = path.join(fixture.root, "runner-config.json");
    await writeFile(
      path.join(fixture.root, "src/untracked.ts"),
      "export {};\n",
    );
    await writeFile(
      configPath,
      JSON.stringify({
        scenario: "success",
        actionSourceDir: fixture.root,
        actionRef: fixture.head,
        releaseManifestHash: "b".repeat(64),
      }),
    );

    const runnerPath = path.resolve(
      "scripts/review-investigation-paired-e2e/support/paired-action-runner.ts",
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", runnerPath, configPath],
      { cwd: process.cwd() },
    );

    expect(stdout).toContain("paired_action_release_worktree_dirty");
    expect(stdout).not.toContain("Cannot find module");
  });
});

async function createActionRepository(): Promise<{
  root: string;
  head: string;
}> {
  const root = await mkdtemp(
    path.join(tmpdir(), "reviewrouter-paired-action-release-"),
  );
  temporaryRoots.push(root);
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "dist/index.js"), "committed\n");
  await writeFile(path.join(root, "src/index.ts"), "export {};\n");
  await writeFile(path.join(root, "README.md"), "committed\n");
  await git(root, ["init", "-q"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "test: action release"]);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  return { root, head };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (
    await execFileAsync("git", args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_AUTHOR_EMAIL: "reviewrouter@example.invalid",
        GIT_AUTHOR_NAME: "ReviewRouter Test",
        GIT_COMMITTER_EMAIL: "reviewrouter@example.invalid",
        GIT_COMMITTER_NAME: "ReviewRouter Test",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    })
  ).stdout;
}
