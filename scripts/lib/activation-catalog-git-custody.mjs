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
  ":(exclude)packages/features/release-rollout/src/domain/activation-catalog-policy-raw-promotion-trust-root.json",
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

export const activationCatalogCheckoutTrustSurface = Object.freeze([
  "packages/features/release-rollout/src/domain/activation-catalog-policy-raw-promotion-trust-root.json",
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
  checkoutTrustSurface = activationCatalogCheckoutTrustSurface,
}) {
  const captureSelectors = parseCaptureSurface(captureSurface);
  if (
    !commitSha.test(auditedHead ?? "") ||
    captureSelectors === undefined ||
    !Array.isArray(checkoutTrustSurface) ||
    checkoutTrustSurface.length === 0 ||
    checkoutTrustSurface.some((path) => !isLiteralRepositoryPath(path)) ||
    new Set(checkoutTrustSurface).size !== checkoutTrustSurface.length
  )
    throw new Error("activation_catalog_policy_git_capture_surface_invalid");
  const root = git(repositoryRoot, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(root) !== realpathSync(repositoryRoot))
    throw new Error("activation_catalog_policy_git_checkout_invalid");
  const checkoutHead = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const checkoutTrustInventory = boundedGit(repositoryRoot, [
    "ls-tree",
    "-r",
    checkoutHead,
    "--",
    ...checkoutTrustSurface,
  ]);
  const checkoutTrustEntries =
    checkoutTrustInventory.status === 0
      ? checkoutTrustInventory.stdout
          .trimEnd()
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => {
            const match = /^100644 blob [a-f0-9]+\t(.+)$/u.exec(line);
            return match?.[1];
          })
      : [];
  if (
    checkoutTrustEntries.length !== checkoutTrustSurface.length ||
    checkoutTrustEntries.some((path) => path === undefined) ||
    checkoutTrustSurface.some((path) => !checkoutTrustEntries.includes(path))
  )
    throw new Error(
      "activation_catalog_policy_git_checkout_trust_surface_invalid",
    );
  const checkoutTrustDirty = boundedGit(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...checkoutTrustSurface,
  ]);
  if (checkoutTrustDirty.status !== 0 || checkoutTrustDirty.stdout.length !== 0)
    throw new Error(
      "activation_catalog_policy_git_checkout_trust_surface_dirty",
    );

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
    ...captureSelectors.inclusions,
  ]);
  const auditedEntries =
    auditedInventory.status === 0
      ? auditedInventory.stdout
          .trimEnd()
          .split("\n")
          .filter(
            (path) =>
              path.length > 0 &&
              !captureSelectors.exclusions.some((excluded) =>
                isPathWithin(path, excluded),
              ),
          )
      : [];
  if (auditedEntries.length === 0)
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

function parseCaptureSurface(captureSurface) {
  if (!Array.isArray(captureSurface) || captureSurface.length === 0)
    return undefined;
  const inclusions = [];
  const exclusions = [];
  for (const selector of captureSurface) {
    if (typeof selector !== "string") return undefined;
    if (selector.startsWith(":(exclude)")) {
      const path = selector.slice(":(exclude)".length);
      if (!isLiteralRepositoryPath(path)) return undefined;
      exclusions.push(path);
    } else {
      if (!isLiteralRepositoryPath(selector)) return undefined;
      inclusions.push(selector);
    }
  }
  if (
    inclusions.length === 0 ||
    new Set(captureSurface).size !== captureSurface.length ||
    exclusions.some(
      (excluded) =>
        !inclusions.some((included) => isPathWithin(excluded, included)),
    )
  )
    return undefined;
  return { inclusions, exclusions };
}

function isLiteralRepositoryPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    path
      .split("/")
      .every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          /^[A-Za-z0-9._-]+$/u.test(segment),
      )
  );
}

function isPathWithin(path, boundary) {
  return path === boundary || path.startsWith(`${boundary}/`);
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
