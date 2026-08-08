import {
  assertDigest,
  assertIdentifier,
  canonicalJson,
} from "./canonicalization";
import { reviewInvestigationCriticPolicyV1 } from "./investigation-critic-policy";
import type { InvestigationObligationKind } from "./review-investigation-types";

export type ReviewInvestigationScope = Readonly<{
  workspaceId: string;
  repositoryConnectionId: string;
  scmRepositoryIdentityId: string;
  pullRequestNumber: number;
  trustDomain: string;
  authorizationScopeHash: string;
}>;

export type ReviewInvestigationRevision = Readonly<{
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  reviewRevisionHash: string;
}>;

export type ReviewInvestigationContract = Readonly<{
  coverageContractVersion: string;
  expansionRulesVersion: string;
  criticPolicyVersion: string;
  gatewayPolicyVersion: string;
  probePolicyVersion: string;
  producerReleaseId: string;
  runtimeProfileVersion: string;
  searchPolicyVersion: string;
}>;

export const reviewInvestigationProbePolicyV1 =
  "review-investigation-probe-policy.v1" as const;
export const reviewInvestigationSearchPolicyV1 =
  "review-investigation-fixed-string-search.v1" as const;

export enum ReviewInvestigationCoverageProfileGeneration {
  V1 = 1,
  V2 = 2,
  V3 = 3,
}

export const reviewInvestigationCoverageProfileV1 = Object.freeze({
  coverageContractVersion: "review-investigation-coverage.v1",
  expansionRulesVersion: "review-investigation-expansion.v1",
  criticPolicyVersion: reviewInvestigationCriticPolicyV1,
  gatewayPolicyVersion: "context-gateway-v2",
  probePolicyVersion: reviewInvestigationProbePolicyV1,
  runtimeProfileVersion: "review-investigation-runtime.v1",
  searchPolicyVersion: reviewInvestigationSearchPolicyV1,
} as const);

export const reviewInvestigationCoverageProfileV2 = Object.freeze({
  coverageContractVersion: "review-investigation-coverage.v1",
  expansionRulesVersion: "review-investigation-expansion.v2",
  criticPolicyVersion: reviewInvestigationCriticPolicyV1,
  gatewayPolicyVersion: "context-gateway-v4",
  probePolicyVersion: reviewInvestigationProbePolicyV1,
  runtimeProfileVersion: "gateway-attested-agent.v1",
  searchPolicyVersion: reviewInvestigationSearchPolicyV1,
} as const);

export const reviewInvestigationCoverageProfileV3 = Object.freeze({
  ...reviewInvestigationCoverageProfileV2,
  expansionRulesVersion: "review-investigation-expansion.v3",
} as const);

export function resolveReviewInvestigationCoverageProfileGeneration(
  contract: ReviewInvestigationContract,
): ReviewInvestigationCoverageProfileGeneration | null {
  if (
    contract.coverageContractVersion !==
    reviewInvestigationCoverageProfileV3.coverageContractVersion
  ) {
    return null;
  }
  const expectedKeys = [
    ...Object.keys(reviewInvestigationCoverageProfileV3),
    "producerReleaseId",
  ].sort();
  const actualKeys = Object.keys(contract).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("investigation_coverage_profile_unsupported");
  }
  for (const [generation, profile] of [
    [
      ReviewInvestigationCoverageProfileGeneration.V1,
      reviewInvestigationCoverageProfileV1,
    ],
    [
      ReviewInvestigationCoverageProfileGeneration.V2,
      reviewInvestigationCoverageProfileV2,
    ],
    [
      ReviewInvestigationCoverageProfileGeneration.V3,
      reviewInvestigationCoverageProfileV3,
    ],
  ] as const) {
    if (
      Object.entries(profile).every(
        ([field, expected]) =>
          contract[
            field as keyof typeof reviewInvestigationCoverageProfileV3
          ] === expected,
      )
    ) {
      return generation;
    }
  }
  throw new Error("investigation_coverage_profile_unsupported");
}

export function isTypedReviewInvestigationCoverageProfile(
  contract: ReviewInvestigationContract,
): boolean {
  const generation =
    resolveReviewInvestigationCoverageProfileGeneration(contract);
  return (
    generation === ReviewInvestigationCoverageProfileGeneration.V2 ||
    generation === ReviewInvestigationCoverageProfileGeneration.V3
  );
}

export function assertSupportedReviewInvestigationCoverageProfile(
  contract: ReviewInvestigationContract,
): void {
  if (!isTypedReviewInvestigationCoverageProfile(contract)) {
    throw new Error("investigation_coverage_profile_unsupported");
  }
}

export type SeedInvestigationObligation = Readonly<{
  kind: InvestigationObligationKind;
  canonicalSubject: string;
  canonicalRequirement: string;
  riskPriority: number;
}>;

export function assertInvestigationScope(
  scope: ReviewInvestigationScope,
): void {
  assertIdentifier(scope.workspaceId, "workspace_id");
  assertIdentifier(scope.repositoryConnectionId, "repository_connection_id");
  assertIdentifier(scope.scmRepositoryIdentityId, "scm_repository_identity_id");
  assertIdentifier(scope.trustDomain, "trust_domain");
  assertDigest(scope.authorizationScopeHash, "authorization_scope_hash");
  if (
    !Number.isSafeInteger(scope.pullRequestNumber) ||
    scope.pullRequestNumber <= 0
  ) {
    throw new Error("pull_request_number_invalid");
  }
}

export function canonicalInvestigationScope(
  scope: ReviewInvestigationScope,
): string {
  assertInvestigationScope(scope);
  return canonicalJson(scope);
}

export function assertInvestigationRevision(
  revision: ReviewInvestigationRevision,
): void {
  assertGitObjectId(revision.baseSha, "base_sha");
  assertGitObjectId(revision.mergeBaseSha, "merge_base_sha");
  assertGitObjectId(revision.headSha, "head_sha");
  assertDigest(revision.reviewRevisionHash, "review_revision_hash");
}

export function assertInvestigationContract(
  contract: ReviewInvestigationContract,
): void {
  const expected = [
    "coverageContractVersion",
    "expansionRulesVersion",
    "criticPolicyVersion",
    "gatewayPolicyVersion",
    "probePolicyVersion",
    "producerReleaseId",
    "runtimeProfileVersion",
    "searchPolicyVersion",
  ].sort();
  const actual = Object.keys(contract).sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error("investigation_contract_shape_invalid");
  }
  for (const [field, value] of Object.entries(contract)) {
    assertIdentifier(value, field);
  }
}

function assertGitObjectId(value: string, field: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new Error(`${field}_invalid`);
  }
}
