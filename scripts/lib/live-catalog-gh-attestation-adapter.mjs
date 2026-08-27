import { spawnSync } from "node:child_process";

export function verifyWithGhAttestation(input, spawn = spawnSync) {
  const signerWorkflow = `${input.repository}/.github/workflows/attest-live-catalog-digest.yml`;
  const result = spawn(
    "gh",
    [
      "attestation",
      "verify",
      input.claimPath,
      "--bundle",
      input.bundlePath,
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
}
