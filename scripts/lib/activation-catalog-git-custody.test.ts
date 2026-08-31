import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activationCatalogCaptureSurface,
  assertActivationCatalogCaptureSurfaceIdentity,
  assertActivationCatalogGitCustody,
} from "./activation-catalog-git-custody.mjs";

const repositories: string[] = [];

const trustRootRepositoryPath =
  "packages/features/release-rollout/src/domain/activation-catalog-policy-raw-promotion-trust-root.json";
const expectationRepositoryPath =
  "packages/features/release-rollout/src/domain/activation-catalog-policy-promotion-expectation.ts";

const captureSurfaceDirectories = new Set([
  "packages/platform/db/prisma",
  "packages/platform/db/src",
  "packages/features/release-rollout/src",
  "apps/api/src/release-authority",
]);

function populateDefaultCaptureSurface(root: string) {
  for (const selector of activationCatalogCaptureSurface) {
    if (selector.startsWith(":(exclude)")) continue;
    const repositoryPath = captureSurfaceDirectories.has(selector)
      ? join(selector, "fixture.txt")
      : selector;
    const absolutePath = join(root, repositoryPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `${repositoryPath}\n`);
  }
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "rr-catalog-custody-"));
  repositories.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "ReviewRouter Test");
  git("config", "user.email", "reviewrouter@example.invalid");
  git("config", "core.filemode", "true");
  writeFileSync(join(root, "catalog.txt"), "base\n");
  git("add", "catalog.txt");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  mkdirSync(join(root, "packages/features/release-rollout/src/domain"), {
    recursive: true,
  });
  populateDefaultCaptureSurface(root);
  writeFileSync(join(root, trustRootRepositoryPath), '{"status":"pending"}\n');
  writeFileSync(
    join(root, expectationRepositoryPath),
    "export const validator = true;\n",
  );
  writeFileSync(join(root, "catalog.txt"), "audited\n");
  git("add", ".");
  git("commit", "-qm", "audited");
  const auditedHead = git("rev-parse", "HEAD");
  return { root, base, auditedHead, git };
}

