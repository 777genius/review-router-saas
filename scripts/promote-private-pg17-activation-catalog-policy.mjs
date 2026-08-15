import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJson,
  sha256Canonical,
} from "../packages/features/release-rollout/src/domain/release-rollout.ts";
import {
  canonicalActivationPrincipalNames,
  canonicalBootstrapMembershipRoleNames,
} from "../packages/features/release-rollout/src/domain/effective-principal-inventory.ts";

export const activationCatalogPromotionOptIn =
  "promote-reviewed-activation-catalog-v19";
export const reviewedActivationCatalogCandidate = Object.freeze({
  sha256: "e1e75fe2ec744c6b12fc762ef64a090ea3e66fb778edc4ef1f119614875ba0f0",
  bytes: 2_044_112,
  preactivationCatalogPolicySha256:
    "sha256:6e500c32e51fcf9421dc94c3f41a536c1cfaec9af3ce912c6a65b99460c8d5e2",
  activatedCatalogPolicySha256:
    "sha256:e88f3556a869977de67c02487663d7524dd19c5a3c11bb5541ada5cdc98f9b93",
  artifactCanonicalSha256:
    "sha256:d5f654f1dc66936a8f9c8ded9d2245f6f444d1352ef87256de495812a2510796",
});

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const activationCatalogArtifactPath = resolve(
  repositoryRoot,
  "packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js",
);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseArguments(argv) {
  let candidatePath;
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--candidate" && candidatePath === undefined) {
      candidatePath = argv[index + 1];
      index += 1;
    } else if (argument === "--write" && !write) {
      write = true;
    } else {
      throw new Error("activation_catalog_policy_promotion_arguments_invalid");
    }
  }
  if (!candidatePath)
    throw new Error("activation_catalog_policy_promotion_candidate_required");
  return { candidatePath: resolve(candidatePath), write };
}

function assertArtifactCandidate(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "kind,policies,version" ||
    value.kind !==
      "reviewrouter-activation-catalog-policy-artifact-candidate" ||
    value.version !== 1 ||
    value.policies === null ||
    typeof value.policies !== "object" ||
    Array.isArray(value.policies) ||
    Object.keys(value.policies).sort().join(",") !== "activated,preactivation"
  )
    throw new Error("activation_catalog_policy_promotion_candidate_invalid");
  assertNormalizedCandidatePolicy(
    value.policies.preactivation,
    "preactivation",
  );
  assertNormalizedCandidatePolicy(value.policies.activated, "activated");
}

function assertNormalizedCandidatePolicy(value, phase) {
  const fields = [
    "database",
    "effectivePermissions",
    "extensions",
    "grants",
    "kind",
    "memberships",
    "phase",
    "roleReachability",
    "roles",
    "rowSecurity",
    "version",
  ];
  const validRecord =
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    !validRecord ||
    Object.keys(value).sort().join(",") !== fields.join(",") ||
    value.kind !== "reviewrouter-activation-catalog-policy" ||
    value.version !== 1 ||
    value.phase !== phase ||
    value.database !== "review_router" ||
    !fields
      .filter(
        (field) => !["database", "kind", "phase", "version"].includes(field),
      )
      .every((field) => Array.isArray(value[field])) ||
    value.roles.map((role) => role?.name).join("\0") !==
      canonicalActivationPrincipalNames.join("\0") ||
    value.memberships.map((edge) => edge?.role).join("\0") !==
      canonicalBootstrapMembershipRoleNames.join("\0") ||
    value.memberships.some(
      (edge) =>
        edge?.member !== "reviewrouter_role_bootstrap" ||
        edge?.setOption !== false ||
        edge?.inheritOption !== false ||
        edge?.adminOption !== true ||
        Object.keys(edge?.grantor ?? {}).join(",") !== "kind" ||
        edge.grantor.kind !== "external-bootstrap-authority",
    ) ||
    value.effectivePermissions.map((entry) => entry?.principal).join("\0") !==
      canonicalActivationPrincipalNames.join("\0") ||
    new Set(value.grants.map((grant) => canonicalJson(grant))).size !==
      value.grants.length ||
    /(?:rehearsal(?:_|items)|app_private|rr_(?:direct|parent|inherited|set_|owner|super|bypass|column|sequence|routine))/u.test(
      canonicalJson(value),
    )
  )
    throw new Error(
      `activation_catalog_policy_promotion_normalization_invalid:${phase}`,
    );
}

