import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

export const activationCatalogCaptureSurface = Object.freeze([
  ".github/workflows/ci.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "packages/platform/db/prisma.config.ts",
  "packages/platform/db/prisma",
  "packages/platform/db/src",
  "packages/features/release-rollout/src",
  ":(exclude)packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js",
  ":(exclude)packages/features/release-rollout/src/domain/activation-catalog-policy-provenance.json",
  ":(exclude)packages/features/release-rollout/src/domain/activation-catalog-policy-promotion-expectation.ts",
  "apps/api/src/release-authority",
  "apps/api/src/release-control-composition.ts",
  "apps/api/src/release-witness-adapters.ts",
  "scripts/rehearse-private-pg17-rollout.mjs",
  "scripts/install-release-authority-db.mjs",
  "scripts/reconcile-codex-rotating-legacy-ambiguity.mjs",
  "scripts/capture-private-pg17-activation-catalog-policy.mjs",
  "scripts/run-codex-rotating-release-migration.mjs",
  "scripts/activate-private-pg17-generation.mjs",
  "scripts/private-pg17-secure-canonical.ts",
  "scripts/promote-private-pg17-activation-catalog-policy.mjs",
  "scripts/lib/activation-catalog-capture-pair.mjs",
  "scripts/lib/activation-catalog-git-custody.mjs",
  "scripts/lib/release-authority-postgres-url.mjs",
  "scripts/lib/reviewed-activation-catalog-candidate.mjs",
  "scripts/lib/secret-safe-command-boundary.mjs",
]);

const commitSha = /^[a-f0-9]{40}$/u;

export function assertActivationCatalogGitCustody({
  repositoryRoot,
  captureBaseCommit,
  auditedHead,
  requireExactCheckoutHead = false,
}) {
  if (
    !commitSha.test(captureBaseCommit ?? "") ||
    !commitSha.test(auditedHead ?? "") ||
    captureBaseCommit === auditedHead
  ) {
    throw new Error("activation_catalog_policy_git_review_range_invalid");
  }
  const root = git(repositoryRoot, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(root) !== realpathSync(repositoryRoot))
    throw new Error("activation_catalog_policy_git_checkout_invalid");
  for (const [value, label] of [
    [captureBaseCommit, "capture base"],
    [auditedHead, "audited head"],
  ]) {
    const exists = spawnSync("git", ["cat-file", "-e", `${value}^{commit}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (exists.status !== 0)
      throw new Error(
        `activation_catalog_policy_git_${label.replaceAll(" ", "_")}_missing`,
      );
  }
  const mergeBase = git(repositoryRoot, [
    "merge-base",
    captureBaseCommit,
    auditedHead,
  ]);
  if (mergeBase !== captureBaseCommit)
    throw new Error("activation_catalog_policy_git_review_ancestry_invalid");
  const checkoutHead = git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (requireExactCheckoutHead && checkoutHead !== auditedHead)
    throw new Error(
      "activation_catalog_policy_git_audited_head_not_checked_out",
    );
  const auditedIsCheckedOutAncestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", auditedHead, checkoutHead],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (auditedIsCheckedOutAncestor.status !== 0)
    throw new Error(
      "activation_catalog_policy_git_audited_head_not_in_checkout",
    );
  return Object.freeze({ captureBaseCommit, auditedHead, checkoutHead });
}

export function assertActivationCatalogCaptureSurfaceIdentity({
  repositoryRoot,
  auditedHead,
  auditedTree,
  captureSurface = activationCatalogCaptureSurface,
}) {
  if (
    !commitSha.test(auditedHead ?? "") ||
    !Array.isArray(captureSurface) ||
    captureSurface.length === 0 ||
    captureSurface.some(
      (path) =>
        typeof path !== "string" || path.startsWith("/") || path.includes(".."),
    )
  )
    throw new Error("activation_catalog_policy_git_capture_surface_invalid");
  const root = git(repositoryRoot, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(root) !== realpathSync(repositoryRoot))
    throw new Error("activation_catalog_policy_git_checkout_invalid");
  const checkoutHead = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const resolvedAuditedTree = git(repositoryRoot, [
    "rev-parse",
    auditedHead + "^{tree}",
  ]);
  if (auditedTree !== undefined && resolvedAuditedTree !== auditedTree)
    throw new Error("activation_catalog_policy_git_audited_tree_invalid");
  const ancestor = boundedGit(repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    auditedHead,
    checkoutHead,
  ]);
  if (ancestor.status !== 0)
    throw new Error(
      "activation_catalog_policy_git_audited_head_not_in_checkout",
    );
  const auditedInventory = boundedGit(repositoryRoot, [
    "ls-tree",
    "-r",
    "--name-only",
    auditedHead,
    "--",
    ...captureSurface,
  ]);
  if (auditedInventory.status !== 0 || auditedInventory.stdout.length === 0)
    throw new Error("activation_catalog_policy_git_capture_surface_invalid");
  const drift = boundedGit(repositoryRoot, [
    "diff",
    "--quiet",
    auditedHead,
    "--",
    ...captureSurface,
  ]);
  if (drift.status !== 0)
    throw new Error("activation_catalog_policy_git_capture_surface_drift");
  const dirty = boundedGit(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...captureSurface,
  ]);
  if (dirty.status !== 0 || dirty.stdout.length !== 0)
    throw new Error("activation_catalog_policy_git_capture_surface_dirty");
  return Object.freeze({
    auditedHead,
    auditedTree: resolvedAuditedTree,
    checkoutHead,
    captureSurface: Object.freeze([...captureSurface]),
  });
}

function boundedGit(repositoryRoot, args) {
  return spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

function git(repositoryRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("activation_catalog_policy_git_checkout_invalid");
  }
}
