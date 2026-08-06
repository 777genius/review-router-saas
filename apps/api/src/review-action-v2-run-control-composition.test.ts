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
  reviewInvestigationCapabilityV1,
  type ReviewOperationalSloThresholds,
  type ReviewProtocolLimits,
} from "@reviewrouter/features-review-run-control";
import {
  createReviewRunControlTestKit,
  testAbsoluteProtocolMaxima,
  type ReviewRunControlTestKit,
} from "@reviewrouter/features-review-run-control/testing";
import {
  createReviewRequestedIntent,
  ReviewRequestAdmissionState,
  ReviewRequestedIntentState,
  ReviewRequestedTriggerKind,
  type ReviewRequestedIntent,
} from "@reviewrouter/features-review-executions";
import { InvestigationRolloutCapability } from "@reviewrouter/features-review-investigation-operations";
import {
  canonicalizeReviewActionV2Request,
  reviewActionV2GoldenFixtures,
  reviewActionV2PublishedSchemaDigest,
  reviewInvestigationExtensionV1,
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
      admissionFacts: {
        resolve: async () => {
          const release = await kit.store.findProducerReleaseById("release_v2");
          if (!release) throw new Error("test_release_missing");
          return { revision: facts, producerRelease: release };
        },
      },
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

    expect(resolved.revision).toMatchObject({
      pullRequestNumber: 42,
      producerReleaseId: "release_v2",
      producerActionCommitSha: actionSha,
      trustDomain: ReviewTrustDomain.TrustedManaged,
    });
    expect(resolved.producerRelease.producerReleaseId).toBe("release_v2");
    expect(revisionInputs).toEqual([
      expect.objectContaining({
        owner: "777genius",
        repo: "example",
        sourceRunId: "1001",
        pullRequestNumberHint: 42,
      }),
    ]);
  });

  it("uses the bound requested intent instead of workflow run PR associations", async () => {
    const release = await kit.store.findProducerReleaseById("release_v2");
    if (!release) throw new Error("test_release_missing");
    const revisionInputs: unknown[] = [];
    const requestedIntent: ReviewRequestedIntent = {
      ...createReviewRequestedIntent({
        workspaceId: "workspace_1",
        repositoryConnectionId: "repository_1",
        scmRepositoryIdentityId: "scm-identity-1",
        pullRequestNumber: facts.pullRequestNumber,
        requestId: "review-request-1",
        revision: {
          baseSha: facts.baseSha,
          mergeBaseSha: facts.mergeBaseSha,
          headSha: facts.headSha,
          reviewRevisionHash: facts.reviewRevisionHash,
        },
        triggerKind: ReviewRequestedTriggerKind.ManualCommand,
        deliveryIdentityHash: hash("7"),
        canonicalRequestHash: hash("8"),
        notBefore: new Date("2026-07-22T12:00:00.000Z"),
        createdAt: new Date("2026-07-22T12:00:00.000Z"),
        retainUntil: new Date("2026-08-22T12:00:00.000Z"),
      }),
      state: ReviewRequestedIntentState.AwaitingAuthorization,
      sourceRunId: "1001",
      sourceRunAttempt: "1",
      admission: {
        state: ReviewRequestAdmissionState.Admitted,
        changedLines: 150,
        maxChangedLines: 250_000,
        policySnapshotId: "hosted-review-size-v1:test",
        decisionHash: hash("9"),
        checkedAt: new Date("2026-07-22T12:00:01.000Z"),
      },
    };
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
      requestedIntents: {
        findByRepositorySourceRunIdentity: async (input) => {
          expect(input).toEqual({
            repositoryConnectionId: "repository_1",
            sourceRunId: "1001",
            sourceRunAttempt: "1",
          });
          return requestedIntent;
        },
      },
      requestedIntentRequired: true,
    });

    const resolved = await admissionFacts.resolve({
      claims: oidcClaims("bound-intent-jti"),
      repository: new TestActionRepositories().repository!,
      scmRepositoryIdentityId: "scm-identity-1",
    });

    expect(resolved.revision).toMatchObject({
      pullRequestNumber: facts.pullRequestNumber,
      reviewRevisionHash: facts.reviewRevisionHash,
    });
    expect(resolved.producerRelease.producerReleaseId).toBe("release_v2");
    expect(revisionInputs).toEqual([
      expect.objectContaining({
        sourceRunId: null,
        pullRequestNumberHint: facts.pullRequestNumber,
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
            "777genius/review-router/.github/workflows/reviewrouter-execution-reusable.yml@main",
        },
        repository: new TestActionRepositories().repository!,
        scmRepositoryIdentityId: "scm-identity-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      issues: ["producer_release_workflow_not_immutable"],
    });
  });

  it.each([
    "attacker/review-router/.github/workflows/reviewrouter-execution-reusable.yml",
    "777genius/review-router/.github/workflows/reviewrouter-reusable.yml",
    "777genius/review-router/.github/workflows/other.yml",
  ])(
    "rejects an immutable producer from the wrong workflow identity: %s",
    async (workflow) => {
      const admissionFacts = createServerOwnedReviewActionV2AdmissionFacts({
        revisionResolver: {
          resolve: async () => {
            throw new Error("revision_must_not_resolve");
          },
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
            ...oidcClaims(`wrong-workflow-${workflow}`),
            job_workflow_ref: `${workflow}@${actionSha}`,
          },
          repository: new TestActionRepositories().repository!,
          scmRepositoryIdentityId: "scm-identity-1",
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
        issues: ["producer_release_workflow_not_immutable"],
      });
    },
  );

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
    expect(replay.result.authorizationFactsCanonicalJson).toBe(
      first.result.authorizationFactsCanonicalJson,
    );
    expect(
      JSON.parse(first.result.authorizationFactsCanonicalJson!),
    ).not.toHaveProperty("reviewInvestigation");
    expect(
      await kit.digest.digestUtf8(
        first.result.authorizationFactsCanonicalJson!,
      ),
    ).toBe(
      await kit.digest.digestUtf8(
        replay.result.authorizationFactsCanonicalJson!,
      ),
    );
  });

  it("includes a compatible investigation capability in deterministic authorization facts", async () => {
    const investigationActionSha = "f".repeat(40);
    const protocolLimits =
      await kit.store.findProtocolLimitsProfileById("limits_v2");
    const operationalSlo =
      await kit.store.findOperationalSloProfileById("slo_v2");
    if (!protocolLimits || !operationalSlo) {
      throw new Error("test_release_profiles_missing");
    }
    const reviewInvestigationProfile = {
      capability: reviewInvestigationCapabilityV1,
      coverageProfileHash: hash("5"),
      policyHash: hash("6"),
    } as const;
    await kit.control.producerReleases.registerProducerRelease({
      candidate: {
        producerReleaseId: "release_investigation_v1",
        distributionKind: ProducerDistributionKind.PublicReusable,
        actionCommitSha: investigationActionSha,
        runtimeCommitSha: runtimeSha,
        wrapperEntrypointDigest: null,
        runtimeEntrypointDigest: hash("7"),
        contextGatewayPolicyVersion: "review-context-gateway.v1",
        contextGatewayEntrypointDigest: hash("8"),
        reviewInvestigationProfile,
        schemaDigest: reviewActionV2PublishedSchemaDigest,
        capabilityProfile: ReviewCapabilityProfile.ExactRevisionV2,
        protocolLimitsProfileId: "limits_v2",
        operationalSloProfileId: "slo_v2",
      },
      expectedProtocolLimitsDigest: protocolLimits.limitsDigest,
      expectedOperationalSloDigest: operationalSlo.sloDigest,
    });
    const producerRelease = await kit.store.findProducerReleaseById(
      "release_investigation_v1",
    );
    if (!producerRelease) throw new Error("test_investigation_release_missing");
    facts = {
      ...facts,
      producerReleaseId: producerRelease.producerReleaseId,
      producerActionCommitSha: investigationActionSha,
    };
    const descriptor = {
      ...reviewInvestigationProfile,
      authorizationDescriptorVersion: 3 as const,
      extensionCanonicalizerDigest:
        reviewInvestigationExtensionV1.canonicalizerDigest,
      extensionId: reviewInvestigationExtensionV1.extensionId,
      extensionSchemaDigest: reviewInvestigationExtensionV1.schemaDigest,
      providerCapabilities: [
        {
          providerKind: "codex" as const,
          capabilities: [InvestigationRolloutCapability.Recording],
        },
      ],
    };
    let capabilityResolutionCount = 0;
    const handlers = createReviewActionV2RunControlHandlers({
      ...dependencies,
      admissionFacts: {
        resolve: async () => ({ revision: facts, producerRelease }),
      },
      reviewInvestigationCapability: {
        resolve: async ({ producerRelease: resolvedRelease }) => {
          expect(resolvedRelease.reviewInvestigationProfile).toEqual(
            reviewInvestigationProfile,
          );
          capabilityResolutionCount += 1;
          return capabilityResolutionCount === 1
            ? descriptor
            : {
                ...descriptor,
                providerCapabilities: [
                  {
                    providerKind: "codex" as const,
                    capabilities: [
                      InvestigationRolloutCapability.Recording,
                      InvestigationRolloutCapability.Shadow,
                    ],
                  },
                ],
              };
        },
      },
    });

    const first = await handlers.authorize!.execute(authorizeRequest());
    const replay = await handlers.authorize!.execute(authorizeRequest());
    const canonicalFacts = first.result.authorizationFactsCanonicalJson!;

    expect(JSON.parse(canonicalFacts)).toMatchObject({
      producerReleaseId: "release_investigation_v1",
      reviewInvestigation: descriptor,
    });
    expect(canonicalFacts).toBe(canonicalJson(JSON.parse(canonicalFacts)));
    expect(replay.result.authorizationFactsCanonicalJson).toBe(canonicalFacts);
    expect(capabilityResolutionCount).toBe(2);
    expect(
      JSON.parse(replay.result.authorizationFactsCanonicalJson!)
        .reviewInvestigation,
    ).toEqual(descriptor);
    expect(await kit.digest.digestUtf8(canonicalFacts)).toBe(
      await kit.digest.digestUtf8(
        replay.result.authorizationFactsCanonicalJson!,
      ),
    );
  });

  it("restores a persisted legacy V2 investigation snapshot across deployment", async () => {
    const legacyDescriptor = {
      authorizationDescriptorVersion: 2,
      capability: reviewInvestigationCapabilityV1,
      coverageProfileHash: hash("5"),
      policyHash: hash("6"),
      providerCapabilities: [
        {
          providerKind: "codex",
          capabilities: [InvestigationRolloutCapability.Recording],
        },
      ],
    } as const;
    const currentDescriptor = {
      ...legacyDescriptor,
      authorizationDescriptorVersion: 3 as const,
      extensionCanonicalizerDigest:
        reviewInvestigationExtensionV1.canonicalizerDigest,
      extensionId: reviewInvestigationExtensionV1.extensionId,
      extensionSchemaDigest: reviewInvestigationExtensionV1.schemaDigest,
    };
    const persistedAuthorizations = dependencies.authorizations;
    const handlers = createReviewActionV2RunControlHandlers({
      ...dependencies,
      reviewInvestigationCapability: {
        resolve: async () => currentDescriptor,
      },
      authorizations: {
        authorizeReviewRun: async (input) => {
          const outcome =
            await persistedAuthorizations.authorizeReviewRun(input);
          return "authorization" in outcome
            ? {
                ...outcome,
                authorization: {
                  ...outcome.authorization,
                  reviewInvestigationAuthorizationDescriptorCanonicalJson:
                    canonicalJson(legacyDescriptor),
                },
              }
            : outcome;
        },
        renewReviewRunAuthorization: (input) =>
          persistedAuthorizations.renewReviewRunAuthorization(input),
        resolveReviewRunAuthorizationToken: (input) =>
          persistedAuthorizations.resolveReviewRunAuthorizationToken(input),
      },
    });

    const first = await handlers.authorize!.execute(authorizeRequest());
    const replay = await handlers.authorize!.execute(authorizeRequest());

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.result.status).toBe(
      ReviewRunAuthorizationResultStatus.Restored,
    );
    expect(
      JSON.parse(replay.result.authorizationFactsCanonicalJson!)
        .reviewInvestigation,
    ).toEqual(legacyDescriptor);
  });

  it("omits investigation capability when the resolver returns null", async () => {
    const handlers = createReviewActionV2RunControlHandlers({
      ...dependencies,
      reviewInvestigationCapability: { resolve: async () => null },
    });

    const result = await handlers.authorize!.execute(authorizeRequest());

    expect(
      JSON.parse(result.result.authorizationFactsCanonicalJson!),
    ).not.toHaveProperty("reviewInvestigation");
  });

  it("does not advertise investigation providers outside authorized vote lanes", async () => {
    const handlers = createReviewActionV2RunControlHandlers({
      ...dependencies,
      reviewInvestigationCapability: {
        resolve: async () => ({
          authorizationDescriptorVersion: 3,
          capability: reviewInvestigationCapabilityV1,
          coverageProfileHash: hash("5"),
          extensionCanonicalizerDigest:
            reviewInvestigationExtensionV1.canonicalizerDigest,
          extensionId: reviewInvestigationExtensionV1.extensionId,
          extensionSchemaDigest: reviewInvestigationExtensionV1.schemaDigest,
          policyHash: hash("6"),
          providerCapabilities: [
            {
              providerKind: "codex",
              capabilities: [InvestigationRolloutCapability.Recording],
            },
            {
              providerKind: "claude_code",
              capabilities: [InvestigationRolloutCapability.Recording],
            },
          ],
        }),
      },
    });

    const result = await handlers.authorize!.execute(authorizeRequest());

    expect(
      JSON.parse(result.result.authorizationFactsCanonicalJson!),
    ).not.toHaveProperty("reviewInvestigation");
  });

  it.each([
    {
      name: "unsorted capabilities",
      providerCapabilities: [
        {
          providerKind: "codex",
          capabilities: [
            InvestigationRolloutCapability.Recording,
            InvestigationRolloutCapability.ContextCritic,
            InvestigationRolloutCapability.Shadow,
          ],
        },
      ],
    },
    {
      name: "duplicate capabilities",
      providerCapabilities: [
        {
          providerKind: "codex",
          capabilities: [
            InvestigationRolloutCapability.Recording,
            InvestigationRolloutCapability.Recording,
          ],
        },
      ],
    },
    {
      name: "unknown capability",
      providerCapabilities: [
        {
          providerKind: "codex",
          capabilities: [InvestigationRolloutCapability.Recording, "future"],
        },
      ],
    },
    {
      name: "dependency gap",
      providerCapabilities: [
        {
          providerKind: "codex",
          capabilities: [
            InvestigationRolloutCapability.ContextCritic,
            InvestigationRolloutCapability.Recording,
          ],
        },
      ],
    },
    {
      name: "duplicate provider rows",
      providerCapabilities: [
        {
          providerKind: "codex",
          capabilities: [InvestigationRolloutCapability.Recording],
        },
        {
          providerKind: "codex",
          capabilities: [InvestigationRolloutCapability.Recording],
        },
      ],
    },
  ])(
    "omits a non-canonical V3 descriptor with $name",
    async ({ providerCapabilities }) => {
      const handlers = createReviewActionV2RunControlHandlers({
        ...dependencies,
        reviewInvestigationCapability: {
          resolve: async () =>
            ({
              authorizationDescriptorVersion: 3,
              capability: reviewInvestigationCapabilityV1,
              coverageProfileHash: hash("5"),
              extensionCanonicalizerDigest:
                reviewInvestigationExtensionV1.canonicalizerDigest,
              extensionId: reviewInvestigationExtensionV1.extensionId,
              extensionSchemaDigest:
                reviewInvestigationExtensionV1.schemaDigest,
              policyHash: hash("6"),
              providerCapabilities,
            }) as never,
        },
      });

      const result = await handlers.authorize!.execute(authorizeRequest());

      expect(
        JSON.parse(result.result.authorizationFactsCanonicalJson!),
      ).not.toHaveProperty("reviewInvestigation");
    },
  );

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
    const release = await kit.store.findProducerReleaseById("release_v2");
    if (!release) throw new Error("test_release_missing");
    const handlers = createReviewActionV2RunControlHandlers({
      ...dependencies,
      admissionFacts: {
        resolve: async () => ({
          revision: facts,
          producerRelease: { ...release, producerReleaseId: "missing_release" },
        }),
      },
    });

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
    job_workflow_ref: `777genius/review-router/.github/workflows/reviewrouter-execution-reusable.yml@${actionSha}`,
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
