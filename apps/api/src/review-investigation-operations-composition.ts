import { createHash, timingSafeEqual } from "node:crypto";
import { contextGatewayV4PolicyVersion } from "@reviewrouter/features-review-context-attestation";
import {
  canonicalInvestigationScope,
  InvestigationTurnProviderKind,
  ReviewInvestigationConclusion,
  type InvestigationStorePort,
  type ReviewInvestigation,
} from "@reviewrouter/features-review-investigations";
import { PrismaInvestigationStore } from "@reviewrouter/features-review-investigations/composition";
import {
  GenerateInvestigationPromotionReport,
  GetInvestigationOperatorStatus,
  InvestigationLegacyComparison,
  InvestigationOperationalFailure,
  InvestigationReplayOutcome,
  InvestigationTelemetryConclusion,
  InvestigationTelemetryEvidenceCompleteness,
  InvestigationTelemetryProvider,
  InvestigationTelemetrySource,
  RecordInvestigationTelemetry,
  type InvestigationTerminalOperationalTelemetrySample,
  validateTelemetrySample,
} from "@reviewrouter/features-review-investigation-operations";
import {
  ConfiguredEd25519InvestigationEvaluationVerifier,
  ConfiguredInvestigationPromotionPolicyRegistry,
  PrismaInvestigationOperations,
  createPrismaInvestigationEvaluationImporter,
} from "@reviewrouter/features-review-investigation-operations/composition";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { reviewActionV2PublishedProtocolVersion } from "@reviewrouter/protocol-review-action-v2";
import type { ReviewInvestigationTerminalTelemetryPort } from "./review-action-v2-investigation-composition.js";
import {
  ReviewInvestigationOperatorOperation,
  type RegisterReviewInvestigationOperatorRoutesDependencies,
  type ReviewInvestigationOperatorAuthorizationPort,
  type ReviewInvestigationOperatorStatusPort,
  type ReviewInvestigationPromotionReportPort,
  type ReviewInvestigationEvaluationImportPort,
} from "./review-investigation-operator-routes.js";

function assertInvestigationOperationsConfiguration(input: {
  readonly promotionCredentialSha256: string | undefined;
  readonly evaluationImportCredentialSha256: string | undefined;
  readonly evaluationPublicKeysJson: string | undefined;
  readonly promotionPolicyProfilesJson: string | undefined;
}): void {
  const promotionConfigured = Boolean(input.promotionCredentialSha256);
  const policiesConfigured = Boolean(input.promotionPolicyProfilesJson);
  if (promotionConfigured !== policiesConfigured) {
    throw new Error("investigation_promotion_configuration_incomplete");
  }
  if (
    (promotionConfigured || input.evaluationImportCredentialSha256) &&
    !input.evaluationPublicKeysJson
  ) {
    throw new Error("investigation_evaluation_key_registry_required");
  }
  if (
    input.promotionCredentialSha256 &&
    input.evaluationImportCredentialSha256 &&
    input.promotionCredentialSha256 === input.evaluationImportCredentialSha256
  ) {
    throw new Error("investigation_operator_credential_separation_required");
  }
}

export interface ReviewInvestigationTelemetryRecorderPort {
  record(
    sample: InvestigationTerminalOperationalTelemetrySample,
  ): Promise<void>;
}

export type ReviewInvestigationTerminalTelemetrySample = Readonly<{
  investigationId: string;
  sample: InvestigationTerminalOperationalTelemetrySample;
}>;

export interface ReviewInvestigationTerminalTelemetrySamplePort {
  findTerminalSample(input: {
    readonly investigationId: string;
  }): Promise<ReviewInvestigationTerminalTelemetrySample | null>;
}

export interface ReviewInvestigationTerminalTelemetrySourcePort {
  resolveSource(
    investigation: ReviewInvestigation,
  ): Promise<InvestigationTelemetrySource>;
}

export enum ReviewInvestigationOperationsDiagnosticCode {
  TerminalTelemetrySampleUnavailable = "terminal_telemetry_sample_unavailable",
  TerminalTelemetrySampleInvestigationMismatch = "terminal_telemetry_sample_investigation_mismatch",
  TerminalTelemetryRecordFailed = "terminal_telemetry_record_failed",
}

export interface ReviewInvestigationOperationsDiagnosticPort {
  record(
    code: ReviewInvestigationOperationsDiagnosticCode,
  ): Promise<void> | void;
}

export type PrismaReviewInvestigationOperationsComposition = Readonly<{
  operatorRoutes: RegisterReviewInvestigationOperatorRoutesDependencies;
  telemetry: ReviewInvestigationTelemetryRecorderPort;
}>;

