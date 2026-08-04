import { createHash } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type ReviewInvestigation,
} from "@prisma/client";
import {
  InvestigationPromotionTelemetryReadStatus,
  maximumInvestigationPromotionTelemetrySamples,
  type InvestigationEvaluationSignatureVerifierPort,
  type InvestigationOperatorStatusRepositoryPort,
  type InvestigationPromotionReportCommit,
  type InvestigationPromotionReportUnitOfWorkPort,
  type InvestigationPromotionTelemetryReadResult,
  type InvestigationTelemetryRepositoryPort,
} from "../../application/ports/operations-ports";
import {
  InvestigationTelemetryEvidenceCompleteness,
  isFullyEvaluatedTelemetrySample,
  type InvestigationTelemetrySample,
  type InvestigationTerminalOperationalTelemetrySample,
  validateTelemetrySample,
} from "../../domain/investigation-telemetry";
import {
  InvestigationCompatibilityStatus,
  InvestigationOperatorConclusion,
  InvestigationOperatorNextAction,
  InvestigationOperatorState,
  type InvestigationOperatorStatus,
} from "../../domain/operator-status";
import { canonicalInvestigationOperationsJson } from "../../domain/canonical-json";
import {
  InvestigationPromotionTrustError,
  InvestigationPromotionTrustErrorCode,
  assertInvestigationPromotionEvaluationEvidenceTrusted,
  assertInvestigationPromotionTrustProfileValidAt,
  normalizeInvestigationPromotionTrustProfile,
  parseStoredInvestigationPromotionEvaluationAttestation,
} from "../../domain/promotion-trust-profile";
import { withInvestigationPromotionReleaseLock } from "./prisma-investigation-promotion-lock";

type PromotionPersistence = Pick<
  Prisma.TransactionClient,
  | "reviewInvestigationTelemetrySample"
  | "reviewInvestigationEvaluationAttestation"
  | "reviewInvestigationPromotionReport"
>;