export function canonicalActivationCatalogArtifactSource(candidateBytes) {
  if (!Buffer.isBuffer(candidateBytes))
    throw new Error("activation_catalog_policy_promotion_candidate_invalid");
  if (candidateBytes.byteLength !== reviewedActivationCatalogCandidate.bytes)
    throw new Error("activation_catalog_policy_promotion_candidate_size_drift");
  if (sha256(candidateBytes) !== reviewedActivationCatalogCandidate.sha256)
    throw new Error("activation_catalog_policy_promotion_candidate_hash_drift");
  let candidate;
  try {
    candidate = JSON.parse(candidateBytes.toString("utf8"));
  } catch {
    throw new Error("activation_catalog_policy_promotion_candidate_invalid");
  }
  assertArtifactCandidate(candidate);
  const artifact = {
    kind: "reviewrouter-activation-catalog-policy-artifact",
    version: 1,
    policies: candidate.policies,
  };
  const phaseDigests = {
    preactivationCatalogPolicySha256: `sha256:${sha256Canonical(
      artifact.policies.preactivation,
    )}`,
    activatedCatalogPolicySha256: `sha256:${sha256Canonical(
      artifact.policies.activated,
    )}`,
  };
  if (
    phaseDigests.preactivationCatalogPolicySha256 !==
      reviewedActivationCatalogCandidate.preactivationCatalogPolicySha256 ||
    phaseDigests.activatedCatalogPolicySha256 !==
      reviewedActivationCatalogCandidate.activatedCatalogPolicySha256
  )
    throw new Error("activation_catalog_policy_promotion_phase_digest_drift");
  const canonicalArtifact = canonicalJson(artifact);
  if (
    `sha256:${sha256(canonicalArtifact)}` !==
    reviewedActivationCatalogCandidate.artifactCanonicalSha256
  )
    throw new Error("activation_catalog_policy_promotion_artifact_drift");
  return Buffer.from(
    `// Generated by scripts/promote-private-pg17-activation-catalog-policy.mjs. Do not edit.\n` +
      `/** @type {unknown} */\n` +
      `const canonicalActivationCatalogPolicyArtifact = ${canonicalArtifact};\n` +
      `export default canonicalActivationCatalogPolicyArtifact;\n`,
    "utf8",
  );
}

export async function promotePrivatePg17ActivationCatalogPolicy({
  env = process.env,
  argv = process.argv.slice(2),
} = {}) {
  if (
    env.REVIEW_ROUTER_ACTIVATION_CATALOG_PROMOTION !==
    activationCatalogPromotionOptIn
  )
    throw new Error("activation_catalog_policy_promotion_opt_in_required");
  const { candidatePath, write } = parseArguments(argv);
  const generated = canonicalActivationCatalogArtifactSource(
    await readFile(candidatePath),
  );
  if (write) await writeFile(activationCatalogArtifactPath, generated);
  else {
    let existing;
    try {
      existing = await readFile(activationCatalogArtifactPath);
    } catch {
      throw new Error("activation_catalog_policy_promotion_artifact_missing");
    }
    if (!existing.equals(generated))
      throw new Error("activation_catalog_policy_promotion_artifact_drift");
  }
  return Object.freeze({
    candidatePath,
    candidateSha256: reviewedActivationCatalogCandidate.sha256,
    artifactPath: activationCatalogArtifactPath,
    artifactSourceSha256: sha256(generated),
    artifactCanonicalSha256:
      reviewedActivationCatalogCandidate.artifactCanonicalSha256,
    ...reviewedActivationCatalogCandidate,
    mode: write ? "promoted" : "verified",
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await promotePrivatePg17ActivationCatalogPolicy())}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
