import Fastify from "fastify";
import {
  InvestigationCompatibilityStatus,
  InvestigationEvaluationSignatureAlgorithm,
  InvestigationEvaluationImportError,
  InvestigationEvaluationImportErrorCode,
  InvestigationEvaluationImportStatus,
  InvestigationOperatorConclusion,
  InvestigationOperatorNextAction,
  InvestigationOperatorState,
  InvestigationPromotionDecision,
  InvestigationPromotionEvidenceFreshnessPolicy,
  InvestigationPromotionReportVersion,
  InvestigationPromotionSigningKeyPolicy,
  InvestigationPromotionTrustError,
  InvestigationPromotionTrustErrorCode,
  InvestigationPromotionTrustProfileVersion,
} from "@reviewrouter/features-review-investigation-operations";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerReviewInvestigationOperatorRoutes,
  ReviewInvestigationOperatorOperation,
  ReviewInvestigationPromotionRequestVersion,
  type RegisterReviewInvestigationOperatorRoutesDependencies,
} from "./review-investigation-operator-routes.js";

const credential = "investigation-operator-credential-with-32-characters";
const promotionCredential = "promotion-credential-with-at-least-32-chars";
const importCredential = "evaluation-import-credential-with-32-chars";
const digest = "a".repeat(64);
const profile = { id: "production", version: "2026-08.v1" } as const;
const trustProfile = {
  profileVersion: InvestigationPromotionTrustProfileVersion.V1,
  corpusVersion: "corpus.v1",
  groundTruthSetHash: digest,
  evaluationPolicyVersion: "evaluation-policy.v1",
  freshness: {
    policy:
      InvestigationPromotionEvidenceFreshnessPolicy.IssuedAtOrAfterAndUnexpired,
    issuedAtOrAfter: "2026-08-03T00:00:00.000Z",
  },
  signingKeys: {
    policy: InvestigationPromotionSigningKeyPolicy.ApprovedLineageAllowlist,
    lineageId: "evaluation-lineage",
    policyVersion: "evaluation-lineage-policy.v1",
    signatureAlgorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
    acceptedKeyIds: ["evaluation-key-current"],
  },
} as const;
const thresholds = {
  minSeededSamples: 4,
  minShadowSamples: 8,
  maxUnexplainedDisagreements: 0,
  maxP95TotalTokens: 20_000,
  maxP95DurationMs: 120_000,
} as const;
const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function dependencies(): RegisterReviewInvestigationOperatorRoutesDependencies {
  return {
    authorization: {
      async authenticate(input) {
        return input.credential === credential;
      },
    },
    status: {
      async execute(investigationId) {
        return investigationId === "investigation-1"
          ? {
              investigationId,
              repositoryScopeHash: digest,
              reviewRevisionHash: digest,
              state: InvestigationOperatorState.AwaitingCritic,
              version: 7,
              openObligationCount: 1,
              satisfiedObligationCount: 4,
              unresolvableObligationCount: 0,
              nextAction: InvestigationOperatorNextAction.RunCritic,
              capacityEligibleAt: null,
              lastFailureCode: null,
              conclusion: InvestigationOperatorConclusion.None,
              compatibility: InvestigationCompatibilityStatus.Compatible,
              producerReleaseId: "release-1",
              protocolVersion: "2",
              gatewayPolicyVersion: "context-gateway.v4",
              updatedAt: "2026-08-03T12:00:00.000Z",
            }
          : null;
      },
    },
    promotionReports: {
      async execute(input) {
        return {
          reportHash: digest,
          canonicalJson: "stored-internally-only",
          body: {
            reportVersion: InvestigationPromotionReportVersion.V3,
            generatedAt: "2026-08-03T12:00:00.000Z",
            producerReleaseId: input.producerReleaseId,
            profile: input.profile,
            trustProfile,
            sampleSetHash: digest,
            thresholds,
            metrics: {
              totalSamples: 0,
              fullyEvaluatedSamples: 0,
              terminalOperationalSamples: 0,
              incompleteSamples: 0,
              seededSamples: 0,
              shadowSamples: 0,
              allowlistedSamples: 0,
              observedFindingCount: 0,
              expectedDefects: 0,
              detectedDefects: 0,
              falseCleanCount: 0,
              unexplainedDisagreementCount: 0,
              securityViolationCount: 0,
              replayHitCount: 0,
              p50TotalTokens: 0,
              p95TotalTokens: 0,
              p50DurationMs: 0,
              p95DurationMs: 0,
              p95CapacityWaitMs: 0,
            },
            decision: InvestigationPromotionDecision.Blocked,
            blockers: [],
          },
        };
      },
    },
  };
}

