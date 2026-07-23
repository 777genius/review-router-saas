import {
  buildActionOidcReplayNonceKey,
  validateOidcClaimsAgainstRepository,
  type ActionControlPlaneRepositoryPort,
  type ActionRepositoryContext,
  type GitHubActionsOidcClaims,
  type GitHubActionsOidcTokenVerifierPort,
} from "@reviewrouter/features-action-control-plane";
import {
  type RegisterReviewRunControlV2RoutesDependencies,
  ReviewActionV2RouteFailure,
} from "@reviewrouter/features-action-control-plane/v2";
import {
  ReviewRequestedIntentState,
  type ReviewRequestedIntent,
} from "@reviewrouter/features-review-executions";
import {
  ProducerDistributionKind,
  CanonicalReviewRevisionResolutionStatus,
  ProducerReleaseAttestationStatus,
  ProducerReleaseState,
  ReviewCapabilityProfile,
  ReviewRunAuthorizationDenialReason,
  ReviewRunAuthorizationTokenResolutionStatus,
  ReviewRunAuthorizationUseCaseStatus,
  ReviewTrustDomain,
  ScmProvider,
  canonicalJson,
  canonicalReviewProtocolLimits,
  type ProducerReleaseQueryPort,
  type CanonicalReviewRevisionResolverPort,
  type ProducerReleaseAttestationPort,
  type ProviderVoteLane,
  type ReviewProtocolLimits,
  type ReviewRunAuthorizationUseCaseResult,
  type ScmRepositoryIdentityQueryPort,
  type Sha256DigestPort,
  type VerifiedScmRunIdentity,
} from "@reviewrouter/features-review-run-control";
import type { ReviewRunControlComposition } from "@reviewrouter/features-review-run-control/composition";
import {
  canonicalizeReviewActionV2Request,
  reviewActionV2CanonicalizerDigest,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewRunAuthorizationResultStatus,
  type ReviewRunAuthorizeRequest,
  type ReviewRunAuthorizeResult,
  type ReviewRunRenewRequest,
  type ReviewRunRenewResult,
} from "@reviewrouter/protocol-review-action-v2";

export type ReviewActionV2ResolvedRevision = {
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly reviewRevisionHash: string;
  readonly trustDomain: ReviewTrustDomain;
  readonly producerReleaseId: string;
  readonly producerActionCommitSha: string;
  readonly providerVoteLanes: readonly ProviderVoteLane[];
};

export interface ReviewActionV2RunAdmissionFactsPort {
  resolve(input: {
    readonly claims: GitHubActionsOidcClaims;
    readonly repository: ActionRepositoryContext;
    readonly scmRepositoryIdentityId: string;
  }): Promise<ReviewActionV2ResolvedRevision>;
}

export interface ReviewActionV2RevisionHashPort {
  digest(input: {
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly scmRepositoryIdentityId: string;
    readonly pullRequestNumber: number;
    readonly baseSha: string;
    readonly mergeBaseSha: string;
    readonly headSha: string;
  }): Promise<string>;
}

export type ServerOwnedReviewActionV2AdmissionDependencies = {
  readonly revisionResolver: CanonicalReviewRevisionResolverPort;
  readonly releaseAttestations: ProducerReleaseAttestationPort;
  readonly providerVoteLanes: readonly ProviderVoteLane[];
  readonly requestedIntents?: {
    findByRepositorySourceRunIdentity(input: {
      readonly repositoryConnectionId: string;
      readonly sourceRunId: string;
      readonly sourceRunAttempt: string;
    }): Promise<ReviewRequestedIntent | null>;
  };
  readonly requestedIntentRequired?: boolean;
};

