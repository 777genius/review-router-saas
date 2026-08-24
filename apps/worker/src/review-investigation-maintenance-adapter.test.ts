import { describe, expect, it } from "vitest";
import {
  InvestigationPrivateMaterialPruneBatchError,
  InvestigationPrivateMaterialPruneFailureCause,
  type InvestigationPrunerPort,
} from "@reviewrouter/features-review-investigations";
import type { InvestigationShadowEvidencePrunerPort } from "@reviewrouter/features-review-evidence";
import {
  InvestigationPrunerMaintenanceAdapter,
  ReviewInvestigationPruneError,
  ReviewInvestigationPruneFailureCode,
  reviewInvestigationMaxPruneBatchSize,
} from "./review-investigation-maintenance-adapter";

const asOf = new Date("2026-08-03T12:00:00.000Z");

class CapturingPruner
  implements InvestigationPrunerPort, InvestigationShadowEvidencePrunerPort
{
  readonly calls: string[] = [];
  readonly privateMaterialInputs: Array<{
    readonly expiresAtOrBefore: string;
    readonly limit: number;
  }> = [];
  readonly investigationInputs: Array<{
    readonly retainUntilOrBefore: string;
    readonly limit: number;
  }> = [];
  readonly shadowEvidenceInputs: Array<{
    readonly retainUntilOrBeforeMs: number;
    readonly limit: number;
  }> = [];
  privateMaterialResults = [2];
  investigationResults = [1];
  shadowEvidenceResults = [3];
  activeTurnResults = [1];
  privateMaterialError: Error | null = null;
  investigationError: Error | null = null;
  shadowEvidenceError: Error | null = null;
  activeTurnError: Error | null = null;

  async sweep(): Promise<number> {
    this.calls.push("active_turns");
    if (this.activeTurnError) throw this.activeTurnError;
    return this.activeTurnResults.shift() ?? 0;
  }

  async reconcileExpiredPrivateMaterial(input: {
    readonly expiresAtOrBefore: string;
    readonly limit: number;
  }): Promise<number> {
    this.calls.push("private_material");
    this.privateMaterialInputs.push(input);
    if (this.privateMaterialError) throw this.privateMaterialError;
    return this.privateMaterialResults.shift() ?? 0;
  }

  async pruneRetainedInvestigations(input: {
    readonly retainUntilOrBefore: string;
    readonly limit: number;
  }): Promise<number> {
    this.calls.push("investigations");
    this.investigationInputs.push(input);
    if (this.investigationError) throw this.investigationError;
    return this.investigationResults.shift() ?? 0;
  }

  async prune(input: {
    readonly retainUntilOrBeforeMs: number;
    readonly limit: number;
  }): Promise<number> {
    this.calls.push("shadow_evidence");
    this.shadowEvidenceInputs.push(input);
    if (this.shadowEvidenceError) throw this.shadowEvidenceError;
    return this.shadowEvidenceResults.shift() ?? 0;
  }
}

