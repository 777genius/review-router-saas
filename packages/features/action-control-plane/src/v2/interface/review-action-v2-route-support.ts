import type { FastifyInstance } from "fastify";
import {
  createReviewActionV2ErrorResponse,
  createReviewActionV2ResultResponse,
  parseReviewActionV2Request,
  reviewActionV2Operations,
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  type ReviewActionV2RequestMap,
  type ReviewActionV2ResultMap,
} from "@reviewrouter/protocol-review-action-v2";
import {
  ReviewActionV2RouteFailure,
  toSafeReviewActionV2RouteFailure,
} from "./review-action-v2-route-failure.js";

export type ReviewActionV2RouteRuntimeDependencies = {
  readonly readServerTime: () => Promise<Date>;
  readonly createRequestId: () => string;
  readonly recordProtocolRejection?: (input: {
    readonly operationId: ReviewActionV2OperationId;
    readonly protocolErrorCode: ReviewActionV2ProtocolErrorCode;
    readonly protocolIssues: readonly string[];
    readonly requestId: string;
    readonly statusCode: number;
    readonly internalFailureClass?: string;
    readonly internalFailureCode?: string;
    readonly internalFailureCauseCode?: string;
    readonly internalFailureStage?: ReviewActionV2InternalFailureStage;
  }) => void;
};

export enum ReviewActionV2InternalFailureStage {
  InvestigationTurnCommitObservation = "investigation_turn_commit_observation",
  InvestigationTurnCommitRestore = "investigation_turn_commit_restore",
  InvestigationTurnCommitAggregate = "investigation_turn_commit_aggregate",
  InvestigationTurnCommitMutation = "investigation_turn_commit_mutation",
}

const internalFailureStages = new WeakMap<
  Error,
  ReviewActionV2InternalFailureStage
>();

const safeInternalFailureClasses = new Set([
  "AggregateError",
  "Error",
  "PrismaClientInitializationError",
  "PrismaClientKnownRequestError",
  "PrismaClientRustPanicError",
  "PrismaClientUnknownRequestError",
  "PrismaClientValidationError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const safeInternalFailureCodes = new Map<string, string>([
  ["P2000", "prisma_value_too_long"],
  ["P2002", "prisma_unique_constraint"],
  ["P2003", "prisma_foreign_key_constraint"],
  ["P2011", "prisma_null_constraint"],
  ["P2012", "prisma_required_value_missing"],
  ["P2021", "prisma_table_missing"],
  ["P2022", "prisma_column_missing"],
  ["P2024", "prisma_connection_pool_timeout"],
  ["P2025", "prisma_record_missing"],
  ["P2028", "prisma_transaction_failed"],
  ["P2034", "prisma_transaction_conflict"],
  [
    "investigation_command_restore_invalid",
    "investigation_command_restore_invalid",
  ],
  ["investigation_concurrency_conflict", "investigation_concurrency_conflict"],
  ["investigation_idempotency_conflict", "investigation_idempotency_conflict"],
  ["investigation_lease_fencing_stale", "investigation_lease_fencing_stale"],
  ["store_snapshot_missing", "investigation_store_snapshot_missing"],
  ...[
    "investigation_conclusion_persistence_invalid",
    "investigation_finding_evidence_binding_corrupt",
    "investigation_finding_evidence_invalid",
    "investigation_finding_evidence_line_invalid",
    "investigation_finding_evidence_path_invalid",
    "investigation_inventory_closure_invalid",
    "investigation_inventory_seed_mismatch",
    "investigation_lease_attempt_stale",
    "investigation_commit_snapshot_missing",
    "investigation_command_snapshot_missing",
    "investigation_coverage_profile_unsupported",
    "investigation_immutable_identity_changed",
    "investigation_obligation_missing",
    "investigation_obligation_deletion_forbidden",
    "investigation_obligation_identity_changed",
    "investigation_obligation_receipt_missing",
    "investigation_obligation_proposal_path_hash_mismatch",
    "investigation_obligation_proposal_requirement_invalid",
    "investigation_operation_backed_discovery_evidence_invalid",
    "investigation_operation_backed_discovery_receipt_reused",
    "investigation_operation_receipt_collision",
    "investigation_operation_receipt_missing",
    "investigation_private_material_algorithm_corrupt",
    "investigation_private_material_binding_invalid",
    "investigation_private_material_conflict",
    "investigation_private_material_invalid",
    "investigation_private_material_obligation_invalid",
    "investigation_private_material_parent_missing",
    "investigation_private_material_query_mismatch",
    "investigation_private_material_required",
    "investigation_private_material_transition_invalid",
    "investigation_private_material_unavailable",
    "investigation_persisted_search_query_forbidden",
    "investigation_receipt_attestation_transition_mismatch",
    "investigation_receipt_mutation_forbidden",
    "investigation_text_search_requirement_digest_mismatch",
    "investigation_turn_attestation_invalid",
    "investigation_turn_observation_binding_invalid",
    "investigation_turn_observation_hash_mismatch",
    "investigation_turn_result_current",
    "investigation_turn_result_missing",
    "investigation_turn_result_revoked",
    "investigation_turn_result_stale",
    "investigation_turn_terminal_transition_invalid",
    "investigation_unresolvable_claim_invalid",
    "private_material_unique_conflict_missing",
  ].map((code) => [code, code] as const),
]);