export function createServerOwnedReviewActionV2AdmissionFacts(
  dependencies: ServerOwnedReviewActionV2AdmissionDependencies,
): ReviewActionV2RunAdmissionFactsPort {
  if (
    typeof dependencies.revisionResolver?.resolve !== "function" ||
    typeof dependencies.releaseAttestations?.attest !== "function" ||
    !Array.isArray(dependencies.providerVoteLanes) ||
    dependencies.providerVoteLanes.length === 0 ||
    dependencies.providerVoteLanes.some(
      (lane) => !isSha256(lane.providerVoteIdentityHash),
    )
  ) {
    throw new Error("review_action_v2_admission_dependencies_unavailable");
  }
  return {
    async resolve(input) {
      const repositoryName = splitRepositoryFullName(input.repository.fullName);
      const requestedIntent = dependencies.requestedIntents
        ? await dependencies.requestedIntents.findByRepositorySourceRunIdentity(
            {
              repositoryConnectionId: input.repository.repositoryId,
              sourceRunId: input.claims.run_id,
              sourceRunAttempt: input.claims.run_attempt,
            },
          )
        : null;
      if (
        dependencies.requestedIntentRequired === true &&
        (!requestedIntent ||
          requestedIntent.state !==
            ReviewRequestedIntentState.AwaitingAuthorization)
      ) {
        throw routeFailure(
          403,
          ReviewActionV2ProtocolErrorCode.Forbidden,
          "review_request_intent_required",
        );
      }
      const pullRequestNumberHint =
        requestedIntent?.pullRequestNumber ??
        pullRequestNumberHintFromClaims(input.claims);
      const producerActionCommitSha = producerActionCommitFromClaims(
        input.claims,
      );
      const revision = await dependencies.revisionResolver.resolve({
        workspaceId: input.repository.workspaceId,
        repositoryConnectionId: input.repository.repositoryId,
        scmRepositoryIdentityId: input.scmRepositoryIdentityId,
        githubInstallationId: input.repository.githubInstallationId,
        owner: repositoryName.owner,
        repo: repositoryName.repo,
        sourceRunId: input.claims.run_id,
        pullRequestNumberHint,
      });
      if (
        revision.status !== CanonicalReviewRevisionResolutionStatus.Resolved
      ) {
        throw revisionResolutionFailure(revision.status);
      }
      if (
        requestedIntent &&
        (requestedIntent.pullRequestNumber !== revision.pullRequestNumber ||
          requestedIntent.revision.reviewRevisionHash !==
            revision.reviewRevisionHash)
      ) {
        throw routeFailure(
          412,
          ReviewActionV2ProtocolErrorCode.StalePrecondition,
          "review_request_revision_moved",
        );
      }
      const attestation = await dependencies.releaseAttestations.attest({
        actionCommitSha: producerActionCommitSha,
        expectedSchemaDigest: reviewActionV2PublishedSchemaDigest,
        expectedCanonicalizerDigest: reviewActionV2CanonicalizerDigest,
      });
      if (attestation.status !== ProducerReleaseAttestationStatus.Attested) {
        throw producerReleaseAttestationFailure(attestation.status);
      }
      return {
        pullRequestNumber: revision.pullRequestNumber,
        baseSha: revision.baseSha,
        mergeBaseSha: revision.mergeBaseSha,
        headSha: revision.headSha,
        reviewRevisionHash: revision.reviewRevisionHash,
        trustDomain: ReviewTrustDomain.TrustedManaged,
        producerReleaseId: attestation.release.producerReleaseId,
        producerActionCommitSha,
        providerVoteLanes: dependencies.providerVoteLanes.map((lane) => ({
          ...lane,
        })),
      };
    },
  };
}

function splitRepositoryFullName(fullName: string): {
  readonly owner: string;
  readonly repo: string;
} {
  const segments = fullName.split("/");
  if (
    segments.length !== 2 ||
    !segments[0] ||
    !segments[1] ||
    segments.some((segment) => segment.trim() !== segment)
  ) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "repository_full_name_invalid",
    );
  }
  return { owner: segments[0], repo: segments[1] };
}

function pullRequestNumberHintFromClaims(
  claims: GitHubActionsOidcClaims,
): number | null {
  const candidates = [claims.ref, claims.workflow_ref]
    .filter((value): value is string => typeof value === "string")
    .map((value) =>
      /(?:^|@)refs\/pull\/([1-9][0-9]*)\/(?:merge|head)$/.exec(value),
    )
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  const unique = [...new Set(candidates)];
  if (
    unique.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    unique.length > 1
  ) {
    throw routeFailure(
      409,
      ReviewActionV2ProtocolErrorCode.IdempotencyConflict,
      "pull_request_identity_conflict",
    );
  }
  return unique[0] ?? null;
}

