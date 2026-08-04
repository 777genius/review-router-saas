import type { FastifyInstance, FastifyReply } from "fastify";
import {
  InvestigationEvaluationAttestationVersion,
  InvestigationEvaluationImportError,
  InvestigationEvaluationImportErrorCode,
  InvestigationEvaluationImportStatus,
  InvestigationEvaluationSignatureAlgorithm,
  InvestigationLegacyComparison,
  InvestigationPromotionPolicyError,
  InvestigationPromotionTrustError,
  type ImportSignedInvestigationEvaluationResult,
  type ImmutableInvestigationPromotionReport,
  type InvestigationOperatorStatus,
  type InvestigationPromotionProfileIdentity,
  type SignedInvestigationEvaluationAttestation,
} from "@reviewrouter/features-review-investigation-operations";
import { z } from "zod";

export enum ReviewInvestigationOperatorOperation {
  ReadStatus = "read_investigation_status",
  GeneratePromotionReport = "generate_investigation_promotion_report",
  ImportEvaluation = "import_investigation_evaluation",
}

export enum ReviewInvestigationPromotionRequestVersion {
  V3 = "review-investigation-promotion-request.v3",
}

export interface ReviewInvestigationOperatorAuthorizationPort {
  authenticate(input: {
    readonly credential: string;
    readonly operation: ReviewInvestigationOperatorOperation;
  }): Promise<boolean>;
}

export interface ReviewInvestigationOperatorStatusPort {
  execute(investigationId: string): Promise<InvestigationOperatorStatus | null>;
}

export interface ReviewInvestigationPromotionReportPort {
  execute(input: {
    readonly producerReleaseId: string;
    readonly profile: InvestigationPromotionProfileIdentity;
  }): Promise<ImmutableInvestigationPromotionReport>;
}

export interface ReviewInvestigationEvaluationImportPort {
  execute(
    input: SignedInvestigationEvaluationAttestation,
  ): Promise<ImportSignedInvestigationEvaluationResult>;
}

export type RegisterReviewInvestigationOperatorRoutesDependencies = Readonly<{
  authorization: ReviewInvestigationOperatorAuthorizationPort;
  status: ReviewInvestigationOperatorStatusPort;
  promotionReports?: ReviewInvestigationPromotionReportPort;
  evaluationImports?: ReviewInvestigationEvaluationImportPort;
}>;

const statusParamsSchema = z.strictObject({
  investigationId: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
});

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().min(20).max(32);
const promotionReportBodySchema = z.strictObject({
  requestVersion: z.literal(ReviewInvestigationPromotionRequestVersion.V3),
  producerReleaseId: identifierSchema,
  profile: z.strictObject({
    id: identifierSchema,
    version: identifierSchema,
  }),
});
const evaluationBodySchema = z.strictObject({
  payload: z.strictObject({
    attestationVersion: z.literal(InvestigationEvaluationAttestationVersion.V1),
    attestationId: identifierSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    subject: z.strictObject({
      terminalSampleId: identifierSchema,
      terminalSamplePayloadHash: digestSchema,
      investigationId: identifierSchema,
      certificateId: identifierSchema,
      certificateHash: digestSchema,
      producerReleaseId: identifierSchema,
      repositoryScopeHash: digestSchema,
      reviewRevisionHash: digestSchema,
      stableReviewUnitHash: digestSchema,
    }),
    corpus: z.strictObject({
      version: identifierSchema,
      groundTruthSetHash: digestSchema,
    }),
    evaluationPolicyVersion: identifierSchema,
    facts: z.strictObject({
      groundTruth: z.strictObject({
        expectedDefectCount: z.number().int().nonnegative(),
        detectedDefectCount: z.number().int().nonnegative(),
        detectedDefectSetHash: digestSchema,
      }),
      security: z.strictObject({
        evaluationHash: digestSchema,
        violationCount: z.number().int().nonnegative(),
      }),
      legacy: z.strictObject({
        resultHash: digestSchema,
        comparison: z.enum([
          InvestigationLegacyComparison.Agree,
          InvestigationLegacyComparison.InvestigationImproved,
          InvestigationLegacyComparison.LegacyImproved,
          InvestigationLegacyComparison.UnexplainedDisagreement,
        ]),
      }),
    }),
  }),
  signature: z.strictObject({
    algorithm: z.literal(InvestigationEvaluationSignatureAlgorithm.Ed25519),
    keyId: identifierSchema,
    value: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
  }),
});

