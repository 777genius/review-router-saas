import { posix as posixPath } from "node:path";
import {
  HANDOFF_MANIFEST_FILE,
  parseHandoffManifest,
  PUBLIC_CONTEXT_GATEWAY_BUNDLE,
  PUBLIC_GENERATED_DIRECTORY,
  PUBLIC_RUNTIME_BUNDLE,
  sha256Digest,
} from "./review-action-v2-release-manifests.mjs";
import {
  assertAncestor,
  listCommitDirectory,
  readCommitFile,
} from "./git-release-artifacts.mjs";

export function verifyPublicActionReleaseCommit(input) {
  const targetDirectory = input.targetDirectory ?? PUBLIC_GENERATED_DIRECTORY;
  const runtimeEntrypointPath =
    input.runtimeEntrypointPath ?? PUBLIC_RUNTIME_BUNDLE;
  const contextGatewayEntrypointPath =
    input.contextGatewayEntrypointPath ?? PUBLIC_CONTEXT_GATEWAY_BUNDLE;
  const entries = listCommitDirectory(
    input.actionRepo,
    input.actionCommitSha,
    targetDirectory,
  );
  for (const entry of entries) {
    if (entry.type !== "blob" || entry.mode !== "100644") {
      throw new Error(
        `committed generated contract entry must be a regular file: ${entry.path}`,
      );
    }
  }
  const handoffEntry = entries.find(
    (entry) => entry.path === HANDOFF_MANIFEST_FILE,
  );
  if (!handoffEntry) {
    throw new Error(
      `public Action commit is missing ${targetDirectory}/${HANDOFF_MANIFEST_FILE}`,
    );
  }
  const handoffBytes = readCommitFile(
    input.actionRepo,
    input.actionCommitSha,
    posixPath.join(targetDirectory, HANDOFF_MANIFEST_FILE),
  );
  const handoff = parseHandoffManifest(handoffBytes.toString("utf8"));
  const expectedFiles = [
    ...Object.keys(handoff.generatedFileDigests),
    HANDOFF_MANIFEST_FILE,
  ].sort();
  const actualFiles = entries.map((entry) => entry.path).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      "committed generated target contains missing or unmanaged files",
    );
  }
  for (const file of Object.keys(handoff.generatedFileDigests)) {
    const bytes = readCommitFile(
      input.actionRepo,
      input.actionCommitSha,
      posixPath.join(targetDirectory, file),
    );
    if (sha256Digest(bytes) !== handoff.generatedFileDigests[file]) {
      throw new Error(`committed generated file digest mismatch: ${file}`);
    }
  }
  assertAncestor(
    input.actionRepo,
    handoff.expectedPublicActionBaseCommit,
    input.actionCommitSha,
  );
  if (handoff.expectedPublicActionBaseCommit === input.actionCommitSha) {
    throw new Error(
      "public Action release commit must follow the expected base commit",
    );
  }
  const runtimeBytes = readCommitFile(
    input.actionRepo,
    input.actionCommitSha,
    runtimeEntrypointPath,
  );
  const contextGatewayBytes = readCommitFile(
    input.actionRepo,
    input.actionCommitSha,
    contextGatewayEntrypointPath,
  );
  return Object.freeze({
    handoff,
    handoffBytes,
    handoffDigest: sha256Digest(handoffBytes),
    runtimeEntrypointPath,
    runtimeEntrypointDigest: sha256Digest(runtimeBytes),
    contextGatewayEntrypointPath,
    contextGatewayEntrypointDigest: sha256Digest(contextGatewayBytes),
  });
}
