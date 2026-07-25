import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkReleaseManifest } from "./check-public-review-action-v2-release-manifest.mjs";
import {
  exportPublicContract,
  parseArgs as parseExportArgs,
} from "./export-public-review-action-v2-contract.mjs";
import { generateReleaseManifest } from "./generate-public-review-action-v2-release-manifest.mjs";
import {
  HANDOFF_MANIFEST_FILE,
  parseHandoffManifest,
  PUBLIC_GENERATED_DIRECTORY,
} from "./lib/review-action-v2-release-manifests.mjs";

const temporaryDirectories: string[] = [];
const sourceDirectory = "generated-contract";
const targetBranch = "feat/review-action-v2-contract";
const fixtureRoot = join(
  process.cwd(),
  "scripts/fixtures/review-action-v2-release",
);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("public Review Action v2 contract handoff", () => {
  it("exports, commits, generates, and verifies one immutable release", async () => {
    const fixture = createRepositories();
    const exported = await exportFixture(fixture, { write: true });
    expect(exported.handoff.saasSourceCommit).toBe(fixture.saasHead);
    expect(exported.handoff.expectedPublicActionBaseCommit).toBe(
      fixture.actionBase,
    );

    const targetRoot = join(
      fixture.actionRepo,
      ...PUBLIC_GENERATED_DIRECTORY.split("/"),
    );
    const handoff = parseHandoffManifest(
      readFileSync(join(targetRoot, HANDOFF_MANIFEST_FILE), "utf8"),
    );
    expect(Object.keys(handoff.generatedFileDigests)).toEqual([
      "canonicalizer.js",
      "golden/unsupported-protocol.json",
      "manifest.json",
      "schema.json",
    ]);

    write(join(fixture.actionRepo, "dist/index.js"), "fresh bundle\n");
    write(
      join(fixture.actionRepo, "dist/context-gateway.js"),
      "fresh context gateway\n",
    );
    git(fixture.actionRepo, [
      "add",
      PUBLIC_GENERATED_DIRECTORY,
      "dist/index.js",
      "dist/context-gateway.js",
    ]);
    git(fixture.actionRepo, ["commit", "-m", "feat: add v2 contract"]);
    const actionCommit = head(fixture.actionRepo);
    const releasePath = join(fixture.root, "release-manifest.json");
    const release = generateReleaseManifest({
      actionRepo: fixture.actionRepo,
      targetBranch,
      expectedHead: actionCommit,
      runtimeEntrypointPath: "dist/index.js",
      contextGatewayEntrypointPath: "dist/context-gateway.js",
      contextGatewayPolicyVersion: "review-context-gateway.v1",
      output: releasePath,
    });
    expect(release.manifest.actionCommitSha).toBe(actionCommit);
    expect(release.manifest.runtimeCommitSha).toBe(actionCommit);
    expect(
      checkReleaseManifest({
        manifest: releasePath,
        saasRepo: fixture.saasRepo,
        actionRepo: fixture.actionRepo,
        sourceDirectory,
      }),
    ).toMatchObject({
      saasSourceCommit: fixture.saasHead,
      actionCommitSha: actionCommit,
    });

    expect(
      generateReleaseManifest({
        actionRepo: fixture.actionRepo,
        targetBranch,
        expectedHead: actionCommit,
        runtimeEntrypointPath: "dist/index.js",
        contextGatewayEntrypointPath: "dist/context-gateway.js",
        contextGatewayPolicyVersion: "review-context-gateway.v1",
        output: releasePath,
      }).bytes,
    ).toBe(release.bytes);
    writeFileSync(releasePath, "different\n");
    expect(() =>
      generateReleaseManifest({
        actionRepo: fixture.actionRepo,
        targetBranch,
        expectedHead: actionCommit,
        runtimeEntrypointPath: "dist/index.js",
        contextGatewayEntrypointPath: "dist/context-gateway.js",
        contextGatewayPolicyVersion: "review-context-gateway.v1",
        output: releasePath,
      }),
    ).toThrow("refusing to overwrite a different release manifest");
  });

  it("refuses main and stale or abbreviated commit fences", async () => {
    const fixture = createRepositories();
    expect(() =>
      parseExportArgs([
        "--action-repo",
        fixture.actionRepo,
        "--target-branch",
        "main",
        "--expected-head",
        fixture.actionBase,
      ]),
    ).toThrow("non-main local feature branch");
    expect(() =>
      parseExportArgs([
        "--action-repo",
        fixture.actionRepo,
        "--target-branch",
        targetBranch,
        "--expected-head",
        fixture.actionBase.slice(0, 12),
      ]),
    ).toThrow("40-character");
    await expect(
      exportFixture(fixture, { expectedHead: "f".repeat(40) }),
    ).rejects.toThrow("does not match --expected-head");
  });

  it("refuses unmanaged target files instead of overwriting handwritten code", async () => {
    const fixture = createRepositories();
    write(
      join(
        fixture.actionRepo,
        ...PUBLIC_GENERATED_DIRECTORY.split("/"),
        "manual.ts",
      ),
      "export const handwritten = true;\n",
    );
    git(fixture.actionRepo, ["add", PUBLIC_GENERATED_DIRECTORY]);
    git(fixture.actionRepo, ["commit", "-m", "test: add handwritten file"]);
    fixture.actionBase = head(fixture.actionRepo);

    await expect(exportFixture(fixture, { write: true })).rejects.toThrow(
      "without a handoff manifest",
    );
  });

  it("refuses dirty or malformed canonical source output", async () => {
    const dirty = createRepositories();
    write(
      join(dirty.saasRepo, sourceDirectory, "schema.json"),
      '{"dirty":true}\n',
    );
    await expect(exportFixture(dirty)).rejects.toThrow(
      "canonical contract output has uncommitted changes",
    );

    const mismatched = createRepositories();
    const manifestPath = join(
      mismatched.saasRepo,
      sourceDirectory,
      "manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.schemaDigest = "0".repeat(63);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    git(mismatched.saasRepo, ["add", sourceDirectory]);
    git(mismatched.saasRepo, ["commit", "-m", "test: stale descriptor"]);
    mismatched.saasHead = head(mismatched.saasRepo);
    await expect(exportFixture(mismatched)).rejects.toThrow(
      "64-character SHA-256 digest",
    );
  });

  it("refuses a release manifest while the rebuilt bundle is uncommitted", async () => {
    const fixture = createRepositories();
    await exportFixture(fixture, { write: true });
    write(join(fixture.actionRepo, "dist/index.js"), "uncommitted bundle\n");
    expect(() =>
      generateReleaseManifest({
        actionRepo: fixture.actionRepo,
        targetBranch,
        expectedHead: fixture.actionBase,
        runtimeEntrypointPath: "dist/index.js",
        contextGatewayEntrypointPath: "dist/context-gateway.js",
        contextGatewayPolicyVersion: "review-context-gateway.v1",
        output: "",
      }),
    ).toThrow("repository must be clean");
  });
});

type Repositories = {
  root: string;
  saasRepo: string;
  actionRepo: string;
  saasHead: string;
  actionBase: string;
};

function createRepositories(): Repositories {
  const root = mkdtempSync(join(tmpdir(), "review-action-v2-release-"));
  temporaryDirectories.push(root);
  const saasRepo = join(root, "saas");
  const actionRepo = join(root, "action");
  initializeRepository(saasRepo, "main");
  cpSync(
    join(fixtureRoot, "contract-source"),
    join(saasRepo, sourceDirectory),
    {
      recursive: true,
    },
  );
  git(saasRepo, ["add", sourceDirectory]);
  git(saasRepo, ["commit", "-m", "test: add canonical contract"]);

  initializeRepository(actionRepo, targetBranch);
  write(join(actionRepo, "dist/index.js"), "old bundle\n");
  git(actionRepo, ["add", "dist/index.js"]);
  git(actionRepo, ["commit", "-m", "test: add existing bundle"]);
  return {
    root,
    saasRepo,
    actionRepo,
    saasHead: head(saasRepo),
    actionBase: head(actionRepo),
  };
}

function initializeRepository(repository: string, branch: string): void {
  mkdirSync(repository, { recursive: true });
  git(repository, ["init", "-b", branch]);
  git(repository, ["config", "user.name", "ReviewRouter Test"]);
  git(repository, ["config", "user.email", "test@reviewrouter.invalid"]);
  write(join(repository, "README.md"), "fixture\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "test: initialize"]);
}

async function exportFixture(
  fixture: Repositories,
  overrides: { write?: boolean; expectedHead?: string } = {},
) {
  return await exportPublicContract({
    saasRepo: fixture.saasRepo,
    actionRepo: fixture.actionRepo,
    sourceDirectory,
    targetBranch,
    expectedHead: overrides.expectedHead ?? fixture.actionBase,
    expectedSaasHead: fixture.saasHead,
    write: overrides.write ?? false,
  });
}

function write(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function head(repository: string): string {
  return git(repository, ["rev-parse", "HEAD"]);
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