export async function registerReviewInvestigationOperatorRoutes(
  app: FastifyInstance,
  dependencies: RegisterReviewInvestigationOperatorRoutesDependencies,
): Promise<void> {
  app.get(
    "/api/operator/v1/review-investigations/:investigationId/status",
    async (request, reply) => {
      if (
        !(await authenticate(
          request.headers.authorization,
          ReviewInvestigationOperatorOperation.ReadStatus,
          dependencies,
          reply,
        ))
      ) {
        return;
      }
      const params = statusParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendOperatorError(reply, 400, "invalid_request");
      }
      try {
        const result = await dependencies.status.execute(
          params.data.investigationId,
        );
        if (result === null) {
          return sendOperatorError(reply, 404, "investigation_not_found");
        }
        return reply
          .header("Cache-Control", "no-store")
          .code(200)
          .send({ result });
      } catch {
        return sendOperatorError(reply, 503, "operations_unavailable");
      }
    },
  );

  const promotionReports = dependencies.promotionReports;
  if (promotionReports) {
    app.post(
      "/api/operator/v1/review-investigation-promotion-reports",
      { bodyLimit: 16_384 },
      async (request, reply) => {
        if (
          !(await authenticate(
            request.headers.authorization,
            ReviewInvestigationOperatorOperation.GeneratePromotionReport,
            dependencies,
            reply,
          ))
        ) {
          return;
        }
        if (
          !request.body ||
          typeof request.body !== "object" ||
          !("requestVersion" in request.body) ||
          request.body.requestVersion !==
            ReviewInvestigationPromotionRequestVersion.V3
        ) {
          return sendOperatorError(
            reply,
            400,
            "promotion_request_version_unsupported",
          );
        }
        const body = promotionReportBodySchema.safeParse(request.body);
        if (!body.success) {
          return sendOperatorError(reply, 400, "invalid_request");
        }
        try {
          const { requestVersion, ...promotionInput } = body.data;
          void requestVersion;
          const report = await promotionReports.execute(promotionInput);
          return reply
            .header("Cache-Control", "no-store")
            .code(201)
            .send({
              result: {
                reportHash: report.reportHash,
                body: report.body,
              },
            });
        } catch (error) {
          if (
            error instanceof InvestigationPromotionTrustError ||
            error instanceof InvestigationPromotionPolicyError
          ) {
            return sendOperatorError(reply, 422, "promotion_evidence_rejected");
          }
          return sendOperatorError(reply, 503, "operations_unavailable");
        }
      },
    );
  }

  const evaluationImports = dependencies.evaluationImports;
  if (evaluationImports) {
    app.post(
      "/api/operator/v1/review-investigation-evaluations",
      { bodyLimit: 16_384 },
      async (request, reply) => {
        if (
          !(await authenticate(
            request.headers.authorization,
            ReviewInvestigationOperatorOperation.ImportEvaluation,
            dependencies,
            reply,
          ))
        ) {
          return;
        }
        const body = evaluationBodySchema.safeParse(request.body);
        if (!body.success) {
          return sendOperatorError(reply, 400, "invalid_request");
        }
        try {
          const result = await evaluationImports.execute(body.data);
          return reply
            .header("Cache-Control", "no-store")
            .code(
              result.status === InvestigationEvaluationImportStatus.Imported
                ? 201
                : 200,
            )
            .send({ result });
        } catch (error) {
          if (error instanceof InvestigationEvaluationImportError) {
            if (
              error.code === InvestigationEvaluationImportErrorCode.Conflict
            ) {
              return sendOperatorError(reply, 409, "evaluation_conflict");
            }
            return sendOperatorError(
              reply,
              422,
              "evaluation_attestation_rejected",
            );
          }
          return sendOperatorError(reply, 503, "operations_unavailable");
        }
      },
    );
  }
}

async function authenticate(
  authorization: string | undefined,
  operation: ReviewInvestigationOperatorOperation,
  dependencies: RegisterReviewInvestigationOperatorRoutesDependencies,
  reply: FastifyReply,
): Promise<boolean> {
  try {
    const authorized = await dependencies.authorization.authenticate({
      credential: readBearerCredential(authorization),
      operation,
    });
    if (authorized) return true;
    sendOperatorError(reply, 401, "unauthorized");
    return false;
  } catch {
    sendOperatorError(reply, 503, "operations_unavailable");
    return false;
  }
}

function readBearerCredential(authorization: string | undefined): string {
  if (!authorization || authorization.length > 8_200) return "";
  return authorization.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
}

function sendOperatorError(
  reply: FastifyReply,
  statusCode: 400 | 401 | 404 | 409 | 422 | 503,
  code: string,
) {
  return reply
    .header("Cache-Control", "no-store")
    .code(statusCode)
    .send({ error: { code } });
}
