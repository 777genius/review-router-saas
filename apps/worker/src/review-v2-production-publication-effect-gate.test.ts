import { describe, expect, it } from "vitest";
import {
  ProviderExecutionProfile,
  ReviewProviderKind,
  ReviewTrustDomain,
} from "@reviewrouter/features-review-evidence";
import { ReviewInvestigationConclusion } from "@reviewrouter/features-review-investigations";
import {
  InvestigationRolloutCapability,
  InvestigationRolloutDecision,
  InvestigationRolloutProvider,
  type InvestigationRolloutTarget,
} from "@reviewrouter/features-review-investigation-operations";
import type {
  ReviewPublicationOperation,
  ReviewPublicationPermitIdentity,
} from "@reviewrouter/features-review-publishing/v2";
import {
  createProductionReviewInvestigationPublicationEffectGate,
  type ProductionReviewInvestigationPublicationEffectGateDependencies,
} from "./review-v2-production-publication-effect-gate";
import {
  ReviewV2PublicationEffectGateDecision,
  ReviewV2ScmProvider,
} from "./review-v2-publication-ports";

describe("production review investigation publication effect gate", () => {
  it("leaves legacy publication outside investigation rollout", async () => {
    const fixture = createFixture(null);
    fixture.rollout.decisions = [InvestigationRolloutDecision.Unavailable];

    await expect(fixture.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Allowed,
    );

    expect(fixture.authorizationReads()).toBe(0);
    expect(fixture.investigationReads()).toBe(0);
    expect(fixture.rollout.calls).toEqual([]);
  });

  it("does not let an unused attached shadow observation gate legacy publication", async () => {
    const fixture = createFixture(null, { attachUnusedShadow: true });
    fixture.rollout.decisions = [InvestigationRolloutDecision.Unavailable];

    await expect(fixture.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Allowed,
    );
    expect(fixture.rollout.calls).toEqual([]);
  });

  it("preserves a legacy zero-lineage clean projection with only legacy observations", async () => {
    const fixture = createFixture(null, { legacyZeroLineage: true });

    await expect(fixture.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Allowed,
    );
    expect(fixture.investigationReads()).toBe(0);
    expect(fixture.rollout.calls).toEqual([]);
  });

  it("fails closed when legacy zero-lineage clean has attached investigation evidence", async () => {
    const fixture = createFixture(null, {
      legacyZeroLineage: true,
      attachUnusedShadow: true,
    });

    await expect(fixture.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Unavailable,
    );
    expect(fixture.investigationReads()).toBe(0);
    expect(fixture.rollout.calls).toEqual([]);
  });

  it("re-reads production effects policy for every investigation effect", async () => {
    const fixture = createFixture(ReviewInvestigationConclusion.Findings);
    fixture.rollout.decisions = [
      InvestigationRolloutDecision.Allowed,
      InvestigationRolloutDecision.EmergencyDisabled,
    ];

    await expect(fixture.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Allowed,
    );
    await expect(fixture.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Disabled,
    );

    expect(fixture.rollout.calls).toEqual([
      {
        capability: InvestigationRolloutCapability.ProductionEffects,
        target: rolloutTarget(),
      },
      {
        capability: InvestigationRolloutCapability.ProductionEffects,
        target: rolloutTarget(),
      },
    ]);
  });

  it("requires verified clean rollout in addition to production effects", async () => {
    const fixture = createFixture(ReviewInvestigationConclusion.VerifiedClean);
    fixture.rollout.decisions = [
      InvestigationRolloutDecision.Allowed,
      InvestigationRolloutDecision.OutsideCohort,
    ];

    await expect(fixture.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Disabled,
    );

    expect(fixture.rollout.calls.map((call) => call.capability)).toEqual([
      InvestigationRolloutCapability.ProductionEffects,
      InvestigationRolloutCapability.VerifiedClean,
    ]);
  });

  it("fails closed when rollout or immutable investigation evidence is unavailable", async () => {
    const unavailable = createFixture(ReviewInvestigationConclusion.Findings);
    unavailable.rollout.decisions = [InvestigationRolloutDecision.Unavailable];
    await expect(unavailable.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Unavailable,
    );

    const mismatched = createFixture(ReviewInvestigationConclusion.Findings, {
      certificateHash: digest("9"),
    });
    await expect(mismatched.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Unavailable,
    );
    expect(mismatched.rollout.calls).toEqual([]);
  });

  it("fails closed on malformed investigation and legacy observation shapes", async () => {
    const investigationWithoutCertificate = createFixture(null, {
      executionProfile: ProviderExecutionProfile.InvestigationGatewayV1,
    });
    await expect(investigationWithoutCertificate.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Unavailable,
    );

    const legacyWithCertificate = createFixture(
      ReviewInvestigationConclusion.Findings,
      {
        executionProfile: ProviderExecutionProfile.PromptOnlyEnvelopeV1,
      },
    );
    await expect(legacyWithCertificate.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Unavailable,
    );

    expect(investigationWithoutCertificate.rollout.calls).toEqual([]);
    expect(legacyWithCertificate.rollout.calls).toEqual([]);
  });

  it.each([ReviewProviderKind.OpenRouter, ReviewProviderKind.Unknown])(
    "rejects unsupported investigation provider %s before rollout policy",
    async (providerKind) => {
      const fixture = createFixture(ReviewInvestigationConclusion.Findings, {
        providerKind,
      });

      await expect(fixture.authorize()).resolves.toBe(
        ReviewV2PublicationEffectGateDecision.Disabled,
      );
      expect(fixture.rollout.calls).toEqual([]);
    },
  );

  it("fails closed when the execution no longer matches the publication permit", async () => {
    const fixture = createFixture(ReviewInvestigationConclusion.Findings, {
      executionId: "execution-mismatch",
    });

    await expect(fixture.authorize()).resolves.toBe(
      ReviewV2PublicationEffectGateDecision.Unavailable,
    );

    expect(fixture.authorizationReads()).toBe(0);
    expect(fixture.rollout.calls).toEqual([]);
  });
});

