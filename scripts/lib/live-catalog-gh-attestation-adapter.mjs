import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export function verifyWithGhAttestation(input, spawn = spawnSync) {
  const signerWorkflow = `${input.repository}/.github/workflows/attest-live-catalog-digest.yml`;
  if (!Buffer.isBuffer(input.claimBytes) || !Buffer.isBuffer(input.bundleBytes))
    throw new Error("live_catalog_gh_exact_bytes_required");
  let expectedBundle;
  try {
    expectedBundle = JSON.parse(input.bundleBytes);
  } catch {
    throw new Error("live_catalog_gh_bundle_not_json");
  }
  const directory = mkdtempSync(join(tmpdir(), "rr-live-catalog-gh-"));
  const claimPath = join(directory, "claim.json");
  const bundlePath = join(directory, "bundle.json");
  try {
    writeFileSync(claimPath, input.claimBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(bundlePath, input.bundleBytes, { flag: "wx", mode: 0o600 });
    const result = spawn(
      "gh",
      [
        "attestation",
        "verify",
        claimPath,
        "--bundle",
        bundlePath,
        "--repo",
        input.repository,
        "--deny-self-hosted-runners",
        "--signer-workflow",
        signerWorkflow,
        "--source-ref",
        "refs/heads/main",
        "--source-digest",
        input.attestorCommit,
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          ...(input.token ? { GH_TOKEN: input.token } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      },
    );
    if (result.error?.code === "ETIMEDOUT")
      throw new Error("live_catalog_gh_attestation_timeout");
    if (result.status !== 0)
      throw new Error("live_catalog_gh_attestation_invalid");
    let verified;
    try {
      verified = JSON.parse(result.stdout);
    } catch {
      throw new Error("live_catalog_gh_attestation_output_invalid");
    }
    const expected = createHash("sha256")
      .update(input.claimBytes)
      .digest("hex");
    const subjects = verified?.flatMap(
      (entry) => entry?.verificationResult?.statement?.subject ?? [],
    );
    if (
      !Array.isArray(verified) ||
      verified.length !== 1 ||
      !Array.isArray(subjects) ||
      subjects.length !== 1 ||
      subjects[0]?.digest?.sha256 !== expected ||
      !isDeepStrictEqual(verified[0]?.attestation, expectedBundle)
    )
      throw new Error("live_catalog_gh_authenticated_subject_mismatch");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