function producerActionCommitFromClaims(
  claims: GitHubActionsOidcClaims,
): string {
  const actionCommitSha = claims.job_workflow_sha?.toLowerCase();
  const workflowRefCommit = claims.job_workflow_ref
    ? /^777genius\/review-router\/\.github\/workflows\/reviewrouter-execution-reusable\.yml@([a-f0-9]{40})$/i
        .exec(claims.job_workflow_ref)?.[1]
        ?.toLowerCase()
    : undefined;
  if (
    !actionCommitSha ||
    !isCommitSha(actionCommitSha) ||
    !workflowRefCommit ||
    workflowRefCommit !== actionCommitSha
  ) {
    throw routeFailure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "producer_release_workflow_not_immutable",
    );
  }
  return actionCommitSha;
}

function revisionResolutionFailure(
  status: Exclude<
    CanonicalReviewRevisionResolutionStatus,
    CanonicalReviewRevisionResolutionStatus.Resolved
  >,
): ReviewActionV2RouteFailure {
  switch (status) {
    case CanonicalReviewRevisionResolutionStatus.PullRequestConflict:
    case CanonicalReviewRevisionResolutionStatus.MergeBaseConflict:
      return routeFailure(
        409,
        ReviewActionV2ProtocolErrorCode.IdempotencyConflict,
        status,
      );
    case CanonicalReviewRevisionResolutionStatus.PullRequestUnavailable:
      return routeFailure(
        404,
        ReviewActionV2ProtocolErrorCode.NotFound,
        status,
      );
    case CanonicalReviewRevisionResolutionStatus.MergeBaseUnavailable:
    case CanonicalReviewRevisionResolutionStatus.RevisionMoved:
      return routeFailure(
        412,
        ReviewActionV2ProtocolErrorCode.StalePrecondition,
        status,
      );
  }
}

function producerReleaseAttestationFailure(
  status: Exclude<
    ProducerReleaseAttestationStatus,
    ProducerReleaseAttestationStatus.Attested
  >,
): ReviewActionV2RouteFailure {
  switch (status) {
    case ProducerReleaseAttestationStatus.Unregistered:
      return routeFailure(
        404,
        ReviewActionV2ProtocolErrorCode.NotFound,
        "producer_release_unregistered",
      );
    case ProducerReleaseAttestationStatus.Revoked:
      return routeFailure(
        410,
        ReviewActionV2ProtocolErrorCode.ResourceGone,
        "producer_release_revoked",
      );
    case ProducerReleaseAttestationStatus.Mismatch:
      return routeFailure(
        403,
        ReviewActionV2ProtocolErrorCode.Forbidden,
        "producer_release_attestation_mismatch",
      );
  }
}

type ReviewRunAuthorizationApi = Pick<
  ReviewRunControlComposition["authorizations"],
  | "authorizeReviewRun"
  | "renewReviewRunAuthorization"
  | "resolveReviewRunAuthorizationToken"
>;

export type ReviewActionV2RunControlHandlerDependencies = {
  readonly oidcVerifier: GitHubActionsOidcTokenVerifierPort;
  readonly oidcAudience: string;
  readonly actionRepositories: ActionControlPlaneRepositoryPort;
  readonly repositoryIdentities: ScmRepositoryIdentityQueryPort;
  readonly producerReleases: ProducerReleaseQueryPort;
  readonly admissionFacts: ReviewActionV2RunAdmissionFactsPort;
  readonly revisionHashes: ReviewActionV2RevisionHashPort;
  readonly authorizations: ReviewRunAuthorizationApi;
  readonly digest: Sha256DigestPort;
  readonly absoluteProtocolMaxima: ReviewProtocolLimits;
  readonly authorizationTtlMs: number;
  readonly maxAuthorizationLifetimeMs: number;
};

export function composeReviewActionV2RunControlRoutes(input: {
  readonly enabled: boolean;
  readonly runtime: Pick<
    RegisterReviewRunControlV2RoutesDependencies,
    "readServerTime" | "createRequestId"
  >;
  readonly handlers?: ReviewActionV2RunControlHandlerDependencies | undefined;
}): RegisterReviewRunControlV2RoutesDependencies {
  if (!input.enabled) return input.runtime;
  if (!input.handlers) {
    throw new Error("review_action_v2_run_control_dependencies_unavailable");
  }
  const handlers = createReviewActionV2RunControlHandlers(input.handlers);
  return { ...input.runtime, ...handlers };
}

