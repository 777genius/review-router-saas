import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultActionOidcAudience,
  githubActionsOidcIssuer,
  type ActionControlPlaneRepositoryPort,
  type ActionRepositoryContext,
  type GitHubActionsOidcClaims,
} from "@reviewrouter/features-action-control-plane";
import {
  CanonicalReviewRevisionResolutionStatus,
  ProducerDistributionKind,
  ProducerReleaseAttestationStatus,
  ReviewCapabilityProfile,
  ReviewProviderKind,
  ReviewRunAuthorizationState,
  ReviewSafetyCapability,
  ReviewSafetyPolicyScope,
  ReviewSafetyRolloutMode,
  ReviewTrustDomain,
  ScmProvider,
  canonicalJson,
  canonicalReviewOperationalSloProfile,
  canonicalReviewProtocolLimits,
  type ReviewOperationalSloThresholds,
  type ReviewProtocolLimits,
} from "@reviewrouter/features-review-run-control";
import {
  createReviewRunControlTestKit,
  testAbsoluteProtocolMaxima,
  type ReviewRunControlTestKit,
} from "@reviewrouter/features-review-run-control/testing";
import {
  canonicalizeReviewActionV2Request,
  reviewActionV2GoldenFixtures,
  reviewActionV2PublishedSchemaDigest,
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewRunAuthorizationResultStatus,
  type ReviewRunAuthorizeRequest,
  type ReviewRunRenewRequest,
} from "@reviewrouter/protocol-review-action-v2";
import {
  composeReviewActionV2RunControlRoutes,
  createReviewActionV2RunControlHandlers,
  createServerOwnedReviewActionV2AdmissionFacts,
  type ReviewActionV2ResolvedRevision,
  type ReviewActionV2RunControlHandlerDependencies,
} from "./review-action-v2-run-control-composition.js";

const actionSha = "a".repeat(40);
const runtimeSha = "b".repeat(40);
const baseSha = "c".repeat(40);
const mergeBaseSha = "d".repeat(40);
const headSha = "e".repeat(40);
const hash = (character: string) => character.repeat(64);

class TestActionRepositories implements ActionControlPlaneRepositoryPort {
  repository: ActionRepositoryContext | null = {
    workspaceId: "workspace_1",
    repositoryId: "repository_1",
    githubRepositoryId: "123456",
    githubInstallationId: "98765",
    fullName: "777genius/example",
    owner: "777genius",
    selected: true,
    installationStatus: "active",
  };

  async findSelectedRepositoryByGithubId(githubRepositoryId: string) {
    return this.repository?.githubRepositoryId === githubRepositoryId
      ? this.repository
      : null;
  }

  async findRuntimeReviewConfiguration() {
    return null;
  }

  async recordHealthReport(): Promise<void> {}
}

