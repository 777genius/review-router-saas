import { canonicalJson, type CanonicalValue } from "./canonicalization";
import {
  ContextCriticDecision,
  InvestigationTurnProviderKind,
  InvestigationObligationKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationTurnPurpose,
} from "./review-investigation-types";

export const investigationTurnObservationVersion = 1 as const;

export { InvestigationTurnProviderKind } from "./review-investigation-types";

export type InvestigationTurnObservation = Readonly<{
  outputVersion: 1;
  findings: readonly Readonly<{
    severity: string;
    title: string;
    body: string;
    path: string;
    line: number | null;
    evidenceOperationReceiptIds: readonly string[];
  }>[];
  obligationProposals: readonly Readonly<{
    kind: InvestigationObligationKind;
    canonicalSubject: string;
    canonicalRequirement: string;
    riskPriority: number;
  }>[];
  closureClaims: readonly Readonly<{
    obligationId: string;
    operationReceiptIds: readonly string[];
  }>[];
  unresolvableClaims: readonly Readonly<{
    obligationId: string;
    reason: string;
    evidenceOperationReceiptIds: readonly string[];
  }>[];
  criticDecision: ContextCriticDecision | null;
  observationVersion: typeof investigationTurnObservationVersion;
  invocationId: string;
  turnId: string;
  dossierVersion: number;
  purpose: ReviewInvestigationTurnPurpose;
  actualProviderKind: InvestigationTurnProviderKind;
  actualModel: string;
  runtimeProfile: ReviewInvestigationRuntimeProfile;
  usage: Readonly<{
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  }>;
  durationMs: number;
  schemaComplete: true;
  streamComplete: true;
  contextAttestationReference: string;
}>;

