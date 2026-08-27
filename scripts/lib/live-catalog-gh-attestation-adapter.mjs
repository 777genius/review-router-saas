import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function verifyWithGhAttestation(input, spawn = spawnSync) {
  const signerWorkflow = `${input.repository}/.github/workflows/attest-live-catalog-digest.yml`;
  if (!Buffer.isBuffer(input.claimBytes) || !Buffer.isBuffer(input.bundleBytes))
    throw new Error("live_catalog_gh_exact_bytes_required");
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
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          ...(input.token ? { GH_TOKEN: input.token } : {}),
        },
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 120_000,
      },
    );
    if (result.error?.code === "ETIMEDOUT")
      throw new Error("live_catalog_gh_attestation_timeout");
    if (result.status !== 0)
      throw new Error("live_catalog_gh_attestation_invalid");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