export function createReviewActionV2RunControlHandlers(
  dependencies: ReviewActionV2RunControlHandlerDependencies,
): Pick<RegisterReviewRunControlV2RoutesDependencies, "authorize" | "renew"> {
  validateCompositionConfiguration(dependencies);
  return {
    authorize: {
      capabilityEnabled: true,
      execute: async (request) => authorizeReviewRun(request, dependencies),
    },
    renew: {
      capabilityEnabled: true,
      execute: async (request) => renewReviewRun(request, dependencies),
    },
  };
}

async function authorizeReviewRun(
  request: ReviewRunAuthorizeRequest,
  dependencies: ReviewActionV2RunControlHandlerDependencies,
): Promise<{
  readonly statusCode: 200 | 201;
  readonly result: ReviewRunAuthorizeResult;
}> {
  assertPublishedOffer(request);
  const resolved = await resolveVerifiedIdentity(
    request.oidcToken,
    dependencies,
  );
  await assertRegisteredRelease(resolved.facts, dependencies);
  const [protocolOfferHash, oidcReplayKeyHash] = await Promise.all([
    dependencies.digest.digestUtf8(canonicalProtocolOffer(request)),
    dependencies.digest.digestUtf8(
      buildActionOidcReplayNonceKey(resolved.claims),
    ),
  ]);
  const outcome = await dependencies.authorizations.authorizeReviewRun({
    verifiedIdentity: resolved.identity,
    producerReleaseId: resolved.facts.producerReleaseId,
    protocolOfferHash,
    oidcReplayKeyHash,
    providerVoteLanes: resolved.facts.providerVoteLanes,
    authorizationTtlMs: dependencies.authorizationTtlMs,
    maxAuthorizationLifetimeMs: dependencies.maxAuthorizationLifetimeMs,
  });
  const success = requireAuthorizationSuccess(
    ReviewActionV2OperationId.ReviewRunAuthorize,
    outcome,
  );
  const protocolLimits = success.protocolLimits;
  if (!protocolLimits) {
    throw routeFailure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "release_profile_unavailable",
    );
  }
  const protocolLimitsCanonicalJson =
    canonicalReviewProtocolLimits(protocolLimits);
  const actualLimitsDigest = await dependencies.digest.digestUtf8(
    protocolLimitsCanonicalJson,
  );
  if (
    actualLimitsDigest !== protocolLimits.limitsDigest ||
    success.authorization.schemaDigest !==
      reviewActionV2PublishedSchemaDigest ||
    success.authorization.protocolLimitsProfileId !==
      protocolLimits.protocolLimitsProfileId
  ) {
    throw routeFailure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "release_profile_digest_mismatch",
    );
  }
  assertProtocolLimitsWithinMaxima(
    protocolLimits,
    dependencies.absoluteProtocolMaxima,
  );
  return {
    statusCode:
      success.status === ReviewRunAuthorizationUseCaseStatus.Authorized
        ? 201
        : 200,
    result: {
      status: mapSuccessStatus(success.status),
      authorizationId: success.authorization.authorizationId,
      authorizationToken: success.token.token,
      producerReleaseId: success.authorization.producerReleaseId,
      protocolLimitsProfileId: success.authorization.protocolLimitsProfileId,
      operationalSloProfileId: success.authorization.operationalSloProfileId,
      mutationEpoch: success.authorization.mutationEpoch.toString(10),
      expiresAt: success.authorization.expiresAt.toISOString(),
      authorizationFactsCanonicalJson: canonicalJson({
        workspaceId: success.authorization.workspaceId,
        repositoryConnectionId: success.authorization.repositoryConnectionId,
        scmRepositoryIdentityId: success.authorization.scmRepositoryIdentityId,
        pullRequestNumber: success.authorization.pullRequestNumber,
        sourceRunId: success.authorization.sourceRunId,
        sourceRunAttempt: success.authorization.sourceRunAttempt,
        baseSha: success.authorization.baseSha,
        mergeBaseSha: success.authorization.mergeBaseSha,
        headSha: success.authorization.headSha,
        reviewRevisionHash: success.authorization.reviewRevisionHash,
        trustDomain: success.authorization.trustDomain,
        producerReleaseId: success.authorization.producerReleaseId,
        selectedProtocolVersion: success.authorization.selectedProtocolVersion,
        schemaDigest: success.authorization.schemaDigest,
        providerVoteLanes: success.authorization.providerVoteLanes,
      }),
      protocolLimitsCanonicalJson,
    },
  };
}