describe("Review Action v2 run-control composition", () => {
  let kit: ReviewRunControlTestKit;
  let dependencies: ReviewActionV2RunControlHandlerDependencies;
  let facts: ReviewActionV2ResolvedRevision;
  let claimsByToken: Map<string, GitHubActionsOidcClaims>;

  beforeEach(async () => {
    kit = createReviewRunControlTestKit({
      now: new Date("2026-07-22T12:00:00.000Z"),
    });
    const repository = new TestActionRepositories();
    const identity =
      await kit.control.repositoryIdentities.resolveOrRegisterScmRepositoryIdentity(
        {
          provider: ScmProvider.GitHub,
          sourceBaseUrl: "https://github.com/",
          externalRepositoryId: "123456",
        },
      );
    const bound =
      await kit.control.repositoryIdentities.bindScmRepositoryIdentity({
        scmRepositoryIdentityId: identity.identity.scmRepositoryIdentityId,
        expectedVersion: identity.identity.version,
        workspaceId: "workspace_1",
        repositoryConnectionId: "repository_1",
      });
    if (!("identity" in bound)) throw new Error("test_identity_bind_failed");

    const limits: ReviewProtocolLimits = {
      maxWorkSlots: 100,
      maxAttemptsPerSlot: 4,
      maxObservationBytes: 1_000_000,
      maxObservationFindings: 1_000,
      maxProjectionBytes: 2_000_000,
      maxProjectionFindings: 2_000,
      maxPublicationOperations: 500,
      maxPublicationChunks: 500,
      maxPublicationBodyBytes: 2_000_000,
      maxRequestBatchSize: 100,
      maxLeaseDurationMs: 600_000,
      maxResultReportDurationMs: 1_200_000,
      maxReconciliationDurationMs: 3_600_000,
    };
    const slos: ReviewOperationalSloThresholds = {
      integrationEventDeliveryMs: 60_000,
      outboxClaimAgeMs: 120_000,
      missingCompletionProcessMs: 300_000,
      dueCompletionProcessMs: 300_000,
      publicationReconciliationMs: 600_000,
      v1DrainMs: 3_600_000,
      admissionMs: 30_000,
      pruningBacklogAgeMs: 86_400_000,
    };
    const limitsDigest = await kit.digest.digestUtf8(
      canonicalReviewProtocolLimits(limits),
    );
    const sloDigest = await kit.digest.digestUtf8(
      canonicalReviewOperationalSloProfile({
        thresholds: slos,
        ownerRefs: ["team-reviewrouter"],
        runbookRefs: ["runbook/review-v2"],
      }),
    );
    await kit.control.producerReleases.registerProtocolLimitsProfile({
      protocolLimitsProfileId: "limits_v2",
      limitsDigest,
      limits,
    });
    await kit.control.producerReleases.registerOperationalSloProfile({
      operationalSloProfileId: "slo_v2",
      sloDigest,
      thresholds: slos,
      ownerRefs: ["team-reviewrouter"],
      runbookRefs: ["runbook/review-v2"],
    });
    await kit.control.producerReleases.registerProducerRelease({
      candidate: {
        producerReleaseId: "release_v2",
        distributionKind: ProducerDistributionKind.PublicReusable,
        actionCommitSha: actionSha,
        runtimeCommitSha: runtimeSha,
        wrapperEntrypointDigest: null,
        runtimeEntrypointDigest: hash("1"),
        schemaDigest: reviewActionV2PublishedSchemaDigest,
        capabilityProfile: ReviewCapabilityProfile.ExactRevisionV2,
        protocolLimitsProfileId: "limits_v2",
        operationalSloProfileId: "slo_v2",
      },
      expectedProtocolLimitsDigest: limitsDigest,
      expectedOperationalSloDigest: sloDigest,
    });
    await kit.control.mutationAuthority.initialize({
      scmRepositoryIdentityId: identity.identity.scmRepositoryIdentityId,
    });
    await kit.control.safetyControls.setReviewSafetyEmergencyStop({
      expectedVersion: 0,
      scope: { scope: ReviewSafetyPolicyScope.Global },
      stopped: false,
      reason: "test-enabled",
      updatedBy: "test-operator",
    });
    await kit.control.safetyControls.updateReviewSafetyPolicy({
      expectedVersion: 0,
      scope: { scope: ReviewSafetyPolicyScope.Global },
      capability: ReviewSafetyCapability.RunAuthorizationV2,
      rolloutMode: ReviewSafetyRolloutMode.Enabled,
      updatedBy: "test-operator",
    });

    const revisionHashes = {
      digest: async (input: {
        readonly workspaceId: string;
        readonly repositoryConnectionId: string;
        readonly scmRepositoryIdentityId: string;
        readonly pullRequestNumber: number;
        readonly baseSha: string;
        readonly mergeBaseSha: string;
        readonly headSha: string;
      }) => kit.digest.digestUtf8(canonicalJson(input)),
    };
    const reviewRevisionHash = await revisionHashes.digest({
      workspaceId: "workspace_1",
      repositoryConnectionId: "repository_1",
      scmRepositoryIdentityId: identity.identity.scmRepositoryIdentityId,
      pullRequestNumber: 42,
      baseSha,
      mergeBaseSha,
      headSha,
    });
    facts = {
      pullRequestNumber: 42,
      baseSha,
      mergeBaseSha,
      headSha,
      reviewRevisionHash,
      trustDomain: ReviewTrustDomain.TrustedManaged,
      producerReleaseId: "release_v2",
      producerActionCommitSha: actionSha,
      providerVoteLanes: [
        {
          providerKind: ReviewProviderKind.Codex,
          providerVoteIdentityHash: hash("4"),
        },
      ],
    };
    claimsByToken = new Map([
      ["oidc-authorize", oidcClaims("authorize-jti")],
      ["oidc-renew", oidcClaims("renew-jti")],
    ]);
    dependencies = {
      oidcVerifier: {
        verify: async ({ token }) => {
          const claims = claimsByToken.get(token);
          if (!claims) throw new Error("oidc_invalid");
          return claims;
        },
      },
      oidcAudience: defaultActionOidcAudience,
      actionRepositories: repository,
      repositoryIdentities: kit.store,
      producerReleases: kit.store,
      admissionFacts: { resolve: async () => facts },
      revisionHashes,
      authorizations: kit.control.authorizations,
      digest: kit.digest,
      absoluteProtocolMaxima: testAbsoluteProtocolMaxima,
      authorizationTtlMs: 10 * 60_000,
      maxAuthorizationLifetimeMs: 60 * 60_000,
    };
  });

  it("stays disabled without requiring production-only admission dependencies", () => {
    const routes = composeReviewActionV2RunControlRoutes({
      enabled: false,
      runtime: {
        readServerTime: async () => kit.clock.now(),
        createRequestId: () => "request_id",
      },
    });

    expect(routes.authorize).toBeUndefined();
    expect(routes.renew).toBeUndefined();
  });

  it("fails closed when the feature flag is enabled without complete dependencies", () => {
    expect(() =>
      composeReviewActionV2RunControlRoutes({
        enabled: true,
        runtime: {
          readServerTime: async () => kit.clock.now(),
          createRequestId: () => "request_id",
        },
      }),
    ).toThrow("review_action_v2_run_control_dependencies_unavailable");
  });

  it("fails startup when an enabled handler prerequisite is absent", () => {
    expect(() =>
      composeReviewActionV2RunControlRoutes({
        enabled: true,
        runtime: {
          readServerTime: async () => kit.clock.now(),
          createRequestId: () => "request_id",
        },
        handlers: {
          ...dependencies,
          digest: undefined,
        } as unknown as ReviewActionV2RunControlHandlerDependencies,
      }),
    ).toThrow("review_action_v2_run_control_configuration_invalid");
  });

  it("resolves server-owned revision and immutable producer release facts", async () => {
    const release = await kit.store.findProducerReleaseById("release_v2");
    if (!release) throw new Error("test_release_missing");
    const revisionInputs: unknown[] = [];
    const admissionFacts = createServerOwnedReviewActionV2AdmissionFacts({
      revisionResolver: {
        resolve: async (input) => {
          revisionInputs.push(input);
          return {
            status: CanonicalReviewRevisionResolutionStatus.Resolved,
            pullRequestNumber: facts.pullRequestNumber,
            baseSha: facts.baseSha,
            mergeBaseSha: facts.mergeBaseSha,
            headSha: facts.headSha,
            reviewRevisionHash: facts.reviewRevisionHash,
          };
        },
      },
      releaseAttestations: {
        attest: async () => ({
          status: ProducerReleaseAttestationStatus.Attested,
          release,
        }),
      },
      providerVoteLanes: facts.providerVoteLanes,
    });

    const resolved = await admissionFacts.resolve({
      claims: oidcClaims("server-owned-jti"),
      repository: new TestActionRepositories().repository!,
      scmRepositoryIdentityId: "scm-identity-1",
    });

    expect(resolved).toMatchObject({
      pullRequestNumber: 42,
      producerReleaseId: "release_v2",
      producerActionCommitSha: actionSha,
      trustDomain: ReviewTrustDomain.TrustedManaged,
    });
    expect(revisionInputs).toEqual([
      expect.objectContaining({
        owner: "777genius",
        repo: "example",
        sourceRunId: "1001",
        pullRequestNumberHint: 42,
      }),
    ]);
  });

  it("rejects an unregistered server-owned producer release", async () => {
    const admissionFacts = createServerOwnedReviewActionV2AdmissionFacts({
      revisionResolver: {
        resolve: async () => ({
          status: CanonicalReviewRevisionResolutionStatus.Resolved,
          pullRequestNumber: facts.pullRequestNumber,
          baseSha: facts.baseSha,
          mergeBaseSha: facts.mergeBaseSha,
          headSha: facts.headSha,
          reviewRevisionHash: facts.reviewRevisionHash,
        }),
      },
      releaseAttestations: {
        attest: async () => ({
          status: ProducerReleaseAttestationStatus.Unregistered,
        }),
      },
      providerVoteLanes: facts.providerVoteLanes,
    });

    await expect(
      admissionFacts.resolve({
        claims: oidcClaims("unregistered-jti"),
        repository: new TestActionRepositories().repository!,
        scmRepositoryIdentityId: "scm-identity-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      issues: ["producer_release_unregistered"],
    });
  });

  it("rejects a producer workflow pinned to a floating ref", async () => {
    const admissionFacts = createServerOwnedReviewActionV2AdmissionFacts({
      revisionResolver: {
        resolve: async () => ({
          status: CanonicalReviewRevisionResolutionStatus.Resolved,
          pullRequestNumber: facts.pullRequestNumber,
          baseSha: facts.baseSha,
          mergeBaseSha: facts.mergeBaseSha,
          headSha: facts.headSha,
          reviewRevisionHash: facts.reviewRevisionHash,
        }),
      },
      releaseAttestations: {
        attest: async () => {
          throw new Error("attestation_must_not_run");
        },
      },
      providerVoteLanes: facts.providerVoteLanes,
    });

    await expect(
      admissionFacts.resolve({
        claims: {
          ...oidcClaims("floating-ref-jti"),
          job_workflow_ref:
            "777genius/review-router/.github/workflows/reviewrouter-reusable.yml@main",
        },
        repository: new TestActionRepositories().repository!,
        scmRepositoryIdentityId: "scm-identity-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      issues: ["producer_release_workflow_not_immutable"],
    });
  });

  it("authorizes once and restores the exact OIDC/protocol replay", async () => {
    const handlers = createReviewActionV2RunControlHandlers(dependencies);
    const request = authorizeRequest();

    const first = await handlers.authorize!.execute(request);
    const replay = await handlers.authorize!.execute(request);

    expect(first.statusCode).toBe(201);
    expect(first.result.status).toBe(
      ReviewRunAuthorizationResultStatus.Authorized,
    );
    expect(first.result.protocolLimitsCanonicalJson).toContain("maxWorkSlots");
    expect(JSON.parse(first.result.authorizationFactsCanonicalJson!)).toEqual(
      expect.objectContaining({
        pullRequestNumber: 42,
        baseSha: baseSha,
        mergeBaseSha: mergeBaseSha,
        headSha: headSha,
        reviewRevisionHash: facts.reviewRevisionHash,
        providerVoteLanes: [
          expect.objectContaining({
            providerKind: "codex",
            providerVoteIdentityHash: expect.any(String),
          }),
        ],
      }),
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.result.status).toBe(
      ReviewRunAuthorizationResultStatus.Restored,
    );
    expect(replay.result.authorizationId).toBe(first.result.authorizationId);
  });

  it("renews with a fresh same-run OIDC proof and canonical request hash", async () => {
    const handlers = createReviewActionV2RunControlHandlers(dependencies);
    const authorized = await handlers.authorize!.execute(authorizeRequest());
    const renew = await renewRequest(
      authorized.result.authorizationId!,
      authorized.result.authorizationToken!,
      dependencies,
    );

    const result = await handlers.renew!.execute(renew);

    expect(result.statusCode).toBe(200);
    expect(result.result.status).toBe(
      ReviewRunAuthorizationResultStatus.Renewed,
    );
    expect(result.result.authorizationId).toBe(
      authorized.result.authorizationId,
    );
  });

  it("rejects unknown producer releases", async () => {
    facts = { ...facts, producerReleaseId: "missing_release" };
    const handlers = createReviewActionV2RunControlHandlers(dependencies);

    await expect(
      handlers.authorize!.execute(authorizeRequest()),
    ).rejects.toMatchObject({
      statusCode: 404,
      errorCode: ReviewActionV2ProtocolErrorCode.NotFound,
      issues: ["producer_release_unavailable"],
    });
  });

  it("rejects non-managed trust domains", async () => {
    facts = { ...facts, trustDomain: ReviewTrustDomain.UntrustedContribution };
    const handlers = createReviewActionV2RunControlHandlers(dependencies);

    await expect(
      handlers.authorize!.execute(authorizeRequest()),
    ).rejects.toMatchObject({
      statusCode: 403,
      errorCode: ReviewActionV2ProtocolErrorCode.Forbidden,
      issues: ["trust_domain_not_enabled"],
    });
  });

  it("rejects repository claim drift", async () => {
    claimsByToken.set("oidc-authorize", {
      ...oidcClaims("authorize-jti"),
      repository: "attacker/example",
    });
    const handlers = createReviewActionV2RunControlHandlers(dependencies);

    await expect(
      handlers.authorize!.execute(authorizeRequest()),
    ).rejects.toMatchObject({
      statusCode: 403,
      errorCode: ReviewActionV2ProtocolErrorCode.Forbidden,
      issues: ["repository_identity_mismatch"],
    });
  });

  it("rejects a non-canonical review revision hash", async () => {
    facts = { ...facts, reviewRevisionHash: hash("9") };
    const handlers = createReviewActionV2RunControlHandlers(dependencies);

    await expect(
      handlers.authorize!.execute(authorizeRequest()),
    ).rejects.toMatchObject({
      statusCode: 412,
      errorCode: ReviewActionV2ProtocolErrorCode.StalePrecondition,
      issues: ["review_revision_hash_mismatch"],
    });
  });

  it("rejects a release profile above the server-owned absolute maxima", async () => {
    dependencies = {
      ...dependencies,
      absoluteProtocolMaxima: {
        ...dependencies.absoluteProtocolMaxima,
        maxWorkSlots: 1,
      },
    };
    const handlers = createReviewActionV2RunControlHandlers(dependencies);

    await expect(
      handlers.authorize!.execute(authorizeRequest()),
    ).rejects.toMatchObject({
      statusCode: 422,
      errorCode: ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issues: ["protocol_limit_invalid:max_work_slots"],
    });
  });

  it("maps a conflicting replay to idempotency conflict", async () => {
    const handlers = createReviewActionV2RunControlHandlers(dependencies);
    await handlers.authorize!.execute(authorizeRequest());
    const conflicting: ReviewRunAuthorizeRequest = {
      ...authorizeRequest(),
      supportedProtocols: [
        ...authorizeRequest().supportedProtocols,
        { protocolVersion: "3", schemaDigest: hash("8") },
      ],
    };

    await expect(
      handlers.authorize!.execute(conflicting),
    ).rejects.toMatchObject({
      statusCode: 409,
      errorCode: ReviewActionV2ProtocolErrorCode.IdempotencyConflict,
    });
  });

  it("rejects renewal after authorization expiry before fresh OIDC work", async () => {
    const handlers = createReviewActionV2RunControlHandlers(dependencies);
    const authorized = await handlers.authorize!.execute(authorizeRequest());
    const renew = await renewRequest(
      authorized.result.authorizationId!,
      authorized.result.authorizationToken!,
      dependencies,
    );
    await kit.control.authorizations.expireOrRevokeReviewRunAuthorization({
      authorizationId: authorized.result.authorizationId!,
      state: ReviewRunAuthorizationState.Expired,
    });

    await expect(handlers.renew!.execute(renew)).rejects.toMatchObject({
      statusCode: 410,
      errorCode: ReviewActionV2ProtocolErrorCode.ResourceGone,
      issues: ["authorization_expired"],
    });
  });
});

function oidcClaims(jti: string): GitHubActionsOidcClaims {
  return {
    iss: githubActionsOidcIssuer,
    aud: defaultActionOidcAudience,
    sub: "repo:777genius/example:pull_request",
    repository: "777genius/example",
    repository_id: "123456",
    repository_owner: "777genius",
    event_name: "pull_request",
    run_id: "1001",
    run_attempt: "1",
    workflow_ref:
      "777genius/example/.github/workflows/reviewrouter.yml@refs/pull/42/merge",
    workflow_sha: headSha,
    job_workflow_ref: `777genius/review-router/.github/workflows/reviewrouter-reusable.yml@${actionSha}`,
    job_workflow_sha: actionSha,
    actor: "777genius",
    jti,
    exp: Math.floor(new Date("2026-07-22T13:00:00.000Z").getTime() / 1_000),
  };
}

function authorizeRequest(): ReviewRunAuthorizeRequest {
  return {
    ...reviewActionV2GoldenFixtures.review_run_authorize.request,
    oidcToken: "oidc-authorize",
  };
}

async function renewRequest(
  authorizationId: string,
  authorizationToken: string,
  dependencies: ReviewActionV2RunControlHandlerDependencies,
): Promise<ReviewRunRenewRequest> {
  const request: ReviewRunRenewRequest = {
    ...reviewActionV2GoldenFixtures.review_run_renew.request,
    authorizationId,
    authorizationToken,
    oidcToken: "oidc-renew",
    requestedTtlMs: 20 * 60_000,
  };
  return {
    ...request,
    requestBodyHash: await dependencies.digest.digestUtf8(
      canonicalizeReviewActionV2Request(
        ReviewActionV2OperationId.ReviewRunRenew,
        request,
      ),
    ),
  };
}