export function composePrismaReviewInvestigationOperations(input: {
  readonly prisma: PrismaClient;
  readonly operatorCredentialSha256: string;
  readonly promotionCredentialSha256?: string;
  readonly evaluationImportCredentialSha256?: string;
  readonly evaluationPublicKeysJson?: string;
  readonly promotionPolicyProfilesJson?: string;
  readonly now?: () => Date;
}): PrismaReviewInvestigationOperationsComposition {
  const compatibility = {
    currentProtocolVersion: reviewActionV2PublishedProtocolVersion,
    supportedGatewayPolicyVersions: new Set([contextGatewayV4PolicyVersion]),
    acceptedProducerReleaseIds: new Set<string>(),
  } as const;
  const digest = new NodeInvestigationOperationsDigest();
  const now = input.now ?? (() => new Date());
  const evaluationClock = { now };
  const evaluationPublicKeysJson = input.evaluationPublicKeysJson?.trim();
  const promotionPolicyProfilesJson = input.promotionPolicyProfilesJson?.trim();
  assertInvestigationOperationsConfiguration({
    promotionCredentialSha256: input.promotionCredentialSha256,
    evaluationImportCredentialSha256: input.evaluationImportCredentialSha256,
    evaluationPublicKeysJson,
    promotionPolicyProfilesJson,
  });
  const signatures = evaluationPublicKeysJson
    ? ConfiguredEd25519InvestigationEvaluationVerifier.fromJson(
        evaluationPublicKeysJson,
      )
    : undefined;
  const policies = promotionPolicyProfilesJson
    ? ConfiguredInvestigationPromotionPolicyRegistry.fromJson(
        promotionPolicyProfilesJson,
      )
    : undefined;
  const operations = new PrismaInvestigationOperations(
    input.prisma,
    compatibility,
    signatures,
  );
  const evaluationImports =
    evaluationPublicKeysJson && input.evaluationImportCredentialSha256
      ? new PrismaReviewInvestigationEvaluationImports(
          createPrismaInvestigationEvaluationImporter({
            prisma: input.prisma,
            publicKeysJson: evaluationPublicKeysJson,
            digest,
            clock: evaluationClock,
          }),
        )
      : undefined;
  const promotionReports =
    policies && signatures && input.promotionCredentialSha256
      ? new PrismaReviewInvestigationPromotionReports(
          new GenerateInvestigationPromotionReport(
            policies,
            operations,
            digest,
          ),
          now,
        )
      : undefined;

  return Object.freeze({
    operatorRoutes: Object.freeze({
      authorization: new HashedReviewInvestigationOperatorAuthorization(
        Object.freeze({
          [ReviewInvestigationOperatorOperation.ReadStatus]:
            input.operatorCredentialSha256,
          ...(input.promotionCredentialSha256
            ? {
                [ReviewInvestigationOperatorOperation.GeneratePromotionReport]:
                  input.promotionCredentialSha256,
              }
            : {}),
          ...(input.evaluationImportCredentialSha256
            ? {
                [ReviewInvestigationOperatorOperation.ImportEvaluation]:
                  input.evaluationImportCredentialSha256,
              }
            : {}),
        }),
      ),
      status: new PrismaReviewInvestigationOperatorStatus(
        input.prisma,
        compatibility,
      ),
      ...(promotionReports ? { promotionReports } : {}),
      ...(evaluationImports ? { evaluationImports } : {}),
    }),
    telemetry: new PrismaReviewInvestigationTelemetryRecorder(
      new RecordInvestigationTelemetry(operations),
    ),
  });
}

class PrismaReviewInvestigationEvaluationImports implements ReviewInvestigationEvaluationImportPort {
  constructor(
    private readonly useCase: ReturnType<
      typeof createPrismaInvestigationEvaluationImporter
    >,
  ) {}

  execute(
    input: Parameters<ReviewInvestigationEvaluationImportPort["execute"]>[0],
  ) {
    return this.useCase.execute(input);
  }
}

