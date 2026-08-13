import { createHash } from "node:crypto";

const witnessPattern = /^[A-Za-z0-9_-]{43,256}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export const runtimeRecoveryWitnessEnvKey =
  "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS";
export const runtimeRecoveryWitnessSha256EnvKey =
  "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256";

export function fingerprintRuntimeRecoveryWitness(witness: string): string {
  const normalized = witness.trim();
  if (!witnessPattern.test(normalized))
    throw new Error("runtime_recovery_witness_invalid");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function runtimeGenerationWitnessReplacement(input: {
  readonly witness: string;
  readonly expectedSha256: string;
}): Readonly<Record<string, string>> {
  if (
    !sha256Pattern.test(input.expectedSha256) ||
    fingerprintRuntimeRecoveryWitness(input.witness) !== input.expectedSha256
  )
    throw new Error("runtime_recovery_witness_binding_mismatch");
  return Object.freeze({
    [runtimeRecoveryWitnessEnvKey]: input.witness.trim(),
    [runtimeRecoveryWitnessSha256EnvKey]: input.expectedSha256,
  });
}