export function parseInvestigationTurnObservation(
  value: unknown,
): InvestigationTurnObservation {
  const root = record(value, "turn_observation");
  exactKeys(root, [
    "outputVersion", "findings", "obligationProposals", "closureClaims",
    "unresolvableClaims", "criticDecision", "observationVersion",
    "invocationId", "turnId", "dossierVersion", "purpose",
    "actualProviderKind", "actualModel", "runtimeProfile", "usage",
    "durationMs", "schemaComplete", "streamComplete",
    "contextAttestationReference",
  ]);
  if (
    root.outputVersion !== 1 ||
    root.observationVersion !== investigationTurnObservationVersion ||
    root.schemaComplete !== true ||
    root.streamComplete !== true
  ) {
    throw new Error("investigation_turn_observation_incomplete");
  }
  const usage = record(root.usage, "turn_usage");
  exactKeys(usage, [
    "inputTokens", "cachedInputTokens", "outputTokens",
    "reasoningOutputTokens", "totalTokens",
  ]);
  const parsedUsage = Object.freeze({
    inputTokens: nonNegativeInteger(usage.inputTokens, "input_tokens"),
    cachedInputTokens: nonNegativeInteger(
      usage.cachedInputTokens,
      "cached_input_tokens",
    ),
    outputTokens: nonNegativeInteger(usage.outputTokens, "output_tokens"),
    reasoningOutputTokens: nonNegativeInteger(
      usage.reasoningOutputTokens,
      "reasoning_output_tokens",
    ),
    totalTokens: nonNegativeInteger(usage.totalTokens, "total_tokens"),
  });
  if (
    parsedUsage.totalTokens !==
    parsedUsage.inputTokens +
      parsedUsage.outputTokens +
      parsedUsage.reasoningOutputTokens
  ) {
    throw new Error("investigation_turn_usage_invalid");
  }
  return Object.freeze({
    outputVersion: 1,
    findings: boundedArray(root.findings, "findings").map((item) => {
      const finding = record(item, "finding");
      exactKeys(finding, [
        "severity", "title", "body", "path", "line",
        "evidenceOperationReceiptIds",
      ]);
      return Object.freeze({
        severity: text(finding.severity, "finding_severity", 32),
        title: text(finding.title, "finding_title", 240),
        body: text(finding.body, "finding_body", 16_000),
        path: text(finding.path, "finding_path", 2_000),
        line:
          finding.line === null
            ? null
            : positiveInteger(finding.line, "finding_line"),
        evidenceOperationReceiptIds: digestArray(
          finding.evidenceOperationReceiptIds,
          "finding_receipts",
        ),
      });
    }),
    obligationProposals: boundedArray(
      root.obligationProposals,
      "obligation_proposals",
    ).map((item) => {
      const proposal = record(item, "obligation_proposal");
      exactKeys(proposal, [
        "kind", "canonicalSubject", "canonicalRequirement", "riskPriority",
      ]);
      return Object.freeze({
        kind: enumValue(
          proposal.kind,
          InvestigationObligationKind,
          "obligation_kind",
        ),
        canonicalSubject: text(
          proposal.canonicalSubject,
          "canonical_subject",
          4_000,
        ),
        canonicalRequirement: text(
          proposal.canonicalRequirement,
          "canonical_requirement",
          4_000,
        ),
        riskPriority: nonNegativeInteger(
          proposal.riskPriority,
          "risk_priority",
        ),
      });
    }),
    closureClaims: boundedArray(root.closureClaims, "closure_claims").map(
      (item) => {
        const claim = record(item, "closure_claim");
        exactKeys(claim, ["obligationId", "operationReceiptIds"]);
        const operationReceiptIds = digestArray(
          claim.operationReceiptIds,
          "closure_receipts",
        );
        if (operationReceiptIds.length === 0) {
          throw new Error("investigation_closure_receipts_required");
        }
        return Object.freeze({
          obligationId: digest(claim.obligationId, "obligation_id"),
          operationReceiptIds,
        });
      },
    ),
    unresolvableClaims: boundedArray(
      root.unresolvableClaims,
      "unresolvable_claims",
    ).map((item) => {
      const claim = record(item, "unresolvable_claim");
      exactKeys(claim, [
        "obligationId", "reason", "evidenceOperationReceiptIds",
      ]);
      return Object.freeze({
        obligationId: digest(claim.obligationId, "obligation_id"),
        reason: text(claim.reason, "unresolvable_reason", 2_000),
        evidenceOperationReceiptIds: digestArray(
          claim.evidenceOperationReceiptIds,
          "unresolvable_receipts",
        ),
      });
    }),
    criticDecision:
      root.criticDecision === null
        ? null
        : enumValue(root.criticDecision, ContextCriticDecision, "critic_decision"),
    observationVersion: investigationTurnObservationVersion,
    invocationId: text(root.invocationId, "invocation_id", 512),
    turnId: text(root.turnId, "turn_id", 256),
    dossierVersion: positiveInteger(root.dossierVersion, "dossier_version"),
    purpose: enumValue(
      root.purpose,
      ReviewInvestigationTurnPurpose,
      "turn_purpose",
    ),
    actualProviderKind: enumValue(
      root.actualProviderKind,
      InvestigationTurnProviderKind,
      "provider_kind",
    ),
    actualModel: text(root.actualModel, "actual_model", 256),
    runtimeProfile: enumValue(
      root.runtimeProfile,
      ReviewInvestigationRuntimeProfile,
      "runtime_profile",
    ),
    usage: parsedUsage,
    durationMs: positiveInteger(root.durationMs, "duration_ms"),
    schemaComplete: true,
    streamComplete: true,
    contextAttestationReference: text(
      root.contextAttestationReference,
      "context_attestation_reference",
      256,
    ),
  });
}

export function canonicalInvestigationTurnObservation(
  observation: InvestigationTurnObservation,
): string {
  return canonicalJson(observation as unknown as CanonicalValue);
}

export function canonicalInvestigationTerminalObservation(
  observation: InvestigationTurnObservation,
): string {
  return canonicalJson({
    ...(observation as unknown as Record<string, CanonicalValue>),
    contextAttestationReference: null,
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    throw new Error("investigation_turn_observation_shape_invalid");
  }
}

function boundedArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function digestArray(value: unknown, field: string): readonly string[] {
  const items = boundedArray(value, field).map((item) => digest(item, field));
  if (new Set(items).size !== items.length) throw new Error(`${field}_duplicate`);
  return Object.freeze(items);
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value.includes("\0")
  ) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field}_invalid`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = nonNegativeInteger(value, field);
  if (parsed < 1) throw new Error(`${field}_invalid`);
  return parsed;
}

function enumValue<T extends Record<string, string>>(
  value: unknown,
  source: T,
  field: string,
): T[keyof T] {
  if (typeof value !== "string" || !Object.values(source).includes(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value as T[keyof T];
}