export function composePrismaReviewInvestigationTerminalTelemetry(input: {
  readonly prisma: PrismaClient;
  readonly samples?: ReviewInvestigationTerminalTelemetrySamplePort;
  readonly investigations?: Pick<InvestigationStorePort, "findById">;
  readonly sources?: ReviewInvestigationTerminalTelemetrySourcePort;
  readonly source?: InvestigationTelemetrySource;
  readonly diagnostics: ReviewInvestigationOperationsDiagnosticPort;
}): ReviewInvestigationTerminalTelemetryPort {
  const operations = new PrismaInvestigationOperations(input.prisma, {
    currentProtocolVersion: reviewActionV2PublishedProtocolVersion,
    supportedGatewayPolicyVersions: new Set([contextGatewayV4PolicyVersion]),
    acceptedProducerReleaseIds: new Set(),
  });
  if (input.sources !== undefined && input.source !== undefined) {
    throw new Error("terminal_telemetry_source_configuration_invalid");
  }
  const samples =
    input.samples ??
    new StoredReviewInvestigationTerminalTelemetrySamples(
      input.investigations ?? new PrismaInvestigationStore(input.prisma),
      input.sources ??
        new FixedReviewInvestigationTerminalTelemetrySource(
          input.source ?? InvestigationTelemetrySource.Shadow,
        ),
    );
  return new ProductionReviewInvestigationTerminalTelemetry(
    samples,
    new PrismaReviewInvestigationTelemetryRecorder(
      new RecordInvestigationTelemetry(operations),
    ),
    input.diagnostics,
  );
}

export class StoredReviewInvestigationTerminalTelemetrySamples implements ReviewInvestigationTerminalTelemetrySamplePort {
  constructor(
    private readonly investigations: Pick<InvestigationStorePort, "findById">,
    private readonly sources: ReviewInvestigationTerminalTelemetrySourcePort,
  ) {}

  async findTerminalSample(input: {
    readonly investigationId: string;
  }): Promise<ReviewInvestigationTerminalTelemetrySample | null> {
    const investigation = await this.investigations.findById(
      input.investigationId,
    );
    if (
      investigation === null ||
      investigation.certificate === null ||
      investigation.conclusion === null
    ) {
      return null;
    }
    assertTerminalCertificateMatchesInvestigation(investigation);
    const certificate = investigation.certificate;
    const source = await this.sources.resolveSource(investigation);
    assertTerminalTelemetrySource(source);
    const tokenBreakdown = completeTokenBreakdown(investigation);
    const receipts = investigation.obligations.flatMap((obligation) =>
      obligation.receipt === null ? [] : [obligation.receipt],
    );
    const operationReceiptIds = new Set(
      receipts.flatMap((receipt) => receipt.operationReceiptIds),
    );
    const sample: InvestigationTerminalOperationalTelemetrySample =
      Object.freeze({
        sampleId: `terminal-${certificate.certificateHash}`,
        collectedAt: certificate.issuedAt,
        source,
        evidenceCompleteness:
          InvestigationTelemetryEvidenceCompleteness.TerminalOperational,
        repositoryScopeHash: certificate.scopeHash,
        reviewRevisionHash: certificate.reviewRevisionHash,
        stableReviewUnitHash: sha256(certificate.stableReviewUnitKey),
        producerReleaseId: certificate.producerReleaseId,
        provider: terminalProvider(certificate.terminalProviderKind),
        actualModel: certificate.terminalActualModel,
        conclusion: terminalConclusion(certificate.conclusion),
        findingCount: investigation.findings.length,
        expectedDefectCount: null,
        detectedDefectCount: null,
        falseClean: null,
        legacyComparison: InvestigationLegacyComparison.NotCompared,
        replayOutcome: receipts.some(
          (receipt) => receipt.replayProofId !== null,
        )
          ? InvestigationReplayOutcome.CrossRevisionHit
          : InvestigationReplayOutcome.Unknown,
        failure: InvestigationOperationalFailure.None,
        semanticTurns: investigation.semanticTurns,
        criticCycles: investigation.criticCycles,
        gatewayOperations: operationReceiptIds.size,
        promptTokens: tokenBreakdown?.promptTokens ?? null,
        completionTokens: tokenBreakdown?.completionTokens ?? null,
        totalTokens: investigation.totalUsageTokens,
        durationMs: investigation.totalDurationMs,
        timeToFirstFindingMs: null,
        capacityWaitMs: null,
        // This is the exact UTF-8 size of the durable terminal protocol payload.
        protocolBytes: Buffer.byteLength(
          certificate.terminalObservationCanonicalJson,
          "utf8",
        ),
        retainedBytes: null,
        securityViolationCount: null,
      });
    validateTelemetrySample(sample);
    return Object.freeze({
      investigationId: investigation.investigationId,
      sample,
    });
  }
}

class FixedReviewInvestigationTerminalTelemetrySource implements ReviewInvestigationTerminalTelemetrySourcePort {
  constructor(private readonly source: InvestigationTelemetrySource) {
    assertTerminalTelemetrySource(source);
  }

  async resolveSource(): Promise<InvestigationTelemetrySource> {
    return this.source;
  }
}

