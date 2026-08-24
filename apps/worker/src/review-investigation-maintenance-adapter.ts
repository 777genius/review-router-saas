import type {
  InvestigationPrunerPort,
  ReconcileExpiredActiveTurn,
} from "@reviewrouter/features-review-investigations";
import {
  InvestigationPrivateMaterialPruneBatchError,
  type InvestigationPrivateMaterialPruneFailureCause,
} from "@reviewrouter/features-review-investigations";
import type { InvestigationShadowEvidencePrunerPort } from "@reviewrouter/features-review-evidence";

export const reviewInvestigationMaxPruneBatchSize = 1_000;

export enum ReviewInvestigationPruneFailureCode {
  ActiveTurns = "review_investigation_active_turn_recovery_failed",
  PrivateMaterial = "review_investigation_private_material_prune_failed",
  Investigations = "review_investigation_dossier_prune_failed",
  ShadowEvidence = "review_investigation_shadow_evidence_prune_failed",
}

export type ReviewInvestigationPruneOutcome = Readonly<{
  recoveredActiveTurnCount: number;
  expiredPrivateMaterialCount: number;
  prunedInvestigationCount: number;
  prunedShadowEvidenceCount: number;
}>;

export interface PruneReviewInvestigationsPort {
  execute(input: {
    readonly asOf: Date;
    readonly privateMaterialLimit: number;
    readonly investigationLimit: number;
    readonly shadowEvidenceLimit: number;
  }): Promise<ReviewInvestigationPruneOutcome>;
}

export class ReviewInvestigationPruneError extends Error {
  readonly name = "ReviewInvestigationPruneError";

  constructor(
    readonly code: ReviewInvestigationPruneFailureCode,
    readonly outcome: ReviewInvestigationPruneOutcome,
    readonly causeCode: InvestigationPrivateMaterialPruneFailureCause | null,
    readonly failureCodes: readonly ReviewInvestigationPruneFailureCode[] = [
      code,
    ],
    readonly failedInvestigationCount: number = 0,
  ) {
    super(code);
  }
}

export class InvestigationPrunerMaintenanceAdapter implements PruneReviewInvestigationsPort {
  constructor(
    private readonly dependencies: Readonly<{
      privateMaterial: Pick<
        InvestigationPrunerPort,
        "reconcileExpiredPrivateMaterial"
      >;
      expiredTurns: Pick<ReconcileExpiredActiveTurn, "sweep">;
      investigations: Pick<
        InvestigationPrunerPort,
        "pruneRetainedInvestigations"
      >;
      shadowEvidence: InvestigationShadowEvidencePrunerPort;
    }>,
  ) {}

  async execute(input: {
    readonly asOf: Date;
    readonly privateMaterialLimit: number;
    readonly investigationLimit: number;
    readonly shadowEvidenceLimit: number;
  }): Promise<ReviewInvestigationPruneOutcome> {
    assertValidDate(input.asOf);
    assertPruneLimit(input.privateMaterialLimit);
    assertPruneLimit(input.investigationLimit);
    assertPruneLimit(input.shadowEvidenceLimit);
    const cutoff = input.asOf.toISOString();

    let recoveredActiveTurnCount = 0;
    let expiredPrivateMaterialCount = 0;
    let prunedInvestigationCount = 0;
    let prunedShadowEvidenceCount = 0;
    let failedPrivateMaterialInvestigationCount = 0;
    const failures: Array<
      Readonly<{
        code: ReviewInvestigationPruneFailureCode;
        causeCode: InvestigationPrivateMaterialPruneFailureCause | null;
      }>
    > = [];

    try {
      recoveredActiveTurnCount = await this.dependencies.expiredTurns.sweep({
        expiresAtOrBefore: cutoff,
        limit: input.investigationLimit,
      });
    } catch {
      failures.push({
        code: ReviewInvestigationPruneFailureCode.ActiveTurns,
        causeCode: null,
      });
    }

    try {
      expiredPrivateMaterialCount =
        await this.dependencies.privateMaterial.reconcileExpiredPrivateMaterial(
          {
            expiresAtOrBefore: cutoff,
            limit: input.privateMaterialLimit,
          },
        );
    } catch (error: unknown) {
      if (error instanceof InvestigationPrivateMaterialPruneBatchError) {
        expiredPrivateMaterialCount = error.removedCount;
        failedPrivateMaterialInvestigationCount =
          error.failedInvestigationCount;
      }
      failures.push({
        code: ReviewInvestigationPruneFailureCode.PrivateMaterial,
        causeCode:
          error instanceof InvestigationPrivateMaterialPruneBatchError
            ? error.causeCode
            : null,
      });
    }

    try {
      prunedInvestigationCount =
        await this.dependencies.investigations.pruneRetainedInvestigations({
          retainUntilOrBefore: cutoff,
          limit: input.investigationLimit,
        });
    } catch {
      failures.push({
        code: ReviewInvestigationPruneFailureCode.Investigations,
        causeCode: null,
      });
    }

    try {
      prunedShadowEvidenceCount = await this.dependencies.shadowEvidence.prune({
        retainUntilOrBeforeMs: input.asOf.getTime(),
        limit: input.shadowEvidenceLimit,
      });
    } catch {
      failures.push({
        code: ReviewInvestigationPruneFailureCode.ShadowEvidence,
        causeCode: null,
      });
    }

    const outcome = {
      recoveredActiveTurnCount,
      expiredPrivateMaterialCount,
      prunedInvestigationCount,
      prunedShadowEvidenceCount,
    };
    const firstFailure = failures[0];
    if (firstFailure !== undefined) {
      throw new ReviewInvestigationPruneError(
        firstFailure.code,
        outcome,
        firstFailure.causeCode,
        Object.freeze(failures.map((failure) => failure.code)),
        failedPrivateMaterialInvestigationCount,
      );
    }
    return outcome;
  }
}

function assertValidDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("review_investigation_prune_cutoff_invalid");
  }
}

function assertPruneLimit(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > reviewInvestigationMaxPruneBatchSize
  ) {
    throw new Error("review_investigation_prune_limit_invalid");
  }
}