describe("review investigation maintenance adapter", () => {
  it("reconciles one bounded private-material batch before pruning dossiers and shadow evidence", async () => {
    const pruner = new CapturingPruner();
    pruner.privateMaterialResults = [2, 0];
    pruner.investigationResults = [1, 0];
    pruner.shadowEvidenceResults = [3, 0];
    const adapter = createAdapter(pruner);

    await expect(
      adapter.execute({
        asOf,
        privateMaterialLimit: 100,
        investigationLimit: 25,
        shadowEvidenceLimit: 50,
      }),
    ).resolves.toEqual({
      recoveredActiveTurnCount: 1,
      expiredPrivateMaterialCount: 2,
      prunedInvestigationCount: 1,
      prunedShadowEvidenceCount: 3,
    });
    await expect(
      adapter.execute({
        asOf,
        privateMaterialLimit: 100,
        investigationLimit: 25,
        shadowEvidenceLimit: 50,
      }),
    ).resolves.toEqual({
      recoveredActiveTurnCount: 0,
      expiredPrivateMaterialCount: 0,
      prunedInvestigationCount: 0,
      prunedShadowEvidenceCount: 0,
    });

    expect(pruner.calls).toEqual([
      "active_turns",
      "private_material",
      "investigations",
      "shadow_evidence",
      "active_turns",
      "private_material",
      "investigations",
      "shadow_evidence",
    ]);
    expect(pruner.privateMaterialInputs).toEqual([
      { expiresAtOrBefore: asOf.toISOString(), limit: 100 },
      { expiresAtOrBefore: asOf.toISOString(), limit: 100 },
    ]);
    expect(pruner.investigationInputs).toEqual([
      { retainUntilOrBefore: asOf.toISOString(), limit: 25 },
      { retainUntilOrBefore: asOf.toISOString(), limit: 25 },
    ]);
    expect(pruner.shadowEvidenceInputs).toEqual([
      { retainUntilOrBeforeMs: asOf.getTime(), limit: 50 },
      { retainUntilOrBeforeMs: asOf.getTime(), limit: 50 },
    ]);
  });

  it("fails before either port when the cutoff or a batch bound is invalid", async () => {
    const pruner = new CapturingPruner();
    const adapter = createAdapter(pruner);
    const invalidInputs = [
      {
        asOf: new Date(Number.NaN),
        privateMaterialLimit: 10,
        investigationLimit: 10,
        shadowEvidenceLimit: 10,
      },
      {
        asOf,
        privateMaterialLimit: 0,
        investigationLimit: 10,
        shadowEvidenceLimit: 10,
      },
      {
        asOf,
        privateMaterialLimit: 10,
        investigationLimit: reviewInvestigationMaxPruneBatchSize + 1,
        shadowEvidenceLimit: 10,
      },
      {
        asOf,
        privateMaterialLimit: 10,
        investigationLimit: 10,
        shadowEvidenceLimit: reviewInvestigationMaxPruneBatchSize + 1,
      },
    ];

    for (const input of invalidInputs) {
      await expect(adapter.execute(input)).rejects.toThrow(
        /review_investigation_prune_/,
      );
    }
    expect(pruner.calls).toEqual([]);
  });

  it("reports the failed stage with only count-based partial progress", async () => {
    const privateMaterialFailure = new CapturingPruner();
    privateMaterialFailure.privateMaterialError = new Error(
      "private query payload must stay secret",
    );
    await expect(
      createAdapter(privateMaterialFailure).execute({
        asOf,
        privateMaterialLimit: 10,
        investigationLimit: 10,
        shadowEvidenceLimit: 10,
      }),
    ).rejects.toMatchObject({
      code: ReviewInvestigationPruneFailureCode.PrivateMaterial,
      causeCode: null,
      outcome: {
        recoveredActiveTurnCount: 1,
        expiredPrivateMaterialCount: 0,
        prunedInvestigationCount: 1,
        prunedShadowEvidenceCount: 3,
      },
    } satisfies Partial<ReviewInvestigationPruneError>);
    expect(privateMaterialFailure.calls).toEqual([
      "active_turns",
      "private_material",
      "investigations",
      "shadow_evidence",
    ]);

    const investigationFailure = new CapturingPruner();
    investigationFailure.privateMaterialResults = [3];
    investigationFailure.investigationError = new Error(
      "dossier payload must stay secret",
    );
    await expect(
      createAdapter(investigationFailure).execute({
        asOf,
        privateMaterialLimit: 10,
        investigationLimit: 10,
        shadowEvidenceLimit: 10,
      }),
    ).rejects.toMatchObject({
      code: ReviewInvestigationPruneFailureCode.Investigations,
      causeCode: null,
      outcome: {
        recoveredActiveTurnCount: 1,
        expiredPrivateMaterialCount: 3,
        prunedInvestigationCount: 0,
        prunedShadowEvidenceCount: 3,
      },
    } satisfies Partial<ReviewInvestigationPruneError>);

    const shadowFailure = new CapturingPruner();
    shadowFailure.privateMaterialResults = [4];
    shadowFailure.investigationResults = [2];
    shadowFailure.shadowEvidenceError = new Error(
      "shadow payload must stay secret",
    );
    await expect(
      createAdapter(shadowFailure).execute({
        asOf,
        privateMaterialLimit: 10,
        investigationLimit: 10,
        shadowEvidenceLimit: 10,
      }),
    ).rejects.toMatchObject({
      code: ReviewInvestigationPruneFailureCode.ShadowEvidence,
      causeCode: null,
      outcome: {
        recoveredActiveTurnCount: 1,
        expiredPrivateMaterialCount: 4,
        prunedInvestigationCount: 2,
        prunedShadowEvidenceCount: 0,
      },
    } satisfies Partial<ReviewInvestigationPruneError>);
  });

  it("preserves partial private-material progress and an allowlisted cause", async () => {
    const pruner = new CapturingPruner();
    pruner.privateMaterialError =
      new InvestigationPrivateMaterialPruneBatchError(
        7,
        1,
        InvestigationPrivateMaterialPruneFailureCause.AggregateIncompatible,
      );

    await expect(
      createAdapter(pruner).execute({
        asOf,
        privateMaterialLimit: 10,
        investigationLimit: 10,
        shadowEvidenceLimit: 10,
      }),
    ).rejects.toMatchObject({
      code: ReviewInvestigationPruneFailureCode.PrivateMaterial,
      failureCodes: [ReviewInvestigationPruneFailureCode.PrivateMaterial],
      causeCode:
        InvestigationPrivateMaterialPruneFailureCause.AggregateIncompatible,
      failedInvestigationCount: 1,
      outcome: {
        recoveredActiveTurnCount: 1,
        expiredPrivateMaterialCount: 7,
        prunedInvestigationCount: 1,
        prunedShadowEvidenceCount: 3,
      },
    } satisfies Partial<ReviewInvestigationPruneError>);
    expect(pruner.calls).toEqual([
      "active_turns",
      "private_material",
      "investigations",
      "shadow_evidence",
    ]);
  });
});

function createAdapter(
  pruner: InvestigationPrunerPort &
    InvestigationShadowEvidencePrunerPort & { sweep(): Promise<number> },
) {
  return new InvestigationPrunerMaintenanceAdapter({
    expiredTurns: pruner,
    privateMaterial: pruner,
    investigations: pruner,
    shadowEvidence: pruner,
  });
}