class HashedReviewInvestigationOperatorAuthorization implements ReviewInvestigationOperatorAuthorizationPort {
  private readonly expected: ReadonlyMap<
    ReviewInvestigationOperatorOperation,
    Buffer
  >;

  constructor(
    configured: Readonly<
      Partial<Record<ReviewInvestigationOperatorOperation, string>>
    >,
  ) {
    const expected = new Map<ReviewInvestigationOperatorOperation, Buffer>();
    for (const [operation, digest] of Object.entries(configured)) {
      if (!/^[a-f0-9]{64}$/u.test(digest)) {
        throw new Error(
          "review_investigation_operator_credential_hash_invalid",
        );
      }
      expected.set(
        operation as ReviewInvestigationOperatorOperation,
        Buffer.from(digest, "hex"),
      );
    }
    this.expected = expected;
  }

  async authenticate(input: {
    readonly credential: string;
    readonly operation: ReviewInvestigationOperatorOperation;
  }): Promise<boolean> {
    if (
      input.credential.length < 32 ||
      input.credential.length > 8_192 ||
      /\s/u.test(input.credential)
    ) {
      return false;
    }
    const expected = this.expected.get(input.operation);
    if (expected === undefined) return false;
    const actual = createHash("sha256").update(input.credential).digest();
    return timingSafeEqual(actual, expected);
  }
}

class PrismaReviewInvestigationOperatorStatus implements ReviewInvestigationOperatorStatusPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly compatibility: Readonly<{
      currentProtocolVersion: string;
      supportedGatewayPolicyVersions: ReadonlySet<string>;
    }>,
  ) {}

  async execute(investigationId: string) {
    const releases = await this.prisma.producerRelease.findMany({
      where: { state: "registered" },
      select: { producerReleaseId: true },
    });
    const status = await new GetInvestigationOperatorStatus(
      new PrismaInvestigationOperations(this.prisma, {
        ...this.compatibility,
        acceptedProducerReleaseIds: new Set(
          releases.map((release) => release.producerReleaseId),
        ),
      }),
    ).execute(investigationId);
    if (status !== null) assertSanitizedOperatorStatusMetadata(status);
    return status;
  }
}

class PrismaReviewInvestigationPromotionReports implements ReviewInvestigationPromotionReportPort {
  constructor(
    private readonly useCase: GenerateInvestigationPromotionReport,
    private readonly now: () => Date,
  ) {}

  execute(
    input: Parameters<ReviewInvestigationPromotionReportPort["execute"]>[0],
  ) {
    return this.useCase.execute({
      ...input,
      generatedAt: this.now().toISOString(),
    });
  }
}

class PrismaReviewInvestigationTelemetryRecorder implements ReviewInvestigationTelemetryRecorderPort {
  constructor(private readonly useCase: RecordInvestigationTelemetry) {}

  record(
    sample: InvestigationTerminalOperationalTelemetrySample,
  ): Promise<void> {
    assertSanitizedTelemetryMetadata(sample);
    return this.useCase.execute(sample);
  }
}

class ProductionReviewInvestigationTerminalTelemetry implements ReviewInvestigationTerminalTelemetryPort {
  constructor(
    private readonly samples: ReviewInvestigationTerminalTelemetrySamplePort,
    private readonly telemetry: ReviewInvestigationTelemetryRecorderPort,
    private readonly diagnostics: ReviewInvestigationOperationsDiagnosticPort,
  ) {}

  async recordConcluded(input: {
    readonly investigationId: string;
  }): Promise<void> {
    let terminal: ReviewInvestigationTerminalTelemetrySample | null;
    try {
      terminal = await this.samples.findTerminalSample(input);
    } catch {
      await this.recordDiagnostic(
        ReviewInvestigationOperationsDiagnosticCode.TerminalTelemetrySampleUnavailable,
      );
      return;
    }
    if (terminal === null) {
      await this.recordDiagnostic(
        ReviewInvestigationOperationsDiagnosticCode.TerminalTelemetrySampleUnavailable,
      );
      return;
    }
    if (terminal.investigationId !== input.investigationId) {
      await this.recordDiagnostic(
        ReviewInvestigationOperationsDiagnosticCode.TerminalTelemetrySampleInvestigationMismatch,
      );
      return;
    }
    try {
      await this.telemetry.record(terminal.sample);
    } catch {
      await this.recordDiagnostic(
        ReviewInvestigationOperationsDiagnosticCode.TerminalTelemetryRecordFailed,
      );
    }
  }