function createFixture(
  conclusion: ReviewInvestigationConclusion | null,
  input: {
    readonly certificateHash?: string;
    readonly executionId?: string;
    readonly executionProfile?: ProviderExecutionProfile;
    readonly attachUnusedShadow?: boolean;
    readonly providerKind?: ReviewProviderKind;
    readonly legacyZeroLineage?: boolean;
  } = {},
) {
  const permit = permitIdentity();
  const certificateId = conclusion === null ? null : "certificate-1";
  const certificateHash =
    conclusion === null ? null : (input.certificateHash ?? digest("7"));
  const observation = {
    observationId: "observation-1",
    scope: {
      workspaceId: permit.workspaceId,
      repositoryConnectionId: permit.repositoryConnectionId,
      scmRepositoryIdentityId: permit.scmRepositoryIdentityId,
      pullRequestNumber: permit.pullRequestNumber,
      authorizationScopeHash: digest("6"),
    },
    sourceRevision: {
      baseSha: commit("a"),
      mergeBaseSha: commit("b"),
      headSha: permit.reviewedHeadSha,
      reviewRevisionHash: permit.reviewRevisionHash,
    },
    providerKind: input.providerKind ?? ReviewProviderKind.Codex,
    producerReleaseId: permit.producerReleaseId,
    executionProfile:
      input.executionProfile ??
      (conclusion === null
        ? ProviderExecutionProfile.PromptOnlyEnvelopeV1
        : ProviderExecutionProfile.InvestigationGatewayV1),
    investigationCertificateId: certificateId,
    investigationCertificateHash: certificateHash,
    trustDomain: ReviewTrustDomain.TrustedManaged,
  };
  const investigation =
    conclusion === null
      ? null
      : {
          scope: {
            ...observation.scope,
            trustDomain: observation.trustDomain,
          },
          revision: observation.sourceRevision,
          certificate: {
            certificateId,
            certificateHash: digest("7"),
            producerReleaseId: permit.producerReleaseId,
            reviewRevisionHash: permit.reviewRevisionHash,
            conclusion,
          },
        };
  const shadowObservation = {
    ...observation,
    executionProfile: ProviderExecutionProfile.InvestigationGatewayV1,
    investigationCertificateId: "shadow-certificate-unused",
    investigationCertificateHash: digest("8"),
  };
  const observations = new Map([
    [observation.observationId, observation],
    ["shadow-observation-unused", shadowObservation],
  ]);
  const rollout = new MutableRollout();
  let authorizationReadCount = 0;
  let investigationReadCount = 0;
  const dependencies = {
    executions: {
      async findExecution() {
        return {
          execution: {
            executionId: input.executionId ?? permit.executionId,
            generation: permit.generation,
            authorizationId: permit.authorizationId,
            producerReleaseId: permit.producerReleaseId,
            workspaceId: permit.workspaceId,
            repositoryConnectionId: permit.repositoryConnectionId,
            scmRepositoryIdentityId: permit.scmRepositoryIdentityId,
            pullRequestNumber: permit.pullRequestNumber,
            revision: {
              headSha: permit.reviewedHeadSha,
              reviewRevisionHash: permit.reviewRevisionHash,
            },
          },
          observationRefs: [
            {
              observationId: observation.observationId,
            },
            ...(input.attachUnusedShadow
              ? [{ observationId: "shadow-observation-unused" }]
              : []),
          ],
          artifact: {
            projectionHash: permit.projectionHash,
            projectionEnvelopeJson: JSON.stringify(
              input.legacyZeroLineage
                ? { occurrences: [] }
                : {
                    authoritativeObservationIds: [observation.observationId],
                    occurrences: [],
                  },
            ),
          },
        };
      },
    },
    observations: {
      async findById(observationId: string) {
        return observations.get(observationId) ?? null;
      },
    },
    investigations: {
      async findByCertificateId() {
        investigationReadCount += 1;
        return investigation;
      },
    },
    authorizations: {
      async findReviewRunAuthorizationById() {
        authorizationReadCount += 1;
        return {
          authorizationId: permit.authorizationId,
          workspaceId: permit.workspaceId,
          repositoryConnectionId: permit.repositoryConnectionId,
          scmRepositoryIdentityId: permit.scmRepositoryIdentityId,
          pullRequestNumber: permit.pullRequestNumber,
          producerReleaseId: permit.producerReleaseId,
          trustDomain: ReviewTrustDomain.TrustedManaged,
        };
      },
    },
    rollout,
  } as unknown as ProductionReviewInvestigationPublicationEffectGateDependencies;
  const gate =
    createProductionReviewInvestigationPublicationEffectGate(dependencies);
  return {
    authorizationReads: () => authorizationReadCount,
    investigationReads: () => investigationReadCount,
    rollout,
    authorize: () =>
      gate.authorize({
        provider: ReviewV2ScmProvider.GitHub,
        permit,
        operation: {} as ReviewPublicationOperation,
      }),
  };
}

