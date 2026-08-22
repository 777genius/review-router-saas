import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  parseHostedPoolActionRelease,
  verifyHostedPoolActionCheckout,
} from "./verify-hosted-pool-action-release.mjs";

describe("hosted pool public Action release", () => {
  it("requires the SaaS-consumed SHA to match the recorded tuple", () => {
    const sha = "a".repeat(40);
    expect(
      parseHostedPoolActionRelease({
        REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG: "v1.2.3",
        REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA: sha,
        REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256: "b".repeat(64),
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: `777genius/review-router@${sha}`,
      }),
    ).toMatchObject({ commitSha: sha, tag: "v1.2.3" });
    expect(() =>
      parseHostedPoolActionRelease({
        REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG: "v1.2.3",
        REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA: sha,
        REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256: "b".repeat(64),
        REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: `777genius/review-router@${"c".repeat(40)}`,
      }),
    ).toThrow("hosted_pool_action_ref_mismatch");
  });

  it("resolves the tag and hashes dist/index.js from the same clean checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "rr-hosted-action-release-"));
    await mkdir(join(root, "dist"));
    const bytes = "console.log('immutable hosted action');\n";
    await writeFile(join(root, "dist/index.js"), bytes);
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "test@reviewrouter.invalid"]);
    git(root, ["config", "user.name", "ReviewRouter Test"]);
    git(root, ["add", "dist/index.js"]);
    git(root, ["commit", "-qm", "fixture"]);
    const sha = git(root, ["rev-parse", "HEAD"]);
    git(root, ["tag", "v1.2.3"]);
    const release = parseHostedPoolActionRelease({
      REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG: "v1.2.3",
      REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA: sha,
      REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256: createHash("sha256")
        .update(bytes)
        .digest("hex"),
      REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: `777genius/review-router@${sha}`,
    });
    await expect(
      verifyHostedPoolActionCheckout({ checkout: root, release }),
    ).resolves.toMatchObject({ verified: true, commitSha: sha });
    await writeFile(join(root, "dist/index.js"), `${bytes}// changed\n`);
    await expect(
      verifyHostedPoolActionCheckout({ checkout: root, release }),
    ).rejects.toThrow("hosted_pool_action_checkout_dirty");
  });
});

function git(cwd: string, args: string[]) {
  return execFileSync("/usr/bin/git", ["-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}