async function renewReviewRun(
  request: ReviewRunRenewRequest,
  dependencies: ReviewActionV2RunControlHandlerDependencies,
): Promise<{
  readonly statusCode: 200;
  readonly result: ReviewRunRenewResult;
}> {
  await assertRequestBodyHash(request, dependencies.digest);
  const token =
    await dependencies.authorizations.resolveReviewRunAuthorizationToken({
      token: request.authorizationToken,
    });
  if (token.status !== ReviewRunAuthorizationTokenResolutionStatus.Valid) {
    throw tokenResolutionFailure(token.status);
  }
  if (token.authorization.authorizationId !== request.authorizationId) {
    throw routeFailure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "authorization_scope_mismatch",
    );
  }
  const resolved = await resolveVerifiedIdentity(
    request.oidcToken,
    dependencies,
  );
  const renewalReplayKeyHash = await dependencies.digest.digestUtf8(
    canonicalJson({
      authorizationId: request.authorizationId,
      idempotencyKey: request.idempotencyKey,
      renewalRequestId: request.renewalRequestId,
      oidcReplayKey: buildActionOidcReplayNonceKey(resolved.claims),
      requestBodyHash: request.requestBodyHash,
    }),
  );
  const outcome = await dependencies.authorizations.renewReviewRunAuthorization(
    {
      authorizationId: request.authorizationId,
      verifiedIdentity: resolved.identity,
      renewalReplayKeyHash,
      requestedTtlMs: request.requestedTtlMs,
    },
  );
  const success = requireAuthorizationSuccess(
    ReviewActionV2OperationId.ReviewRunRenew,
    outcome,
  );
  return {
    statusCode: 200,
    result: {
      status: mapSuccessStatus(success.status),
      authorizationId: success.authorization.authorizationId,
      authorizationToken: success.token.token,
      mutationEpoch: success.authorization.mutationEpoch.toString(10),
      expiresAt: success.authorization.expiresAt.toISOString(),
    },
  };
}

