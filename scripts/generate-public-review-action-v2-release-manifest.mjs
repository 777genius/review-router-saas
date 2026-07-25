#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFullCommitSha,
  assertSafeRelativePath,
  buildReleaseManifest,
  canonicalJson,
  PUBLIC_CONTEXT_GATEWAY_BUNDLE,
  PUBLIC_RUNTIME_BUNDLE,
} from "./lib/review-action-v2-release-manifests.mjs";
import {
  assertGitRepository,
  assertRepositoryClean,
  currentBranch,
  currentCommit,
} from "./lib/git-release-artifacts.mjs";
import { verifyPublicActionReleaseCommit } from "./lib/review-action-v2-release-verifier.mjs";

export function parseArgs(argv, cwd = process.cwd()) {
  const values = {
    actionRepo: path.resolve(cwd),
    targetBranch: "",
    expectedHead: "",
    runtimeEntrypointPath: PUBLIC_RUNTIME_BUNDLE,
    contextGatewayEntrypointPath: PUBLIC_CONTEXT_GATEWAY_BUNDLE,
    contextGatewayPolicyVersion: "",
    output: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${option}`);
      }
      index += 1;
      return value;
    };
    if (option === "--action-repo") values.actionRepo = path.resolve(next());
    else if (option === "--target-branch") values.targetBranch = next();
    else if (option === "--expected-head") values.expectedHead = next();
    else if (option === "--runtime-entrypoint")
      values.runtimeEntrypointPath = next();
    else if (option === "--context-gateway-entrypoint")
      values.contextGatewayEntrypointPath = next();
    else if (option === "--context-gateway-policy-version")
      values.contextGatewayPolicyVersion = next();
    else if (option === "--output") values.output = path.resolve(next());
    else if (option === "--help" || option === "-h") {
      return { help: true };
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!values.targetBranch || values.targetBranch.startsWith("refs/")) {
    throw new Error("--target-branch must be an explicit local branch");
  }
  values.expectedHead = assertFullCommitSha(
    values.expectedHead,
    "--expected-head",
  );
  values.runtimeEntrypointPath = assertSafeRelativePath(
    values.runtimeEntrypointPath,
    "--runtime-entrypoint",
  );
  values.contextGatewayEntrypointPath = assertSafeRelativePath(
    values.contextGatewayEntrypointPath,
    "--context-gateway-entrypoint",
  );
  if (!values.contextGatewayPolicyVersion) {
    throw new Error("missing required --context-gateway-policy-version");
  }
  return Object.freeze(values);
}

export function generateReleaseManifest(input) {
  assertGitRepository(input.actionRepo, "public Action");
  const branch = currentBranch(input.actionRepo);
  if (branch !== input.targetBranch) {
    throw new Error(
      `public Action worktree is on ${branch}, expected ${input.targetBranch}`,
    );
  }
  const actionCommitSha = currentCommit(input.actionRepo);
  if (actionCommitSha !== input.expectedHead) {
    throw new Error(
      `public Action HEAD ${actionCommitSha} does not match --expected-head ${input.expectedHead}`,
    );
  }
  assertRepositoryClean(input.actionRepo, "public Action release");
  if (
    input.output &&
    isWithinRepository(input.actionRepo, path.resolve(input.output))
  ) {
    throw new Error(
      "--output must be outside the public Action repository to avoid a self-referential commit",
    );
  }
  const verified = verifyPublicActionReleaseCommit({
    actionRepo: input.actionRepo,
    actionCommitSha,
    runtimeEntrypointPath: input.runtimeEntrypointPath,
    contextGatewayEntrypointPath: input.contextGatewayEntrypointPath,
  });
  const manifest = buildReleaseManifest({
    handoffManifest: verified.handoff,
    handoffManifestDigest: verified.handoffDigest,
    actionCommitSha,
    runtimeEntrypointPath: verified.runtimeEntrypointPath,
    runtimeEntrypointDigest: verified.runtimeEntrypointDigest,
    contextGatewayPolicyVersion: input.contextGatewayPolicyVersion,
    contextGatewayEntrypointPath: verified.contextGatewayEntrypointPath,
    contextGatewayEntrypointDigest: verified.contextGatewayEntrypointDigest,
  });
  const bytes = canonicalJson(manifest);
  if (input.output) writeImmutable(input.output, bytes);
  return Object.freeze({ manifest, bytes });
}

function writeImmutable(output, bytes) {
  if (existsSync(output)) {
    if (readFileSync(output, "utf8") === bytes) return;
    throw new Error(
      `refusing to overwrite a different release manifest: ${output}`,
    );
  }
  writeFileSync(output, bytes, { encoding: "utf8", flag: "wx", mode: 0o644 });
}

function isWithinRepository(repository, candidate) {
  const relative = path.relative(path.resolve(repository), candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function usage() {
  return `Usage:
  pnpm protocol:release-manifest --action-repo <path> --target-branch <branch> --expected-head <40-char-sha> [options]

Options:
  --runtime-entrypoint <path>  Committed runtime bundle. Default: ${PUBLIC_RUNTIME_BUNDLE}
  --context-gateway-entrypoint <path>
                               Committed context gateway bundle. Default: ${PUBLIC_CONTEXT_GATEWAY_BUNDLE}
  --context-gateway-policy-version <id>
                               Required policy identity embedded by the gateway bundle.
  --output <path>              Write-once manifest path outside the Action repository.
  --help                       Show this help.

Without --output the canonical release manifest is printed to stdout.`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = generateReleaseManifest(args);
  console.log(result.bytes.trimEnd());
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