export class PrismaInvestigationOperations
  implements
    InvestigationTelemetryRepositoryPort,
    InvestigationOperatorStatusRepositoryPort,
    InvestigationPromotionReportUnitOfWorkPort
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly compatibility: {
      readonly currentProtocolVersion: string;
      readonly supportedGatewayPolicyVersions: ReadonlySet<string>;
      readonly acceptedProducerReleaseIds: ReadonlySet<string>;
    },
    private readonly promotionSignatures?: InvestigationEvaluationSignatureVerifierPort,
  ) {}

  async append(
    sample: InvestigationTerminalOperationalTelemetrySample,
  ): Promise<void> {
    validateTelemetrySample(sample);
    if (
      sample.evidenceCompleteness !==
      InvestigationTelemetryEvidenceCompleteness.TerminalOperational
    ) {
      throw new Error("telemetry_trusted_evaluation_required");
    }
    const payloadCanonicalJson = canonicalInvestigationOperationsJson(sample);
    const payloadHash = sha256(payloadCanonicalJson);
    try {
      await withInvestigationPromotionReleaseLock(
        this.prisma,
        sample.producerReleaseId,
        async (transaction) => {
          const existing =
            await transaction.reviewInvestigationTelemetrySample.findUnique({
              where: { sampleId: sample.sampleId },
              select: { payloadHash: true },
            });
          if (existing) {
            if (existing.payloadHash !== payloadHash) {
              throw new Error("telemetry_sample_id_conflict");
            }
            return;
          }
          await transaction.reviewInvestigationTelemetrySample.create({
            data: {
              sampleId: sample.sampleId,
              producerReleaseId: sample.producerReleaseId,
              source: sample.source,
              repositoryScopeHash: sample.repositoryScopeHash,
              reviewRevisionHash: sample.reviewRevisionHash,
              stableReviewUnitHash: sample.stableReviewUnitHash,
              payload: JSON.parse(
                payloadCanonicalJson,
              ) as Prisma.InputJsonValue,
              payloadHash,
              collectedAt: new Date(sample.collectedAt),
            },
          });
        },
      );
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      )
        throw error;
      const raced =
        await this.prisma.reviewInvestigationTelemetrySample.findUniqueOrThrow({
          where: { sampleId: sample.sampleId },
          select: { payloadHash: true },
        });
      if (raced.payloadHash !== payloadHash)
        throw new Error("telemetry_sample_id_conflict", { cause: error });
    }
  }

  async readPromotionSampleSet(
    input: Parameters<
      InvestigationTelemetryRepositoryPort["readPromotionSampleSet"]
    >[0],
  ): Promise<InvestigationPromotionTelemetryReadResult> {
    return readPromotionSampleSet(this.prisma, this.promotionSignatures, input);
  }

  async withPromotionSnapshot<Result>(
    input: Parameters<
      InvestigationTelemetryRepositoryPort["readPromotionSampleSet"]
    >[0],
    build: (
      telemetry: InvestigationPromotionTelemetryReadResult,
    ) => Promise<InvestigationPromotionReportCommit<Result>>,
  ): Promise<Result> {
    return withInvestigationPromotionReleaseLock(
      this.prisma,
      input.producerReleaseId,
      async (transaction) => {
        const telemetry = await readPromotionSampleSet(
          transaction,
          this.promotionSignatures,
          input,
        );
        const commit = await build(telemetry);
        await savePromotionReport(transaction, commit, input.producerReleaseId);
        return commit.result;
      },
    );
  }

  async find(
    investigationId: string,
  ): Promise<InvestigationOperatorStatus | null> {
    const investigation = await this.prisma.reviewInvestigation.findUnique({
      where: { investigationId },
    });
    if (!investigation) return null;
    const [obligations, lastAbortedTurn, activeTurn] = await Promise.all([
      this.prisma.reviewInvestigationObligation.groupBy({
        by: ["state"],
        where: { investigationId },
        _count: { _all: true },
      }),
      this.prisma.reviewInvestigationTurn.findFirst({
        where: { investigationId, state: "aborted" },
        orderBy: { turnOrdinal: "desc" },
        select: { abortReason: true },
      }),
      investigation.activeTurnId
        ? this.prisma.reviewInvestigationTurn.findUnique({
            where: { turnId: investigation.activeTurnId },
            select: { purpose: true },
          })
        : null,
    ]);
    const count = (state: string) =>
      obligations.find((item) => item.state === state)?._count._all ?? 0;
    return Object.freeze({
      investigationId,
      repositoryScopeHash:
        investigation.authorizationScopeHash ??
        sha256(
          canonicalInvestigationOperationsJson({
            workspaceId: investigation.workspaceId,
            repositoryConnectionId: investigation.repositoryConnectionId,
            scmRepositoryIdentityId: investigation.scmRepositoryIdentityId,
            pullRequestNumber: investigation.pullRequestNumber,
          }),
        ),
      reviewRevisionHash: investigation.reviewRevisionHash,
      state: operatorState(investigation.state),
      version: safeNumber(investigation.version, "investigation_version"),
      openObligationCount: count("open"),
      satisfiedObligationCount: count("satisfied"),
      unresolvableObligationCount: count("unresolvable"),
      nextAction: nextAction(investigation, activeTurn?.purpose ?? null),
      capacityEligibleAt: investigation.nextEligibleAt?.toISOString() ?? null,
      lastFailureCode: lastAbortedTurn?.abortReason ?? null,
      conclusion: conclusion(investigation.conclusion),
      compatibility: compatibility(investigation, this.compatibility),
      producerReleaseId: investigation.producerReleaseId,
      protocolVersion: this.compatibility.currentProtocolVersion,
      gatewayPolicyVersion: investigation.gatewayPolicyVersion,
      updatedAt: investigation.updatedAt.toISOString(),
    });
  }
}

