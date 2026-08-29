import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

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
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (auditedIsCheckedOutAncestor.status !== 0)
    throw new Error(
      "activation_catalog_policy_git_audited_head_not_in_checkout",
    );
  return Object.freeze({ captureBaseCommit, auditedHead, checkoutHead });
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