class MutableRollout {
  decisions: InvestigationRolloutDecision[] = [];
  readonly calls: Array<{
    readonly capability: InvestigationRolloutCapability;
    readonly target: InvestigationRolloutTarget;
  }> = [];

  async execute(input: {
    readonly capability: InvestigationRolloutCapability;
    readonly target: InvestigationRolloutTarget;
  }): Promise<InvestigationRolloutDecision> {
    this.calls.push(input);
    return this.decisions.shift() ?? InvestigationRolloutDecision.Allowed;
  }
}

function permitIdentity(): ReviewPublicationPermitIdentity {
  return {
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-1",
    scmRepositoryIdentityId: "scm-repository-1",
    pullRequestNumber: 42,
    executionId: "execution-1",
    generation: 1n,
    authorizationId: "authorization-1",
    producerReleaseId: "producer-release-1",
    reviewedHeadSha: commit("c"),
    reviewRevisionHash: digest("1"),
    projectionHash: digest("2"),
    lifecycleStateHash: digest("3"),
    commandLedgerWatermark: 1n,
    permitEpoch: 1n,
    publicationSafetyDecisionHash: digest("4"),
    publicationNotAfter: new Date("2026-08-03T12:00:00.000Z"),
  };
}

function rolloutTarget(): InvestigationRolloutTarget {
  return {
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-1",
    scmRepositoryIdentityId: "scm-repository-1",
    provider: InvestigationRolloutProvider.Codex,
    trustDomain: ReviewTrustDomain.TrustedManaged,
    producerReleaseId: "producer-release-1",
  };
}

function commit(character: string): string {
  return character.repeat(40);
}

function digest(character: string): string {
  return character.repeat(64);
}