async function readPromotionSampleSet(
  persistence: PromotionPersistence,
  signatures: InvestigationEvaluationSignatureVerifierPort | undefined,
  input: Parameters<
    InvestigationTelemetryRepositoryPort["readPromotionSampleSet"]
  >[0],
): Promise<InvestigationPromotionTelemetryReadResult> {
  const trustProfile = normalizeInvestigationPromotionTrustProfile(
    input.trustProfile,
  );
  assertInvestigationPromotionTrustProfileValidAt({
    profile: trustProfile,
    validAt: input.validAt,
  });
  const rows = await persistence.reviewInvestigationTelemetrySample.findMany({
    where: { producerReleaseId: input.producerReleaseId },
    orderBy: { sampleId: "asc" },
    take: maximumInvestigationPromotionTelemetrySamples + 1,
    select: {
      sampleId: true,
      producerReleaseId: true,
      payload: true,
      payloadHash: true,
    },
  });
  if (rows.length > maximumInvestigationPromotionTelemetrySamples) {
    return { status: InvestigationPromotionTelemetryReadStatus.TooLarge };
  }
  const samples = rows.map((row) => {
    const canonical = canonicalInvestigationOperationsJson(row.payload);
    if (sha256(canonical) !== row.payloadHash) {
      throw new Error("telemetry_payload_hash_mismatch");
    }
    const sample = row.payload as unknown as InvestigationTelemetrySample;
    validateTelemetrySample(sample);
    if (
      sample.sampleId !== row.sampleId ||
      row.producerReleaseId !== input.producerReleaseId ||
      sample.producerReleaseId !== row.producerReleaseId
    ) {
      throw new Error("telemetry_sample_identity_mismatch");
    }
    return Object.freeze({ ...sample });
  });
  const fullyEvaluated = samples.filter(isFullyEvaluatedTelemetrySample);
  if (fullyEvaluated.length > 0) {
    if (signatures === undefined) {
      throw promotionAttestationInvalid();
    }
    const attestations =
      await persistence.reviewInvestigationEvaluationAttestation.findMany({
        where: {
          derivedSampleId: {
            in: fullyEvaluated.map((sample) => sample.sampleId),
          },
        },
        orderBy: { derivedSampleId: "asc" },
        take: fullyEvaluated.length + 1,
        select: {
          attestationId: true,
          attestationVersion: true,
          derivedSampleId: true,
          attestationHash: true,
          envelopeHash: true,
          signingKeyId: true,
          signatureAlgorithm: true,
          signatureValue: true,
          terminalSampleId: true,
          terminalSamplePayloadHash: true,
          investigationId: true,
          certificateId: true,
          certificateHash: true,
          producerReleaseId: true,
          corpusVersion: true,
          evaluationPolicyVersion: true,
          payloadCanonicalJson: true,
          payload: true,
        },
      });
    if (attestations.length !== fullyEvaluated.length) {
      throw promotionAttestationInvalid();
    }
    const bySampleId = new Map(
      attestations.map((attestation) => [
        attestation.derivedSampleId,
        attestation,
      ]),
    );
    if (bySampleId.size !== attestations.length) {
      throw promotionAttestationInvalid();
    }
    for (const sample of fullyEvaluated) {
      const attestation = bySampleId.get(sample.sampleId);
      if (attestation === undefined) {
        throw promotionAttestationInvalid();
      }
      const parsed =
        parseStoredInvestigationPromotionEvaluationAttestation(attestation);
      if (
        canonicalInvestigationOperationsJson(attestation.payload) !==
          parsed.payloadCanonicalJson ||
        sha256(parsed.payloadCanonicalJson) !== attestation.attestationHash ||
        sha256(parsed.envelopeCanonicalJson) !== attestation.envelopeHash
      ) {
        throw promotionAttestationInvalid();
      }
      let signatureVerified: boolean;
      try {
        signatureVerified = await signatures.verify({
          algorithm: parsed.evidence.signatureAlgorithm,
          keyId: parsed.evidence.signingKeyId,
          payloadCanonicalJson: parsed.payloadCanonicalJson,
          signature: attestation.signatureValue,
          issuedAt: parsed.evidence.issuedAt,
          now: new Date(input.validAt),
        });
      } catch {
        signatureVerified = false;
      }
      if (!signatureVerified) {
        throw promotionAttestationInvalid();
      }
      assertInvestigationPromotionEvaluationEvidenceTrusted({
        sample,
        evidence: parsed.evidence,
        trustProfile,
        validAt: input.validAt,
      });
    }
  }
  return {
    status: InvestigationPromotionTelemetryReadStatus.Complete,
    samples: Object.freeze(samples),
  };
}