export type ReviewActionV2EnabledHandler<
  Operation extends ReviewActionV2OperationId,
> = {
  readonly capabilityEnabled: true;
  readonly execute: (request: ReviewActionV2RequestMap[Operation]) => Promise<{
    readonly statusCode: number;
    readonly result: ReviewActionV2ResultMap[Operation];
  }>;
};

export function registerReviewActionV2Operation<
  Operation extends ReviewActionV2OperationId,
>(
  app: FastifyInstance,
  operationId: Operation,
  dependencies: ReviewActionV2RouteRuntimeDependencies,
  handler?: ReviewActionV2EnabledHandler<Operation>,
): void {
  const descriptor = reviewActionV2Operations.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!descriptor) {
    throw new Error(`review_action_v2_route_descriptor_missing:${operationId}`);
  }

  app.post(
    descriptor.path,
    { bodyLimit: descriptor.bodyLimitBytes },
    async (request, reply) => {
      const parsed = parseReviewActionV2Request(operationId, request.body);
      const serverTime = (await dependencies.readServerTime()).toISOString();
      const requestId = parsed.ok
        ? parsed.value.requestId
        : (parsed.requestId ?? dependencies.createRequestId());

      if (!parsed.ok) {
        return reply.code(400).send(
          createReviewActionV2ErrorResponse({
            operationId,
            requestId,
            serverTime,
            errorCode: ReviewActionV2ProtocolErrorCode.InvalidRequest,
            issues: parsed.issues,
          }),
        );
      }

      if (!handler || handler.capabilityEnabled !== true) {
        return reply.code(403).send(
          createReviewActionV2ErrorResponse({
            operationId,
            requestId,
            serverTime,
            errorCode: ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
            issues: ["capability_disabled"],
          }),
        );
      }

      try {
        const outcome = await handler.execute(parsed.value);
        if (!descriptor.successStatuses.includes(outcome.statusCode as never)) {
          throw new Error(
            `review_action_v2_success_status_invalid:${operationId}:${outcome.statusCode}`,
          );
        }
        return reply.code(outcome.statusCode).send(
          createReviewActionV2ResultResponse({
            operationId,
            requestId,
            serverTime,
            result: outcome.result,
          }),
        );
      } catch (error) {
        const failure = toSafeReviewActionV2RouteFailure(error, operationId);
        const diagnostic = {
          operationId,
          protocolErrorCode: failure.errorCode,
          protocolIssues: failure.issues,
          requestId,
          statusCode: failure.statusCode,
          ...(error instanceof ReviewActionV2RouteFailure
            ? {}
            : internalFailureDiagnostic(error)),
        };
        try {
          if (dependencies.recordProtocolRejection) {
            dependencies.recordProtocolRejection(diagnostic);
          } else {
            request.log.warn(diagnostic, "Review Action v2 request rejected");
          }
        } catch {
          // Diagnostics must never replace the safe protocol failure response.
        }
        return reply.code(failure.statusCode).send(
          createReviewActionV2ErrorResponse({
            operationId,
            requestId,
            serverTime,
            errorCode: failure.errorCode,
            issues: failure.issues,
          }),
        );
      }
    },
  );
}

function internalFailureDiagnostic(error: unknown): Readonly<{
  internalFailureClass: string;
  internalFailureCode: string;
  internalFailureCauseCode?: string;
  internalFailureStage?: ReviewActionV2InternalFailureStage;
}> {
  if (error instanceof Error) {
    const causeCode = safeInternalFailureCauseCode(error);
    const stage = safeInternalFailureStage(error);
    return Object.freeze({
      internalFailureClass: safeInternalFailureClass(error.name),
      internalFailureCode: safeInternalFailureCode(error),
      ...(causeCode === null ? {} : { internalFailureCauseCode: causeCode }),
      ...(stage === null ? {} : { internalFailureStage: stage }),
    });
  }
  return Object.freeze({
    internalFailureClass: "non_error_throwable",
    internalFailureCode: "unclassified_internal_error",
  });
}

function safeInternalFailureClass(value: string): string {
  const normalized = value.trim();
  return safeInternalFailureClasses.has(normalized) ? normalized : "Error";
}

function safeInternalFailureCode(error: Error): string {
  const rawCode = (error as Error & { code?: unknown }).code;
  const candidates = [
    typeof rawCode === "string" ? rawCode : null,
    error.message,
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const safeCode = safeInternalFailureCodes.get(candidate);
    if (safeCode !== undefined) return safeCode;
  }
  return "unclassified_internal_error";
}

function safeInternalFailureCauseCode(error: Error): string | null {
  const seen = new Set<unknown>([error]);
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
    if (seen.has(cause)) return null;
    seen.add(cause);
    const code = safeInternalFailureCode(cause);
    if (code !== "unclassified_internal_error") return code;
    cause = cause.cause;
  }
  return null;
}

function safeInternalFailureStage(
  error: Error,
): ReviewActionV2InternalFailureStage | null {
  return internalFailureStages.get(error) ?? null;
}

export function annotateReviewActionV2InternalFailure(
  error: unknown,
  stage: ReviewActionV2InternalFailureStage,
): unknown {
  if (!(error instanceof Error) || safeInternalFailureStage(error) !== null) {
    return error;
  }
  internalFailureStages.set(error, stage);
  return error;
}
