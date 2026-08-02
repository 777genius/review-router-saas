import { assertDigest, assertIdentifier } from "./canonicalization";
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
  producerReleaseId: string;
  runtimeProfileVersion: string;
}>;

export type SeedInvestigationObligation = Readonly<{
  kind: InvestigationObligationKind;
  canonicalSubject: string;
  canonicalRequirement: string;
  riskPriority: number;
}>;

export function assertInvestigationScope(scope: ReviewInvestigationScope): void {
  assertIdentifier(scope.workspaceId, "workspace_id");
  assertIdentifier(scope.repositoryConnectionId, "repository_connection_id");
  assertIdentifier(scope.scmRepositoryIdentityId, "scm_repository_identity_id");
  assertIdentifier(scope.trustDomain, "trust_domain");
  assertDigest(scope.authorizationScopeHash, "authorization_scope_hash");
  if (!Number.isSafeInteger(scope.pullRequestNumber) || scope.pullRequestNumber <= 0) {
    throw new Error("pull_request_number_invalid");
  }
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
  for (const [field, value] of Object.entries(contract)) {
    assertIdentifier(value, field);
  }
}

function assertGitObjectId(value: string, field: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new Error(`${field}_invalid`);
  }
}
