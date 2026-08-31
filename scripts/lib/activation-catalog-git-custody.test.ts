import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertActivationCatalogCaptureSurfaceIdentity,
  assertActivationCatalogGitCustody,
} from "./activation-catalog-git-custody.mjs";

const repositories: string[] = [];

function repository() {
  const root = mkdtempSync(join(tmpdir(), "rr-catalog-custody-"));
  repositories.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "ReviewRouter Test");
  git("config", "user.email", "reviewrouter@example.invalid");
  writeFileSync(join(root, "catalog.txt"), "base\n");
  git("add", "catalog.txt");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "catalog.txt"), "audited\n");
  git("commit", "-qam", "audited");
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
      }),
    ).not.toThrow();
    writeFileSync(join(fixture.root, "catalog.txt"), "drift\n");
    expect(() =>
      assertActivationCatalogCaptureSurfaceIdentity({
        repositoryRoot: fixture.root,
        auditedHead: fixture.auditedHead,
        captureSurface: ["catalog.txt"],
      }),
    ).toThrow("activation_catalog_policy_git_capture_surface_drift");
  });
});