async function resolveVerifiedIdentity(
  oidcToken: string,
  dependencies: ReviewActionV2RunControlHandlerDependencies,
): Promise<{
  readonly claims: GitHubActionsOidcClaims;
  readonly identity: VerifiedScmRunIdentity;
  readonly facts: ReviewActionV2ResolvedRevision;
}> {
  const claims = await verifyOidc(oidcToken, dependencies);
  const repository =
    await dependencies.actionRepositories.findSelectedRepositoryByGithubId(
      claims.repository_id,
    );
  if (!repository) {
    throw routeFailure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "repository_not_registered",
    );
  }
  try {
    validateOidcClaimsAgainstRepository({ claims, repository });
  } catch {
    throw routeFailure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "repository_identity_mismatch",
    );
  }
  const scmIdentity =
    await dependencies.repositoryIdentities.findScmRepositoryIdentityByExternalIdentity(
      {
        provider: ScmProvider.GitHub,
        normalizedSourceBaseUrl: "https://github.com",
        externalRepositoryId: claims.repository_id,
      },
    );
  if (
    !scmIdentity ||
    scmIdentity.currentWorkspaceId !== repository.workspaceId ||
    scmIdentity.currentRepositoryConnectionId !== repository.repositoryId
  ) {
    throw routeFailure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "repository_binding_mismatch",
    );
  }
  const facts = await dependencies.admissionFacts.resolve({
    claims,
    repository,
    scmRepositoryIdentityId: scmIdentity.scmRepositoryIdentityId,
  });
  if (
    !Number.isSafeInteger(facts.pullRequestNumber) ||
    facts.pullRequestNumber <= 0 ||
    !isCommitSha(facts.baseSha) ||
    !isCommitSha(facts.mergeBaseSha) ||
    !isCommitSha(facts.headSha) ||
    !isCommitSha(facts.producerActionCommitSha) ||
    !isSha256(facts.reviewRevisionHash)
  ) {
    throw routeFailure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "review_revision_invalid",
    );
  }
  if (facts.trustDomain !== ReviewTrustDomain.TrustedManaged) {
    throw routeFailure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "trust_domain_not_enabled",
    );
  }
  const canonicalRevisionHash = await dependencies.revisionHashes.digest({
    workspaceId: repository.workspaceId,
    repositoryConnectionId: repository.repositoryId,
    scmRepositoryIdentityId: scmIdentity.scmRepositoryIdentityId,
    pullRequestNumber: facts.pullRequestNumber,
    baseSha: facts.baseSha,
    mergeBaseSha: facts.mergeBaseSha,
    headSha: facts.headSha,
  });
  if (canonicalRevisionHash !== facts.reviewRevisionHash) {
    throw routeFailure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "review_revision_hash_mismatch",
    );
  }
  const workflowIdentityHash = await dependencies.digest.digestUtf8(
    canonicalJson({
      jobWorkflowRef: claims.job_workflow_ref ?? null,
      jobWorkflowSha: claims.job_workflow_sha?.toLowerCase() ?? null,
      workflowRef: claims.workflow_ref,
      workflowSha: claims.workflow_sha?.toLowerCase() ?? null,
    }),
  );
  return {
    claims,
    facts,
    identity: {
      workspaceId: repository.workspaceId,
      repositoryConnectionId: repository.repositoryId,
      scmRepositoryIdentityId: scmIdentity.scmRepositoryIdentityId,
      pullRequestNumber: facts.pullRequestNumber,
      sourceRunId: claims.run_id,
      sourceRunAttempt: claims.run_attempt,
      workflowIdentityHash,
      baseSha: facts.baseSha.toLowerCase(),
      mergeBaseSha: facts.mergeBaseSha.toLowerCase(),
      headSha: facts.headSha.toLowerCase(),
      reviewRevisionHash: facts.reviewRevisionHash,
      trustDomain: facts.trustDomain,
    },
  };
}

async function verifyOidc(
  token: string,
  dependencies: ReviewActionV2RunControlHandlerDependencies,
): Promise<GitHubActionsOidcClaims> {
  try {
    return await dependencies.oidcVerifier.verify({
      token,
      audience: dependencies.oidcAudience,
    });
  } catch {
    throw routeFailure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "oidc_verification_failed",
    );
  }
}

async function assertRegisteredRelease(
  facts: ReviewActionV2ResolvedRevision,
  dependencies: ReviewActionV2RunControlHandlerDependencies,
): Promise<void> {
  const release = await dependencies.producerReleases.findProducerReleaseById(
    facts.producerReleaseId,
  );
  if (!release || release.state !== ProducerReleaseState.Registered) {
    throw routeFailure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "producer_release_unavailable",
    );
  }
  if (
    release.distributionKind !== ProducerDistributionKind.PublicReusable ||
    release.capabilityProfile !== ReviewCapabilityProfile.ExactRevisionV2 ||
    release.actionCommitSha !== facts.producerActionCommitSha.toLowerCase() ||
    release.schemaDigest !== reviewActionV2PublishedSchemaDigest
  ) {
    throw routeFailure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "producer_release_identity_mismatch",
    );
  }
}

function assertPublishedOffer(request: ReviewRunAuthorizeRequest): void {
  const offered = request.supportedProtocols.some(
    (offer) =>
      offer.protocolVersion === reviewActionV2PublishedProtocolVersion &&
      offer.schemaDigest === reviewActionV2PublishedSchemaDigest,
  );
  if (!offered) {
    throw routeFailure(
      426,
      ReviewActionV2ProtocolErrorCode.UnsupportedProtocol,
      "published_protocol_not_offered",
    );
  }
}

async function assertRequestBodyHash(
  request: ReviewRunRenewRequest,
  digest: Sha256DigestPort,
): Promise<void> {
  const canonical = canonicalizeReviewActionV2Request(
    ReviewActionV2OperationId.ReviewRunRenew,
    request,
  );
  if ((await digest.digestUtf8(canonical)) !== request.requestBodyHash) {
    throw routeFailure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "request_body_hash_mismatch",
    );
  }
}

