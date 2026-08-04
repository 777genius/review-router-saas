#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReleaseRegistrationCandidateFields,
  buildHandoffManifest,
  buildReleaseManifest,
  canonicalJson,
  parseReleaseManifest,
} from "./lib/review-action-v2-release-manifests.mjs";
import {
  assertCommitExists,
  assertGitRepository,
} from "./lib/git-release-artifacts.mjs";
import { verifyPublicActionReleaseCommit } from "./lib/review-action-v2-release-verifier.mjs";
import {
  DEFAULT_SOURCE_DIRECTORY,
  loadContractSource,
} from "./export-public-review-action-v2-contract.mjs";

export function parseArgs(argv, cwd = process.cwd()) {
  const values = {
    manifest: "",
    saasRepo: path.resolve(cwd),
    actionRepo: "",
    sourceDirectory: DEFAULT_SOURCE_DIRECTORY,
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
    if (option === "--manifest") values.manifest = path.resolve(next());
    else if (option === "--saas-repo") values.saasRepo = path.resolve(next());
    else if (option === "--action-repo")
      values.actionRepo = path.resolve(next());
    else if (option === "--source-directory") values.sourceDirectory = next();
    else if (option === "--help" || option === "-h") {
      return { help: true };
    } else throw new Error(`unknown option: ${option}`);
  }
  if (!values.manifest) throw new Error("missing required --manifest");
  if (!values.actionRepo) throw new Error("missing required --action-repo");
  return Object.freeze(values);
}

export function checkReleaseManifest(input) {
  assertGitRepository(input.saasRepo, "SaaS");
  assertGitRepository(input.actionRepo, "public Action");
  const manifestBytes = readFileSync(input.manifest, "utf8");
  const manifest = parseReleaseManifest(manifestBytes);
  assertCommitExists(
    input.saasRepo,
    manifest.saasSourceCommit,
    "release manifest SaaS source commit",
  );
  assertCommitExists(
    input.actionRepo,
    manifest.actionCommitSha,
    "release manifest public Action commit",
  );

  const source = loadContractSource(
    input.saasRepo,
    manifest.saasSourceCommit,
    input.sourceDirectory,
  );
  const expectedHandoff = buildHandoffManifest({
    contract: source.descriptor,
    saasSourceCommit: manifest.saasSourceCommit,
    expectedPublicActionBaseCommit: manifest.expectedPublicActionBaseCommit,
  });
  const verifiedAction = verifyPublicActionReleaseCommit({
    actionRepo: input.actionRepo,
    actionCommitSha: manifest.actionCommitSha,
    runtimeEntrypointPath: manifest.runtimeEntrypointPath,
    contextGatewayEntrypointPath: manifest.contextGatewayEntrypointPath,
  });
  if (
    canonicalJson(verifiedAction.handoff) !== canonicalJson(expectedHandoff)
  ) {
    throw new Error(
      "committed handoff does not match the canonical SaaS source commit",
    );
  }
  const expectedRelease = buildReleaseManifest({
    handoffManifest: expectedHandoff,
    handoffManifestDigest: verifiedAction.handoffDigest,
    actionCommitSha: manifest.actionCommitSha,
    runtimeEntrypointPath: verifiedAction.runtimeEntrypointPath,
    runtimeEntrypointDigest: verifiedAction.runtimeEntrypointDigest,
    contextGatewayReleaseMetadata: verifiedAction.contextGatewayReleaseMetadata,
  });
  if (canonicalJson(expectedRelease) !== manifestBytes) {
    throw new Error(
      "release manifest does not match committed source, handoff, or runtime bundle",
    );
  }
  return Object.freeze({
    saasSourceCommit: manifest.saasSourceCommit,
    ...buildReleaseRegistrationCandidateFields(manifest),
    supportedContextGatewayPolicyVersions:
      manifest.supportedContextGatewayPolicyVersions ?? [
        manifest.contextGatewayPolicyVersion,
      ],
  });
}

function usage() {
  return `Usage:
  pnpm protocol:release-manifest:check --manifest <path> --action-repo <path> [options]

Options:
  --saas-repo <path>           SaaS repository. Default: current directory.
  --source-directory <path>    Canonical generated source within SaaS.
  --help                       Show this help.`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  console.log(canonicalJson(checkReleaseManifest(args)).trimEnd());
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
