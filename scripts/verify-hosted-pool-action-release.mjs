#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repository = "777genius/review-router";

export function parseHostedPoolActionRelease(env = process.env) {
  const tag = required(env.REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG);
  const commitSha = required(
    env.REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA,
  ).toLowerCase();
  const distSha256 = required(
    env.REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256,
  ).toLowerCase();
  const actionRef = required(env.REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF);
  if (!/^v[1-9][0-9]*\.[0-9]+\.[0-9]+$/u.test(tag))
    throw new Error("hosted_pool_action_tag_invalid");
  if (!/^[a-f0-9]{40}$/u.test(commitSha))
    throw new Error("hosted_pool_action_commit_invalid");
  if (!/^[a-f0-9]{64}$/u.test(distSha256))
    throw new Error("hosted_pool_action_digest_invalid");
  if (actionRef !== `${repository}@${commitSha}`)
    throw new Error("hosted_pool_action_ref_mismatch");
  return Object.freeze({ repository, tag, commitSha, distSha256, actionRef });
}

export async function verifyHostedPoolActionCheckout({
  checkout,
  release,
  git = gitAt,
}) {
  const root = resolve(checkout);
  const head = git(root, ["rev-parse", "HEAD"]).toLowerCase();
  const tagCommit = git(root, [
    "rev-list",
    "-n",
    "1",
    release.tag,
  ]).toLowerCase();
  const tagObject = git(root, [
    "rev-parse",
    `${release.tag}^{commit}`,
  ]).toLowerCase();
  if (
    head !== release.commitSha ||
    tagCommit !== release.commitSha ||
    tagObject !== release.commitSha
  )
    throw new Error("hosted_pool_action_tag_commit_mismatch");
  if (git(root, ["status", "--porcelain"]) !== "")
    throw new Error("hosted_pool_action_checkout_dirty");
  const bytes = await readFile(resolve(root, "dist/index.js"));
  const observedDigest = createHash("sha256").update(bytes).digest("hex");
  if (observedDigest !== release.distSha256)
    throw new Error("hosted_pool_action_dist_digest_mismatch");
  return Object.freeze({ ...release, checkout: root, verified: true });
}

function gitAt(cwd, args) {
  return execFileSync("/usr/bin/git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function required(value) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error("hosted_pool_action_release_value_missing");
  return result;
}

async function main() {
  const checkout =
    process.env.REVIEW_ROUTER_HOSTED_POOL_ACTION_CHECKOUT?.trim();
  if (!checkout) throw new Error("hosted_pool_action_checkout_required");
  const result = await verifyHostedPoolActionCheckout({
    checkout,
    release: parseHostedPoolActionRelease(),
  });
  console.log(JSON.stringify(result));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