function canonicalProtocolOffer(request: ReviewRunAuthorizeRequest): string {
  return canonicalJson({
    supportedProtocols: [...request.supportedProtocols].sort((left, right) =>
      `${left.protocolVersion}:${left.schemaDigest}`.localeCompare(
        `${right.protocolVersion}:${right.schemaDigest}`,
      ),
    ),
  });
}

function requireAuthorizationSuccess(
  operationId:
    | ReviewActionV2OperationId.ReviewRunAuthorize
    | ReviewActionV2OperationId.ReviewRunRenew,
  outcome: ReviewRunAuthorizationUseCaseResult,
) {
  switch (outcome.status) {
    case ReviewRunAuthorizationUseCaseStatus.Authorized:
    case ReviewRunAuthorizationUseCaseStatus.Restored:
    case ReviewRunAuthorizationUseCaseStatus.Renewed:
      return outcome;
    case ReviewRunAuthorizationUseCaseStatus.Denied:
      throw denialFailure(operationId, outcome.reason);
    case ReviewRunAuthorizationUseCaseStatus.Conflict:
      throw routeFailure(
        409,
        ReviewActionV2ProtocolErrorCode.IdempotencyConflict,
        "authorization_conflict",
      );
    case ReviewRunAuthorizationUseCaseStatus.Expired:
    case ReviewRunAuthorizationUseCaseStatus.Revoked:
      throw routeFailure(
        410,
        ReviewActionV2ProtocolErrorCode.ResourceGone,
        `authorization_${outcome.status}`,
      );
    case ReviewRunAuthorizationUseCaseStatus.Missing:
      throw routeFailure(
        404,
        ReviewActionV2ProtocolErrorCode.NotFound,
        "authorization_missing",
      );
  }
}

function denialFailure(
  operationId:
    | ReviewActionV2OperationId.ReviewRunAuthorize
    | ReviewActionV2OperationId.ReviewRunRenew,
  reason: ReviewRunAuthorizationDenialReason,
): ReviewActionV2RouteFailure {
  switch (reason) {
    case ReviewRunAuthorizationDenialReason.ProducerReleaseUnavailable:
    case ReviewRunAuthorizationDenialReason.ReleaseProfileUnavailable:
      return routeFailure(
        404,
        ReviewActionV2ProtocolErrorCode.NotFound,
        reason,
      );
    case ReviewRunAuthorizationDenialReason.VerifiedIdentityDrift:
    case ReviewRunAuthorizationDenialReason.SafetyDecisionChanged:
    case ReviewRunAuthorizationDenialReason.AdmissionFactsChanged:
      return routeFailure(
        412,
        ReviewActionV2ProtocolErrorCode.StalePrecondition,
        reason,
      );
    case ReviewRunAuthorizationDenialReason.RepositoryBindingMismatch:
    case ReviewRunAuthorizationDenialReason.MutationAuthorityUnavailable:
    case ReviewRunAuthorizationDenialReason.SafetyDecisionDisabled:
      return routeFailure(
        403,
        ReviewActionV2ProtocolErrorCode.Forbidden,
        `${operationId}:${reason}`,
      );
  }
}

function tokenResolutionFailure(
  status: Exclude<
    ReviewRunAuthorizationTokenResolutionStatus,
    ReviewRunAuthorizationTokenResolutionStatus.Valid
  >,
): ReviewActionV2RouteFailure {
  switch (status) {
    case ReviewRunAuthorizationTokenResolutionStatus.Invalid:
    case ReviewRunAuthorizationTokenResolutionStatus.ClaimDrift:
      return routeFailure(
        401,
        ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
        `authorization_token_${status}`,
      );
    case ReviewRunAuthorizationTokenResolutionStatus.Missing:
      return routeFailure(
        404,
        ReviewActionV2ProtocolErrorCode.NotFound,
        "authorization_missing",
      );
    case ReviewRunAuthorizationTokenResolutionStatus.Expired:
    case ReviewRunAuthorizationTokenResolutionStatus.Revoked:
      return routeFailure(
        410,
        ReviewActionV2ProtocolErrorCode.ResourceGone,
        `authorization_${status}`,
      );
  }
}

