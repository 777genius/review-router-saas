import type { InvestigationPrunerPort } from "@reviewrouter/features-review-investigations";
import type { InvestigationShadowEvidencePrunerPort } from "@reviewrouter/features-review-evidence";

export const reviewInvestigationMaxPruneBatchSize = 1_000;

export enum ReviewInvestigationPruneFailureCode {
  PrivateMaterial = "review_investigation_private_material_prune_failed",
  Investigations = "review_investigation_dossier_prune_failed",
  ShadowEvidence = "review_investigation_shadow_evidence_prune_failed",
}

export type ReviewInvestigationPruneOutcome = Readonly<{
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

    let expiredPrivateMaterialCount: number;
    try {
      expiredPrivateMaterialCount =
        await this.dependencies.privateMaterial.reconcileExpiredPrivateMaterial(
          {
            expiresAtOrBefore: cutoff,
            limit: input.privateMaterialLimit,
          },
        );
    } catch {
      throw new ReviewInvestigationPruneError(
        ReviewInvestigationPruneFailureCode.PrivateMaterial,
        emptyOutcome(),
      );
    }

    let prunedInvestigationCount: number;
    try {
      prunedInvestigationCount =
        await this.dependencies.investigations.pruneRetainedInvestigations({
          retainUntilOrBefore: cutoff,
          limit: input.investigationLimit,
        });
    } catch {
      throw new ReviewInvestigationPruneError(
        ReviewInvestigationPruneFailureCode.Investigations,
        {
          expiredPrivateMaterialCount,
          prunedInvestigationCount: 0,
          prunedShadowEvidenceCount: 0,
        },
      );
    }

    try {
      const prunedShadowEvidenceCount =
        await this.dependencies.shadowEvidence.prune({
          retainUntilOrBeforeMs: input.asOf.getTime(),
          limit: input.shadowEvidenceLimit,
        });
      return {
        expiredPrivateMaterialCount,
        prunedInvestigationCount,
        prunedShadowEvidenceCount,
      };
    } catch {
      throw new ReviewInvestigationPruneError(
        ReviewInvestigationPruneFailureCode.ShadowEvidence,
        {
          expiredPrivateMaterialCount,
          prunedInvestigationCount,
          prunedShadowEvidenceCount: 0,
        },
      );
    }
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

function emptyOutcome(): ReviewInvestigationPruneOutcome {
  return {
    expiredPrivateMaterialCount: 0,
    prunedInvestigationCount: 0,
    prunedShadowEvidenceCount: 0,
  };
}
