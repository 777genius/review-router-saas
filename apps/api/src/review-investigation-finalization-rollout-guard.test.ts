import { describe, expect, it, vi } from "vitest";
import {
  ProviderExecutionProfile,
  ReviewProviderKind,
  ReviewTrustDomain,
} from "@reviewrouter/features-review-evidence";
import { ReviewInvestigationConclusion } from "@reviewrouter/features-review-investigations";
import { InvestigationRolloutCapability } from "@reviewrouter/features-review-investigation-operations";
import {
  ProductionReviewInvestigationFinalizationRolloutGuard,
  type ReviewInvestigationFinalizationRolloutGuardPort,
} from "./review-investigation-finalization-rollout-guard.js";

describe("production investigation finalization rollout guard", () => {
  it("keeps legacy observations independent from investigation flags", async () => {
    const fixture = createFixture(null);

    await expect(fixture.assertAllowed()).resolves.toBeUndefined();
    expect(fixture.rollout).not.toHaveBeenCalled();
    expect(fixture.investigationReads()).toBe(0);
  });

  it("ignores attached shadow evidence that did not enter the authoritative projection", async () => {
    const fixture = createFixture(null, { attachUnusedShadow: true });

    await expect(fixture.assertAllowed()).resolves.toBeUndefined();
    expect(fixture.rollout).not.toHaveBeenCalled();
    expect(fixture.investigationReads()).toBe(0);
  });

  it("preserves legacy clean finalization with only legacy observations", async () => {
    const fixture = createFixture(null, { legacyZeroLineage: true });

    await expect(fixture.assertAllowed()).resolves.toBeUndefined();
    expect(fixture.rollout).not.toHaveBeenCalled();
    expect(fixture.investigationReads()).toBe(0);
  });

  it("fails closed when legacy clean has an attached investigation observation", async () => {
    const fixture = createFixture(null, {
      legacyZeroLineage: true,
      attachUnusedShadow: true,
    });

    await expect(fixture.assertAllowed()).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(fixture.rollout).not.toHaveBeenCalled();
    expect(fixture.investigationReads()).toBe(0);
  });

  it("requires production effects for investigation findings", async () => {
    const fixture = createFixture(ReviewInvestigationConclusion.Findings);

    await expect(fixture.assertAllowed()).resolves.toBeUndefined();
    expect(
      fixture.rollout.mock.calls.map(([input]) => input.capability),
    ).toEqual([InvestigationRolloutCapability.ProductionEffects]);
  });

  it("requires the independent verified-clean gate", async () => {
    const fixture = createFixture(ReviewInvestigationConclusion.VerifiedClean);

    await expect(fixture.assertAllowed()).resolves.toBeUndefined();
    expect(
      fixture.rollout.mock.calls.map(([input]) => input.capability),
    ).toEqual([
      InvestigationRolloutCapability.ProductionEffects,
      InvestigationRolloutCapability.VerifiedClean,
    ]);
  });

  it("fails closed before policy evaluation for mismatched immutable evidence", async () => {
    const fixture = createFixture(ReviewInvestigationConclusion.Findings, {
      observationCertificateHash: digest("9"),
    });

    await expect(fixture.assertAllowed()).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(fixture.rollout).not.toHaveBeenCalled();
  });

  it("fails closed for an unsupported investigation provider", async () => {
    const fixture = createFixture(ReviewInvestigationConclusion.Findings, {
      providerKind: ReviewProviderKind.Unknown,
    });

    await expect(fixture.assertAllowed()).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(fixture.rollout).not.toHaveBeenCalled();
  });
});

function createFixture(
  conclusion: ReviewInvestigationConclusion | null,
  overrides: {
    readonly observationCertificateHash?: string;
    readonly providerKind?: ReviewProviderKind;
    readonly attachUnusedShadow?: boolean;
    readonly legacyZeroLineage?: boolean;
  } = {},
) {
  const certificateId = conclusion === null ? null : "certificate-1";
  const certificateHash = conclusion === null ? null : digest("7");
  const authorization = {
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-1",
    scmRepositoryIdentityId: "scm-repository-1",
    pullRequestNumber: 42,
    trustDomain: ReviewTrustDomain.TrustedManaged,
    baseSha: commit("a"),
    mergeBaseSha: commit("b"),
    headSha: commit("c"),
    reviewRevisionHash: digest("1"),
    producerReleaseId: "release-1",
  };
  const observation = {
    scope: {
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
      authorizationScopeHash: digest("2"),
    },
    sourceRevision: {
      baseSha: authorization.baseSha,
      mergeBaseSha: authorization.mergeBaseSha,
      headSha: authorization.headSha,
      reviewRevisionHash: authorization.reviewRevisionHash,
    },
    providerKind: overrides.providerKind ?? ReviewProviderKind.Codex,
    producerReleaseId: authorization.producerReleaseId,
    executionProfile:
      conclusion === null
        ? ProviderExecutionProfile.PromptOnlyEnvelopeV1
        : ProviderExecutionProfile.InvestigationGatewayV1,
    investigationCertificateId: certificateId,
    investigationCertificateHash:
      conclusion === null
        ? null
        : (overrides.observationCertificateHash ?? certificateHash),
    trustDomain: authorization.trustDomain,
  };
  const investigation =
    conclusion === null
      ? null
      : {
          scope: {
            ...observation.scope,
            trustDomain: authorization.trustDomain,
          },
          revision: observation.sourceRevision,
          certificate: {
            certificateId,
            certificateHash,
            producerReleaseId: authorization.producerReleaseId,
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
    ["observation-1", observation],
    ["shadow-observation-unused", shadowObservation],
  ]);
  let investigationReadCount = 0;
  const rollout = vi.fn().mockResolvedValue(undefined);
  const guard = new ProductionReviewInvestigationFinalizationRolloutGuard({
    observations: {
      findById: vi
        .fn()
        .mockImplementation(async (observationId: string) =>
          observations.get(observationId),
        ),
    } as never,
    investigations: {
      findByCertificateId: vi.fn().mockImplementation(async () => {
        investigationReadCount += 1;
        return investigation;
      }),
    } as never,
    rollout: { assertAllowed: rollout },
  });
  return {
    rollout,
    investigationReads: () => investigationReadCount,
    assertAllowed: () =>
      guard.assertAllowed({
        authorization: authorization as never,
        observationRefs: [
          { observationId: "observation-1" },
          ...(overrides.attachUnusedShadow
            ? [{ observationId: "shadow-observation-unused" }]
            : []),
        ] as never,
        projectionEnvelope: overrides.legacyZeroLineage
          ? { occurrences: [] }
          : {
              authoritativeObservationIds: ["observation-1"],
              occurrences: [],
            },
      }),
  } satisfies Readonly<{
    rollout: typeof rollout;
    investigationReads: () => number;
    assertAllowed: () => ReturnType<
      ReviewInvestigationFinalizationRolloutGuardPort["assertAllowed"]
    >;
  }>;
}

function commit(character: string): string {
  return character.repeat(40);
}

function digest(character: string): string {
  return character.repeat(64);
}