function mapSuccessStatus(
  status:
    | ReviewRunAuthorizationUseCaseStatus.Authorized
    | ReviewRunAuthorizationUseCaseStatus.Restored
    | ReviewRunAuthorizationUseCaseStatus.Renewed,
): ReviewRunAuthorizationResultStatus {
  switch (status) {
    case ReviewRunAuthorizationUseCaseStatus.Authorized:
      return ReviewRunAuthorizationResultStatus.Authorized;
    case ReviewRunAuthorizationUseCaseStatus.Restored:
      return ReviewRunAuthorizationResultStatus.Restored;
    case ReviewRunAuthorizationUseCaseStatus.Renewed:
      return ReviewRunAuthorizationResultStatus.Renewed;
  }
}

function routeFailure(
  statusCode: ConstructorParameters<typeof ReviewActionV2RouteFailure>[0],
  errorCode: ReviewActionV2ProtocolErrorCode,
  issue: string,
): ReviewActionV2RouteFailure {
  return new ReviewActionV2RouteFailure(statusCode, errorCode, [issue]);
}

function validateCompositionConfiguration(
  dependencies: ReviewActionV2RunControlHandlerDependencies,
): void {
  if (
    typeof dependencies.oidcVerifier?.verify !== "function" ||
    typeof dependencies.actionRepositories?.findSelectedRepositoryByGithubId !==
      "function" ||
    typeof dependencies.repositoryIdentities
      ?.findScmRepositoryIdentityByExternalIdentity !== "function" ||
    typeof dependencies.producerReleases?.findProducerReleaseById !==
      "function" ||
    typeof dependencies.admissionFacts?.resolve !== "function" ||
    typeof dependencies.revisionHashes?.digest !== "function" ||
    typeof dependencies.authorizations?.authorizeReviewRun !== "function" ||
    typeof dependencies.authorizations?.renewReviewRunAuthorization !==
      "function" ||
    typeof dependencies.authorizations?.resolveReviewRunAuthorizationToken !==
      "function" ||
    typeof dependencies.digest?.digestUtf8 !== "function" ||
    typeof dependencies.oidcAudience !== "string" ||
    dependencies.oidcAudience.length === 0 ||
    !hasValidProtocolLimits(dependencies.absoluteProtocolMaxima) ||
    !Number.isSafeInteger(dependencies.authorizationTtlMs) ||
    dependencies.authorizationTtlMs <= 0 ||
    !Number.isSafeInteger(dependencies.maxAuthorizationLifetimeMs) ||
    dependencies.maxAuthorizationLifetimeMs < dependencies.authorizationTtlMs
  ) {
    throw new Error("review_action_v2_run_control_configuration_invalid");
  }
}

const protocolLimitKeys = [
  "maxWorkSlots",
  "maxAttemptsPerSlot",
  "maxObservationBytes",
  "maxObservationFindings",
  "maxProjectionBytes",
  "maxProjectionFindings",
  "maxPublicationOperations",
  "maxPublicationChunks",
  "maxPublicationBodyBytes",
  "maxRequestBatchSize",
  "maxLeaseDurationMs",
  "maxResultReportDurationMs",
  "maxReconciliationDurationMs",
] as const satisfies readonly (keyof ReviewProtocolLimits)[];

function assertProtocolLimitsWithinMaxima(
  limits: ReviewProtocolLimits,
  maxima: ReviewProtocolLimits,
): void {
  for (const key of protocolLimitKeys) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] <= 0 ||
      !Number.isSafeInteger(maxima[key]) ||
      maxima[key] <= 0 ||
      limits[key] > maxima[key]
    ) {
      throw routeFailure(
        422,
        ReviewActionV2ProtocolErrorCode.InvariantViolation,
        `protocol_limit_invalid:${toSnakeCase(key)}`,
      );
    }
  }
}

function hasValidProtocolLimits(
  limits: ReviewProtocolLimits | null | undefined,
): limits is ReviewProtocolLimits {
  return (
    limits !== null &&
    limits !== undefined &&
    protocolLimitKeys.every(
      (key) => Number.isSafeInteger(limits[key]) && limits[key] > 0,
    )
  );
}

function isCommitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}