async function createApp(
  input: RegisterReviewInvestigationOperatorRoutesDependencies = dependencies(),
) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await registerReviewInvestigationOperatorRoutes(app, input);
  return app;
}

describe("review investigation operator routes", () => {
  it("requires authorization and returns a sanitized no-store status", async () => {
    const app = await createApp();
    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/operator/v1/review-investigations/investigation-1/status",
    });
    const authorized = await app.inject({
      method: "GET",
      url: "/api/operator/v1/review-investigations/investigation-1/status",
      headers: { authorization: `Bearer ${credential}` },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ error: { code: "unauthorized" } });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers["cache-control"]).toBe("no-store");
    expect(authorized.json().result).toMatchObject({
      investigationId: "investigation-1",
      state: "awaiting_critic",
      nextAction: "run_critic",
    });
    expect(JSON.stringify(authorized.json())).not.toMatch(
      /prompt|query|secret|canonicalJson/iu,
    );
  });

  it("generates an immutable report without returning stored canonical data", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/operator/v1/review-investigation-promotion-reports",
      headers: { authorization: `Bearer ${credential}` },
      payload: promotionRequest(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      result: {
        reportHash: digest,
        body: {
          producerReleaseId: "release-1",
          decision: "blocked",
        },
      },
    });
    expect(response.body).not.toContain("stored-internally-only");
    expect(response.body).not.toContain("canonicalJson");
  });

  it("rejects legacy promotion input with an explicit version error", async () => {
    const input = dependencies();
    const execute = vi.fn(input.promotionReports!.execute);
    const app = await createApp({
      ...input,
      promotionReports: { execute },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/operator/v1/review-investigation-promotion-reports",
      headers: { authorization: `Bearer ${credential}` },
      payload: {
        producerReleaseId: "release-1",
        profile,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "promotion_request_version_unsupported" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an old caller-asserted signing lineage",
      {
        trustProfile: {
          ...trustProfile,
          signingKeys: {
            ...trustProfile.signingKeys,
            lineageId: "retired-lineage",
            acceptedKeyIds: ["retired-key"],
          },
        },
      },
    ],
    [
      "caller-weakened thresholds",
      {
        thresholds: {
          ...thresholds,
          minSeededSamples: 1,
          minShadowSamples: 1,
        },
      },
    ],
  ])("rejects %s at the operator boundary", async (_label, attack) => {
    const input = dependencies();
    const execute = vi.fn(input.promotionReports!.execute);
    const app = await createApp({
      ...input,
      promotionReports: { execute },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/operator/v1/review-investigation-promotion-reports",
      headers: { authorization: `Bearer ${credential}` },
      payload: {
        ...promotionRequest(),
        ...attack,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: "invalid_request" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("maps promotion trust failures to a fixed fail-closed response", async () => {
    const input = dependencies();
    const app = await createApp({
      ...input,
      promotionReports: {
        execute: vi
          .fn()
          .mockRejectedValue(
            new InvestigationPromotionTrustError(
              InvestigationPromotionTrustErrorCode.EvaluationTrustMismatch,
            ),
          ),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/operator/v1/review-investigation-promotion-reports",
      headers: { authorization: `Bearer ${credential}` },
      payload: promotionRequest(),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: { code: "promotion_evidence_rejected" },
    });
  });

  it("returns only a fixed error when an operation dependency fails", async () => {
    const input = dependencies();
    const app = await createApp({
      ...input,
      status: {
        execute: vi.fn().mockRejectedValue(new Error("private query")),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/operator/v1/review-investigations/investigation-1/status",
      headers: { authorization: `Bearer ${credential}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: { code: "operations_unavailable" },
    });
    expect(response.body).not.toContain("private query");
  });

  it("does not authorize promotion with an evaluation import credential", async () => {
    const input = dependencies();
    const promotionExecute = vi.fn(input.promotionReports!.execute);
    const importExecute = vi.fn().mockResolvedValue({
      status: InvestigationEvaluationImportStatus.Imported,
      attestationHash: digest,
      derivedSampleId: `evaluated-${digest}`,
    });
    const app = await createApp({
      ...input,
      authorization: {
        async authenticate(request) {
          if (
            request.operation ===
            ReviewInvestigationOperatorOperation.GeneratePromotionReport
          ) {
            return request.credential === promotionCredential;
          }
          if (
            request.operation ===
            ReviewInvestigationOperatorOperation.ImportEvaluation
          ) {
            return request.credential === importCredential;
          }
          return request.credential === credential;
        },
      },
      promotionReports: { execute: promotionExecute },
      evaluationImports: { execute: importExecute },
    });

    const promotion = await app.inject({
      method: "POST",
      url: "/api/operator/v1/review-investigation-promotion-reports",
      headers: { authorization: `Bearer ${importCredential}` },
      payload: promotionRequest(),
    });
    const evaluation = await app.inject({
      method: "POST",
      url: "/api/operator/v1/review-investigation-evaluations",
      headers: { authorization: `Bearer ${promotionCredential}` },
      payload: evaluationEnvelope(),
    });

    expect(promotion.statusCode).toBe(401);
    expect(evaluation.statusCode).toBe(401);
    expect(promotionExecute).not.toHaveBeenCalled();
    expect(importExecute).not.toHaveBeenCalled();
  });

  it("imports only an authenticated signed evaluation envelope", async () => {
    const input = dependencies();
    const execute = vi.fn().mockResolvedValue({
      status: InvestigationEvaluationImportStatus.Imported,
      attestationHash: digest,
      derivedSampleId: `evaluated-${digest}`,
    });
    const app = await createApp({ ...input, evaluationImports: { execute } });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/operator/v1/review-investigation-evaluations",
      payload: evaluationEnvelope(),
    });
    const imported = await app.inject({
      method: "POST",
      url: "/api/operator/v1/review-investigation-evaluations",
      headers: { authorization: `Bearer ${credential}` },
      payload: evaluationEnvelope(),
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(imported.statusCode).toBe(201);
    expect(imported.headers["cache-control"]).toBe("no-store");
    expect(imported.json()).toEqual({
      result: {
        status: "imported",
        attestationHash: digest,
        derivedSampleId: `evaluated-${digest}`,
      },
    });
    expect(execute).toHaveBeenCalledWith(evaluationEnvelope());
    expect(imported.body).not.toMatch(/canonical|signature|groundTruth/iu);
  });

  it("fails closed with fixed evaluation rejection and conflict responses", async () => {
    const input = dependencies();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        new InvestigationEvaluationImportError(
          InvestigationEvaluationImportErrorCode.InvalidSignature,
        ),
      )
      .mockRejectedValueOnce(
        new InvestigationEvaluationImportError(
          InvestigationEvaluationImportErrorCode.Conflict,
        ),
      );
    const app = await createApp({ ...input, evaluationImports: { execute } });
    const first = await app.inject({
      method: "POST",
      url: "/api/operator/v1/review-investigation-evaluations",
      headers: { authorization: `Bearer ${credential}` },
      payload: evaluationEnvelope(),
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/operator/v1/review-investigation-evaluations",
      headers: { authorization: `Bearer ${credential}` },
      payload: evaluationEnvelope(),
    });

    expect(first.statusCode).toBe(422);
    expect(first.json()).toEqual({
      error: { code: "evaluation_attestation_rejected" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      error: { code: "evaluation_conflict" },
    });
  });

  it("does not expose the evaluation endpoint without a configured verifier", async () => {
    const app = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/operator/v1/review-investigation-evaluations",
      headers: { authorization: `Bearer ${credential}` },
      payload: evaluationEnvelope(),
    });
    expect(response.statusCode).toBe(404);
  });
});

function promotionRequest() {
  return {
    requestVersion: ReviewInvestigationPromotionRequestVersion.V3,
    producerReleaseId: "release-1",
    profile,
  } as const;
}

function evaluationEnvelope() {
  return {
    payload: {
      attestationVersion: "review-investigation-evaluation.v1",
      attestationId: "evaluation-1",
      issuedAt: "2026-08-03T11:55:00.000Z",
      expiresAt: "2026-08-03T13:00:00.000Z",
      subject: {
        terminalSampleId: `terminal-${digest}`,
        terminalSamplePayloadHash: digest,
        investigationId: "investigation-1",
        certificateId: "certificate-1",
        certificateHash: digest,
        producerReleaseId: "release-1",
        repositoryScopeHash: digest,
        reviewRevisionHash: digest,
        stableReviewUnitHash: digest,
      },
      corpus: { version: "corpus.v1", groundTruthSetHash: digest },
      evaluationPolicyVersion: "evaluation-policy.v1",
      facts: {
        groundTruth: {
          expectedDefectCount: 1,
          detectedDefectCount: 1,
          detectedDefectSetHash: digest,
        },
        security: { evaluationHash: digest, violationCount: 0 },
        legacy: { resultHash: digest, comparison: "agree" },
      },
    },
    signature: {
      algorithm: "ed25519",
      keyId: "evaluation-key-1",
      value: "A".repeat(86),
    },
  };
}