  private async recordDiagnostic(
    code: ReviewInvestigationOperationsDiagnosticCode,
  ): Promise<void> {
    try {
      await this.diagnostics.record(code);
    } catch {
      // Diagnostics must not change an already committed investigation result.
    }
  }
}

class NodeInvestigationOperationsDigest {
  async digestUtf8(value: string): Promise<string> {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}

function assertSanitizedTelemetryMetadata(
  sample: InvestigationTerminalOperationalTelemetrySample,
): void {
  for (const value of [
    sample.sampleId,
    sample.producerReleaseId,
    sample.actualModel,
  ].filter((value): value is string => value !== null)) {
    if (value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)) {
      throw new Error("investigation_telemetry_metadata_invalid");
    }
  }
}

function assertTerminalCertificateMatchesInvestigation(
  investigation: ReviewInvestigation,
): void {
  const certificate = investigation.certificate;
  if (
    certificate === null ||
    investigation.conclusion === null ||
    certificate.investigationId !== investigation.investigationId ||
    certificate.conclusion !== investigation.conclusion ||
    certificate.reviewRevisionHash !==
      investigation.revision.reviewRevisionHash ||
    certificate.stableReviewUnitKey !== investigation.stableReviewUnitKey ||
    certificate.scopeHash !==
      sha256(canonicalInvestigationScope(investigation.scope)) ||
    certificate.producerReleaseId !== investigation.contract.producerReleaseId
  ) {
    throw new Error("terminal_telemetry_certificate_mismatch");
  }
}

function assertTerminalTelemetrySource(
  source: InvestigationTelemetrySource,
): void {
  if (
    source !== InvestigationTelemetrySource.Shadow &&
    source !== InvestigationTelemetrySource.Allowlisted
  ) {
    throw new Error("terminal_telemetry_source_invalid");
  }
}

function completeTokenBreakdown(
  investigation: ReviewInvestigation,
): Readonly<{ promptTokens: number; completionTokens: number }> | null {
  if (
    investigation.turnProvenance.length !==
    investigation.semanticTurns + investigation.criticCycles
  ) {
    return null;
  }
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let durationMs = 0;
  for (const provenance of investigation.turnProvenance) {
    promptTokens += provenance.inputTokens;
    completionTokens +=
      provenance.outputTokens + provenance.reasoningOutputTokens;
    totalTokens += provenance.totalTokens;
    durationMs += provenance.durationMs;
    if (
      !Number.isSafeInteger(promptTokens) ||
      !Number.isSafeInteger(completionTokens) ||
      !Number.isSafeInteger(totalTokens) ||
      !Number.isSafeInteger(durationMs)
    ) {
      return null;
    }
  }
  if (
    totalTokens !== investigation.totalUsageTokens ||
    durationMs !== investigation.totalDurationMs ||
    promptTokens + completionTokens !== totalTokens
  ) {
    return null;
  }
  return Object.freeze({ promptTokens, completionTokens });
}

function terminalProvider(
  provider: InvestigationTurnProviderKind | null,
): InvestigationTelemetryProvider {
  switch (provider) {
    case InvestigationTurnProviderKind.Codex:
      return InvestigationTelemetryProvider.Codex;
    case InvestigationTurnProviderKind.ClaudeCode:
      return InvestigationTelemetryProvider.ClaudeCode;
    case null:
      return InvestigationTelemetryProvider.Unknown;
  }
}

function terminalConclusion(
  conclusion: ReviewInvestigationConclusion,
): InvestigationTelemetryConclusion {
  switch (conclusion) {
    case ReviewInvestigationConclusion.VerifiedClean:
      return InvestigationTelemetryConclusion.VerifiedClean;
    case ReviewInvestigationConclusion.Findings:
      return InvestigationTelemetryConclusion.Findings;
    case ReviewInvestigationConclusion.Inconclusive:
      return InvestigationTelemetryConclusion.Inconclusive;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSanitizedOperatorStatusMetadata(status: {
  readonly investigationId: string;
  readonly producerReleaseId: string;
  readonly protocolVersion: string;
  readonly gatewayPolicyVersion: string;
  readonly lastFailureCode: string | null;
}): void {
  for (const value of [
    status.investigationId,
    status.producerReleaseId,
    status.protocolVersion,
    status.gatewayPolicyVersion,
  ]) {
    if (value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
      throw new Error("investigation_operator_metadata_invalid");
    }
  }
  if (
    status.lastFailureCode !== null &&
    !/^[a-z][a-z0-9_]{0,127}$/u.test(status.lastFailureCode)
  ) {
    throw new Error("investigation_operator_metadata_invalid");
  }
}