afterEach(() => {
  for (const root of repositories.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("activation catalog Git custody", () => {
  it("binds a distinct real base-to-audited-head range at the exact checkout", () => {
    const fixture = repository();
    expect(
      assertActivationCatalogGitCustody({
        repositoryRoot: fixture.root,
        captureBaseCommit: fixture.base,
        auditedHead: fixture.auditedHead,
        requireExactCheckoutHead: true,
      }),
    ).toEqual({
      captureBaseCommit: fixture.base,
      auditedHead: fixture.auditedHead,
      checkoutHead: fixture.auditedHead,
    });
  });

  it("rejects equal commits, reversed ancestry, and caller-only hex", () => {
    const fixture = repository();
    expect(() =>
      assertActivationCatalogGitCustody({
        repositoryRoot: fixture.root,
        captureBaseCommit: fixture.auditedHead,
        auditedHead: fixture.auditedHead,
      }),
    ).toThrow("activation_catalog_policy_git_review_range_invalid");
    expect(() =>
      assertActivationCatalogGitCustody({
        repositoryRoot: fixture.root,
        captureBaseCommit: fixture.auditedHead,
        auditedHead: fixture.base,
      }),
    ).toThrow("activation_catalog_policy_git_review_ancestry_invalid");
    expect(() =>
      assertActivationCatalogGitCustody({
        repositoryRoot: fixture.root,
        captureBaseCommit: "a".repeat(40),
        auditedHead: "b".repeat(40),
      }),
    ).toThrow("activation_catalog_policy_git_capture_base_missing");
  });

  it("allows promotion from a descendant checkout but rejects unrelated custody", () => {
    const fixture = repository();
    writeFileSync(join(fixture.root, "catalog.txt"), "promotion\n");
    fixture.git("commit", "-qam", "promotion");
    expect(() =>
      assertActivationCatalogGitCustody({
        repositoryRoot: fixture.root,
        captureBaseCommit: fixture.base,
        auditedHead: fixture.auditedHead,
      }),
    ).not.toThrow();
    fixture.git("checkout", "-q", "--orphan", "unrelated");
    fixture.git("rm", "-q", "-f", "catalog.txt");
    writeFileSync(join(fixture.root, "other.txt"), "unrelated\n");
    fixture.git("add", "other.txt");
    fixture.git("commit", "-qm", "unrelated");
    expect(() =>
      assertActivationCatalogGitCustody({
        repositoryRoot: fixture.root,
        captureBaseCommit: fixture.base,
        auditedHead: fixture.auditedHead,
      }),
    ).toThrow("activation_catalog_policy_git_audited_head_not_in_checkout");
  });

  it("allows evidence descendants and rejects capture drift", () => {
    const fixture = repository();
    writeFileSync(join(fixture.root, "evidence.md"), "evidence\n");
    fixture.git("add", "evidence.md");
    fixture.git("commit", "-qm", "evidence");
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: fixture.root,
        auditedHead: fixture.auditedHead,
        captureSurface: ["catalog.txt"],
        checkoutTrustSurface: [trustRootRepositoryPath],
      }),
    ).not.toThrow();
    writeFileSync(join(fixture.root, "catalog.txt"), "drift\n");
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: fixture.root,
        auditedHead: fixture.auditedHead,
        captureSurface: ["catalog.txt"],
        checkoutTrustSurface: [trustRootRepositoryPath],
      }),
    ).toThrow("activation_catalog_policy_git_capture_surface_drift");
  });

  it("enforces the default production surface across real descendants", () => {
    const fixture = repository();
    writeFileSync(join(fixture.root, "evidence.md"), "reviewed evidence\n");
    fixture.git("add", "evidence.md");
    fixture.git("commit", "-qm", "evidence descendant");
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: fixture.root,
        auditedHead: fixture.auditedHead,
      }),
    ).not.toThrow();

    writeFileSync(
      join(fixture.root, expectationRepositoryPath),
      "export const validator = false;\n",
    );
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: fixture.root,
        auditedHead: fixture.auditedHead,
      }),
    ).toThrow("activation_catalog_policy_git_capture_surface_drift");
    fixture.git("add", expectationRepositoryPath);
    fixture.git("commit", "-qm", "committed executable drift");
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: fixture.root,
        auditedHead: fixture.auditedHead,
      }),
    ).toThrow("activation_catalog_policy_git_capture_surface_drift");

    const rootData = repository();
    writeFileSync(
      join(rootData.root, trustRootRepositoryPath),
      '{"status":"pending","reason":"review-required"}\n',
    );
    rootData.git("add", trustRootRepositoryPath);
    rootData.git("commit", "-qm", "reviewed root data descendant");
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: rootData.root,
        auditedHead: rootData.auditedHead,
      }),
    ).not.toThrow();
  });

  it("rejects executable expectation drift but allows unrelated descendants", () => {
    const fixture = repository();
    writeFileSync(join(fixture.root, "evidence.md"), "reviewed evidence\n");
    fixture.git("add", "evidence.md");
    fixture.git("commit", "-qm", "unrelated descendant");
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: fixture.root,
        auditedHead: fixture.auditedHead,
        captureSurface: [
          "packages/features/release-rollout/src",
          `:(exclude)${trustRootRepositoryPath}`,
        ],
        checkoutTrustSurface: [trustRootRepositoryPath],
      }),
    ).not.toThrow();

    writeFileSync(
      join(fixture.root, expectationRepositoryPath),
      "export const validator = false;\n",
    );
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: fixture.root,
        auditedHead: fixture.auditedHead,
        captureSurface: [
          "packages/features/release-rollout/src",
          `:(exclude)${trustRootRepositoryPath}`,
        ],
        checkoutTrustSurface: [trustRootRepositoryPath],
      }),
    ).toThrow("activation_catalog_policy_git_capture_surface_drift");
  });

  it("allows a clean reviewed trust-data descendant", () => {
    const fixture = repository();
    writeFileSync(
      join(fixture.root, trustRootRepositoryPath),
      '{"status":"pending","reason":"review-required"}\n',
    );
    fixture.git("add", trustRootRepositoryPath);
    fixture.git("commit", "-qm", "reviewed trust data");
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: fixture.root,
        auditedHead: fixture.auditedHead,
        captureSurface: ["catalog.txt"],
        checkoutTrustSurface: [trustRootRepositoryPath],
      }),
    ).not.toThrow();
  });

  it("rejects dirty and untracked trust data", () => {
    const dirty = repository();
    writeFileSync(
      join(dirty.root, trustRootRepositoryPath),
      '{"status":"ready"}\n',
    );
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: dirty.root,
        auditedHead: dirty.auditedHead,
        captureSurface: ["catalog.txt"],
        checkoutTrustSurface: [trustRootRepositoryPath],
      }),
    ).toThrow("activation_catalog_policy_git_checkout_trust_surface_dirty");

    const untracked = repository();
    untracked.git("rm", "--cached", "-q", trustRootRepositoryPath);
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: untracked.root,
        auditedHead: untracked.auditedHead,
        captureSurface: ["catalog.txt"],
        checkoutTrustSurface: [trustRootRepositoryPath],
      }),
    ).toThrow("activation_catalog_policy_git_checkout_trust_surface_dirty");
  });

  it("rejects executable-mode and symlink trust-data substitutions", () => {
    const executable = repository();
    chmodSync(join(executable.root, trustRootRepositoryPath), 0o755);
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: executable.root,
        auditedHead: executable.auditedHead,
        captureSurface: ["catalog.txt"],
        checkoutTrustSurface: [trustRootRepositoryPath],
      }),
    ).toThrow("activation_catalog_policy_git_checkout_trust_surface_dirty");

    const symlink = repository();
    const trustPath = join(symlink.root, trustRootRepositoryPath);
    unlinkSync(trustPath);
    symlinkSync("../../../../../catalog.txt", trustPath);
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: symlink.root,
        auditedHead: symlink.auditedHead,
        captureSurface: ["catalog.txt"],
        checkoutTrustSurface: [trustRootRepositoryPath],
      }),
    ).toThrow("activation_catalog_policy_git_checkout_trust_surface_dirty");
  });

  it("rejects a committed non-regular trust-data blob", () => {
    const fixture = repository();
    chmodSync(join(fixture.root, trustRootRepositoryPath), 0o755);
    fixture.git("add", trustRootRepositoryPath);
    fixture.git("commit", "-qm", "executable trust data");
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: fixture.root,
        auditedHead: fixture.auditedHead,
        captureSurface: ["catalog.txt"],
        checkoutTrustSurface: [trustRootRepositoryPath],
      }),
    ).toThrow("activation_catalog_policy_git_checkout_trust_surface_invalid");
  });
});
