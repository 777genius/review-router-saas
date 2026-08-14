import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const syncedFiles = [
  "action.yml",
  "action-dist/index.cjs",
  "action-dist/codex/linux-x64/codex-linux-x64.tgz",
  "action-dist/codex/linux-x64/manifest.json",
  "scripts/seed-codex-rotating-auth.sh",
  "scripts/reseed-codex-rotating-auth.sh",
];

describe("public Action runtime sync", () => {
  it("exposes one authoritative workflow path list", () => {
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts/sync-public-action-runtime.mjs"),
        "--print-files",
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(syncedFiles);
  });

  it("copies every installer byte referenced by immutable Action URLs", () => {
    const root = mkdtempSync(join(tmpdir(), "rr-public-action-sync-"));
    try {
      const saasRepo = join(root, "saas");
      const actionRepo = join(root, "action");
      initializeRepository(saasRepo);
      initializeRepository(actionRepo);

      for (const file of syncedFiles) {
        const source = join(saasRepo, file);
        mkdirSync(dirname(source), { recursive: true });
        const contents =
          file === "action-dist/index.cjs"
            ? "@vioxen/subscription-runtime 777genius+ar\n"
            : `exact bytes for ${file}\n`;
        writeFileSync(source, contents);
      }

      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), "scripts/sync-public-action-runtime.mjs"),
          "--saas-repo",
          saasRepo,
          "--action-repo",
          actionRepo,
          "--write",
        ],
        { encoding: "utf8" },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      for (const file of syncedFiles) {
        expect(readFileSync(join(actionRepo, file))).toEqual(
          readFileSync(join(saasRepo, file)),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses exact staged and unstaged filenames without truncation", () => {
    expect(
      parseGitPorcelainPaths(
        " M scripts/seed-codex-rotating-auth.sh\0" +
          "M  action-dist/index.cjs\0",
      ),
    ).toEqual(["scripts/seed-codex-rotating-auth.sh", "action-dist/index.cjs"]);
  });

  it.each([
    ["installer-only", ["scripts/seed-codex-rotating-auth.sh"]],
    [
      "mixed",
      [
        "action-dist/index.cjs",
        "scripts/seed-codex-rotating-auth.sh",
        "scripts/reseed-codex-rotating-auth.sh",
      ],
    ],
  ])("detects, stages, and fully commits %s changes", (_, changedFiles) => {
    const root = mkdtempSync(join(tmpdir(), "rr-public-action-workflow-"));
    try {
      const saasRepo = join(root, "saas");
      const actionRepo = join(root, "action");
      initializeRepository(saasRepo);
      initializeRepository(actionRepo);
      for (const file of syncedFiles) {
        writeSyncedFixture(saasRepo, file, "baseline");
        writeSyncedFixture(actionRepo, file, "baseline");
      }
      commitAll(actionRepo, "baseline");
      for (const file of changedFiles) {
        writeSyncedFixture(saasRepo, file, "release");
      }

      const sync = spawnSync(
        process.execPath,
        [
          join(process.cwd(), "scripts/sync-public-action-runtime.mjs"),
          "--saas-repo",
          saasRepo,
          "--action-repo",
          actionRepo,
          "--write",
        ],
        { encoding: "utf8" },
      );
      expect(sync.status, `${sync.stdout}\n${sync.stderr}`).toBe(0);

      const detected = parseGitPorcelainPaths(
        gitRaw(actionRepo, [
          "status",
          "--porcelain=v1",
          "-z",
          "--",
          ...syncedFiles,
        ]),
      );
      const expectedChangedFiles = [...changedFiles].sort();
      expect(detected).toEqual(expectedChangedFiles);

      git(actionRepo, ["add", "--", ...syncedFiles]);
      expect(git(actionRepo, ["diff", "--cached", "--name-only", "--"])).toBe(
        expectedChangedFiles.join("\n"),
      );
      git(actionRepo, ["commit", "-q", "-m", "sync"]);
      expect(
        git(actionRepo, ["status", "--porcelain", "--", ...syncedFiles]),
      ).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gates and serializes the credential-bearing workflow", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/sync-public-action-runtime.yml"),
      "utf8",
    );
    expect(workflow).toContain("group: sync-public-action-runtime\n");
    expect(workflow).toContain('$DISPATCH_REF" != "refs/heads/main"');
    expect(workflow).toContain("current origin/main");
    expect(workflow).toContain("node scripts/release-gate-evidence.mjs verify");
    expect(workflow).toContain(
      "REVIEW_ROUTER_RELEASE_GATE_SHA: ${{ steps.source.outputs.sha }}",
    );
    expect(workflow).not.toContain("gh run list");
    expect(workflow).not.toMatch(/uses: [^@\n]+@v\d/gu);
    expect(workflow.match(/--print-files/g)).toHaveLength(2);
    expect(workflow).toContain('git add -- "${synced_files[@]}"');
    expect(workflow).toContain("synced files changed after commit/rebase");
    expect(workflow.indexOf("Resolve exact current main SHA")).toBeLessThan(
      workflow.indexOf("Require cross-repository sync credential"),
    );
    expect(
      workflow.indexOf("Recheck checkout is exact current origin/main"),
    ).toBeLessThan(
      workflow.indexOf("Require cross-repository sync credential"),
    );
    expect(
      workflow.indexOf("Recheck checkout is exact current origin/main"),
    ).toBeLessThan(workflow.indexOf("Install SaaS dependencies"));
    expect(
      workflow.indexOf("Require exact PostgreSQL publication-gate evidence"),
    ).toBeLessThan(
      workflow.indexOf("Require cross-repository sync credential"),
    );
    expect(
      workflow.indexOf("Require exact PostgreSQL publication-gate evidence"),
    ).toBeLessThan(workflow.indexOf("Build and verify public action artifact"));
  });

  it("publishes one release descriptor only after both installer bytes match", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/release.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      'cmp scripts/seed-codex-rotating-auth.sh "$descriptor_dir/seed.sh"',
    );
    expect(workflow).toContain(
      'cmp scripts/reseed-codex-rotating-auth.sh "$descriptor_dir/reseed.sh"',
    );
    expect(workflow).toContain(
      "reviewrouter.codex-rotating-installer-descriptor.v1",
    );
    expect(workflow).toContain(
      "Upload immutable rotating installer descriptor",
    );
    expect(workflow).toContain(
      'descriptor_sha256="$(sha256sum "$descriptor_path"',
    );
    expect(workflow).toContain(
      "Rotating installer descriptor SHA-256: $INSTALLER_DESCRIPTOR_SHA256",
    );
    expect(workflow).toContain('runtime_path="release-assets/hosted-runtime-image.json"');
    expect(workflow).toContain("--draft\n");
    expect(workflow).toContain(
      "Published immutable release $VERSION is missing required assets",
    );
    expect(workflow).toContain('if [[ "$release_is_draft" != "true" ]]');
    expect(workflow).toContain('gh release upload "$VERSION"');
    expect(workflow).toContain('gh release edit "$VERSION"');
    expect(workflow).toContain("--draft=false");
  });

  it("verifies the hosted runtime image through an anonymous pull", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/release.yml"),
      "utf8",
    );
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("docker logout ghcr.io");
    expect(workflow).toContain('docker pull "$IMAGE_URL"');
    expect(workflow).not.toContain("packages/container");
    expect(workflow).not.toContain("visibility=public");
  });
});

function writeSyncedFixture(repo: string, file: string, version: string): void {
  const target = join(repo, file);
  mkdirSync(dirname(target), { recursive: true });
  const runtimeMarker =
    file === "action-dist/index.cjs"
      ? "@vioxen/subscription-runtime 777genius+ar "
      : "";
  writeFileSync(target, `${runtimeMarker}${version} bytes for ${file}\n`);
}

function commitAll(repo: string, message: string): void {
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", message]);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitRaw(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function parseGitPorcelainPaths(output: string): string[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
}

function initializeRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.name", "test"], { cwd: path });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: path,
  });
}
