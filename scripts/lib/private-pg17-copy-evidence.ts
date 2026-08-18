import {
  assertLegacyAmbiguityEvidence,
  type QuiescenceEvidence,
  type ReleaseRollout,
  type RunnerIdentity,
  type VerifiedReleaseImageProvenance,
} from "../../packages/features/release-rollout/src/index";

export type PrivatePg17CopyEvidence = {
  rollout: ReleaseRollout;
  releaseImageProvenance: VerifiedReleaseImageProvenance;
  roleBootstrapRunner: RunnerIdentity;
  backup: unknown;
  quiescence: QuiescenceEvidence;
  equivalence: unknown;
  generationBinding: unknown;
  roleBootstrap: unknown;
};

export function parsePrivatePg17CopyEvidence(
  value: unknown,
): PrivatePg17CopyEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("private_pg17_copy_evidence_shape_invalid");
  const item = value as Record<string, unknown>;
  const keys = [
    "rollout",
    "releaseImageProvenance",
    "roleBootstrapRunner",
    "backup",
    "quiescence",
    "equivalence",
    "generationBinding",
    "roleBootstrap",
  ];
  if (
    Object.keys(item).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(item, key))
  )
    throw new Error("private_pg17_copy_evidence_shape_invalid");
  if (
    item.quiescence === null ||
    typeof item.quiescence !== "object" ||
    Array.isArray(item.quiescence)
  )
    throw new Error("private_pg17_copy_evidence_shape_invalid");
  const quiescence = item.quiescence as Record<string, unknown>;
  if (
    Object.hasOwn(quiescence, "evidence") ||
    quiescence.complete !== true ||
    typeof quiescence.fence !== "object"
  )
    throw new Error("private_pg17_copy_evidence_shape_invalid");
  assertLegacyAmbiguityEvidence(quiescence.legacyAmbiguity);
  return item as PrivatePg17CopyEvidence;
}
