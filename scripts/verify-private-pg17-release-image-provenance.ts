#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  assertReleaseImageIdentity,
  assertVerifiedReleaseImageProvenance,
  sha256Canonical,
  type ReleaseImageIdentity,
  type VerifiedReleaseImageProvenance,
} from "../packages/features/release-rollout/src/index";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_release_image_missing:${name}`);
  return value;
};
const positiveId = (name: string): string => {
  const value = required(name);
  if (!/^[1-9][0-9]*$/u.test(value))
    throw new Error(`private_pg17_release_image_invalid:${name}`);
  return value;
};
const repository = required("GITHUB_REPOSITORY");
const expectedCommit = required("REVIEW_ROUTER_EXPECTED_SHA");
const releaseRunId = positiveId("REVIEW_ROUTER_RELEASE_RUN_ID");
const artifactId = positiveId("REVIEW_ROUTER_RELEASE_ARTIFACT_ID");
const identityPath = required("REVIEW_ROUTER_RELEASE_IMAGE_IDENTITY_FILE");
const outputPath = required("REVIEW_ROUTER_RELEASE_IMAGE_PROVENANCE_FILE");
const token = required("GITHUB_CONTROL_READ_TOKEN");
if (!/^[a-f0-9]{40}$/u.test(expectedCommit))
  throw new Error("private_pg17_release_image_expected_sha_invalid");

const api = async <T>(path: string): Promise<T> => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok)
    throw new Error(`private_pg17_release_image_api_failed:${response.status}`);
  return (await response.json()) as T;
};

const identity = assertReleaseImageIdentity(
  JSON.parse(readFileSync(identityPath, "utf8")) as ReleaseImageIdentity,
);
if (identity.repository !== repository || identity.commit !== expectedCommit)
  throw new Error("private_pg17_release_image_identity_mismatch");

const artifact = await api<{
  id?: number;
  name?: string;
  expired?: boolean;
  workflow_run?: { id?: number; head_sha?: string } | null;
}>(`/repos/${repository}/actions/artifacts/${artifactId}`);
if (
  artifact.id !== Number(artifactId) ||
  artifact.expired !== false ||
  typeof artifact.name !== "string" ||
  !artifact.name.startsWith("hosted-runtime-image-v") ||
  artifact.workflow_run?.id !== Number(releaseRunId) ||
  artifact.workflow_run.head_sha !== expectedCommit
)
  throw new Error("private_pg17_release_image_artifact_mismatch");

const run = await api<{
  id?: number;
  run_attempt?: number;
  event?: string;
  head_sha?: string;
  path?: string;
  conclusion?: string | null;
  repository?: { full_name?: string };
}>(`/repos/${repository}/actions/runs/${releaseRunId}/attempts/1`);
if (
  run.id !== Number(releaseRunId) ||
  run.run_attempt !== 1 ||
  run.event !== "workflow_dispatch" ||
  run.head_sha !== expectedCommit ||
  run.path !== ".github/workflows/release.yml" ||
  run.conclusion !== "success" ||
  run.repository?.full_name !== repository
)
  throw new Error("private_pg17_release_image_run_mismatch");

const verified = spawnSync(
  "gh",
  [
    "attestation",
    "verify",
    identityPath,
    "--repo",
    repository,
    "--deny-self-hosted-runners",
    "--signer-workflow",
    `github.com/${repository}/.github/workflows/release.yml`,
    "--source-digest",
    expectedCommit,
    "--source-ref",
    "refs/heads/main",
  ],
  {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      GH_TOKEN: token,
    },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
if (verified.status !== 0)
  throw new Error("private_pg17_release_image_attestation_invalid");

const provenance: VerifiedReleaseImageProvenance = {
  schemaVersion: "reviewrouter.release-image-provenance.v1",
  identity,
  identitySha256: `sha256:${sha256Canonical(identity)}`,
  releaseEvidence: {
    kind: "github-artifact-attestation",
    repository,
    workflowPath: ".github/workflows/release.yml",
    workflowRunId: releaseRunId,
    artifactId,
    artifactName: artifact.name,
    sourceRef: "refs/heads/main",
    verifiedAt: new Date().toISOString(),
  },
};
assertVerifiedReleaseImageProvenance(provenance, {
  repository,
  commit: expectedCommit,
});
writeFileSync(outputPath, `${JSON.stringify(provenance)}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
