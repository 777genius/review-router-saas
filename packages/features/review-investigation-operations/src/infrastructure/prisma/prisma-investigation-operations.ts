import { createHash } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type ReviewInvestigation,
} from "@prisma/client";
import type {
  InvestigationOperatorStatusRepositoryPort,
  InvestigationPromotionReportRepositoryPort,
  InvestigationTelemetryRepositoryPort,
} from "../../application/ports/operations-ports";
import {
  type InvestigationTelemetrySample,
  validateTelemetrySample,
} from "../../domain/investigation-telemetry";
import {
  InvestigationCompatibilityStatus,
  InvestigationOperatorConclusion,
  InvestigationOperatorNextAction,
  InvestigationOperatorState,
  type InvestigationOperatorStatus,
} from "../../domain/operator-status";

export class PrismaInvestigationOperations
  implements
    InvestigationTelemetryRepositoryPort,
    InvestigationOperatorStatusRepositoryPort,
    InvestigationPromotionReportRepositoryPort
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly compatibility: {
      readonly currentProtocolVersion: string;
      readonly supportedGatewayPolicyVersions: ReadonlySet<string>;
      readonly acceptedProducerReleaseIds: ReadonlySet<string>;
    },
  ) {}

  async append(sample: InvestigationTelemetrySample): Promise<void> {
    validateTelemetrySample(sample);
    const payloadCanonicalJson = canonicalJson(sample);
    const payloadHash = sha256(payloadCanonicalJson);
    const existing =
      await this.prisma.reviewInvestigationTelemetrySample.findUnique({
        where: { sampleId: sample.sampleId },
        select: { payloadHash: true },
      });
    if (existing) {
      if (existing.payloadHash !== payloadHash)
        throw new Error("telemetry_sample_id_conflict");
      return;
    }
    try {
      await this.prisma.reviewInvestigationTelemetrySample.create({
        data: {
          sampleId: sample.sampleId,
          producerReleaseId: sample.producerReleaseId,
          source: sample.source,
          repositoryScopeHash: sample.repositoryScopeHash,
          reviewRevisionHash: sample.reviewRevisionHash,
          stableReviewUnitHash: sample.stableReviewUnitHash,
          payload: JSON.parse(payloadCanonicalJson) as Prisma.InputJsonValue,
          payloadHash,
          collectedAt: new Date(sample.collectedAt),
        },
      });
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

  async listByProducerRelease(
    producerReleaseId: string,
  ): Promise<readonly InvestigationTelemetrySample[]> {
    const rows = await this.prisma.reviewInvestigationTelemetrySample.findMany({
      where: { producerReleaseId },
      orderBy: { sampleId: "asc" },
      select: { payload: true, payloadHash: true },
    });
    return rows.map((row) => {
      const canonical = canonicalJson(row.payload);
      if (sha256(canonical) !== row.payloadHash)
        throw new Error("telemetry_payload_hash_mismatch");
      const sample = row.payload as unknown as InvestigationTelemetrySample;
      validateTelemetrySample(sample);
      return Object.freeze({ ...sample });
    });
  }

  async save(input: {
    readonly reportCanonicalJson: string;
    readonly reportHash: string;
  }): Promise<void> {
    if (sha256(input.reportCanonicalJson) !== input.reportHash)
      throw new Error("promotion_report_hash_mismatch");
    const body = JSON.parse(input.reportCanonicalJson) as {
      producerReleaseId: string;
      generatedAt: string;
    };
    await this.prisma.reviewInvestigationPromotionReport.upsert({
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
          canonicalJson({
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("canonical_value_invalid");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