async function savePromotionReport(
  persistence: PromotionPersistence,
  input: {
    readonly reportCanonicalJson: string;
    readonly reportHash: string;
  },
  expectedProducerReleaseId?: string,
): Promise<void> {
  if (sha256(input.reportCanonicalJson) !== input.reportHash) {
    throw new Error("promotion_report_hash_mismatch");
  }
  const body = JSON.parse(input.reportCanonicalJson) as {
    producerReleaseId?: unknown;
    generatedAt?: unknown;
  };
  if (
    typeof body.producerReleaseId !== "string" ||
    (expectedProducerReleaseId !== undefined &&
      body.producerReleaseId !== expectedProducerReleaseId) ||
    typeof body.generatedAt !== "string" ||
    !body.generatedAt.endsWith("Z") ||
    !Number.isFinite(Date.parse(body.generatedAt)) ||
    new Date(body.generatedAt).toISOString() !== body.generatedAt
  ) {
    throw new Error("promotion_report_identity_invalid");
  }
  await persistence.reviewInvestigationPromotionReport.upsert({
    where: { reportHash: input.reportHash },
    create: {
      reportHash: input.reportHash,
      producerReleaseId: body.producerReleaseId,
      generatedAt: new Date(body.generatedAt),
      canonicalJson: input.reportCanonicalJson,
      body: body as Prisma.InputJsonValue,
    },
    update: {},
  });
}

function promotionAttestationInvalid(): InvestigationPromotionTrustError {
  return new InvestigationPromotionTrustError(
    InvestigationPromotionTrustErrorCode.EvaluationAttestationInvalid,
  );
}

function operatorState(value: string): InvestigationOperatorState {
  return Object.values(InvestigationOperatorState).includes(
    value as InvestigationOperatorState,
  )
    ? (value as InvestigationOperatorState)
    : InvestigationOperatorState.Unknown;
}

function conclusion(value: string | null): InvestigationOperatorConclusion {
  if (value === null) return InvestigationOperatorConclusion.None;
  return Object.values(InvestigationOperatorConclusion).includes(
    value as InvestigationOperatorConclusion,
  )
    ? (value as InvestigationOperatorConclusion)
    : InvestigationOperatorConclusion.Unknown;
}

function nextAction(
  investigation: ReviewInvestigation,
  activeTurnPurpose: string | null,
): InvestigationOperatorNextAction {
  if (investigation.nextEligibleAt && investigation.state === "awaiting_turn")
    return InvestigationOperatorNextAction.AwaitCapacity;
  switch (investigation.state) {
    case "provisional":
    case "awaiting_turn":
      return InvestigationOperatorNextAction.RunTurn;
    case "turn_leased":
      return activeTurnPurpose === "critic"
        ? InvestigationOperatorNextAction.RunCritic
        : InvestigationOperatorNextAction.RunTurn;
    case "awaiting_critic":
      return InvestigationOperatorNextAction.RunCritic;
    case "ready_to_conclude":
      return InvestigationOperatorNextAction.Conclude;
    case "inconclusive":
      return investigation.certificateId
        ? InvestigationOperatorNextAction.Terminal
        : InvestigationOperatorNextAction.Conclude;
    case "concluded":
    case "superseded":
    case "expired":
      return InvestigationOperatorNextAction.Terminal;
    default:
      return InvestigationOperatorNextAction.Unknown;
  }
}

function compatibility(
  investigation: ReviewInvestigation,
  policy: {
    readonly supportedGatewayPolicyVersions: ReadonlySet<string>;
    readonly acceptedProducerReleaseIds: ReadonlySet<string>;
  },
): InvestigationCompatibilityStatus {
  if (
    !policy.supportedGatewayPolicyVersions.has(
      investigation.gatewayPolicyVersion,
    )
  )
    return InvestigationCompatibilityStatus.Unsupported;
  return policy.acceptedProducerReleaseIds.has(investigation.producerReleaseId)
    ? InvestigationCompatibilityStatus.Compatible
    : InvestigationCompatibilityStatus.Legacy;
}

function safeNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`${field}_invalid`);
  return number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
