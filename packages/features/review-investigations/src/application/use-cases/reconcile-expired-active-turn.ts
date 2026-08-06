import { canonicalJson } from "../../domain/canonicalization";
import {
  ExpiredActiveTurnReconciliationDisposition,
  reconcileExpiredActiveTurn,
  type ReviewInvestigation,
} from "../../domain/review-investigation";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import {
  InvestigationExecutionAuthorityVerdict,
  type InvestigationExecutionAuthorityPort,
} from "../ports/execution-authority-port";
import {
  InvestigationStoreTransitionKind,
  type InvestigationStorePort,
} from "../ports/investigation-store-port";
import {
  commitOrThrow,
  withCurrentDossierDigest,
} from "./investigation-use-case-support";

export class ReconcileExpiredActiveTurn {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
  ) {}

  async execute(investigationId: string): Promise<ReviewInvestigation> {
    const current = await this.store.findById(investigationId);
    if (current === null) throw new Error("investigation_missing");
    const turn = current.activeTurn;
    if (turn === null || new Date(turn.expiresAt) > this.clock.now()) {
      return current;
    }
    const verdict = await this.authority.check(current);
    if (verdict === InvestigationExecutionAuthorityVerdict.Unauthorized) {
      throw new Error("investigation_execution_unauthorized");
    }
    const reconciled = reconcileExpiredActiveTurn({
      investigation: current,
      reconciledAt: turn.expiresAt,
      superseded:
        verdict === InvestigationExecutionAuthorityVerdict.Superseded ||
        verdict === InvestigationExecutionAuthorityVerdict.Missing,
    });
    if (
      reconciled.disposition ===
      ExpiredActiveTurnReconciliationDisposition.Unchanged
    ) {
      return current;
    }
    const next = await withCurrentDossierDigest(
      this.digest,
      reconciled.investigation,
    );
    const commandHash = await this.digest.digestUtf8(
      canonicalJson({
        operation: "reconcile_expired_active_turn",
        investigationId,
        expectedVersion: current.version,
        turnId: turn.turnId,
        expiresAt: turn.expiresAt,
        authority: verdict,
      }),
    );
    return commitOrThrow({
      store: this.store,
      investigation: next,
      expectedVersion: current.version,
      commandId: `reconcile-expired-turn:${investigationId}:${turn.turnId}`,
      commandHash,
      transition: {
        kind: InvestigationStoreTransitionKind.ActiveTurnExpired,
        turnId: turn.turnId,
      },
    });
  }

  async sweep(input: {
    readonly expiresAtOrBefore: string;
    readonly limit: number;
  }): Promise<number> {
    const ids = await this.store.findExpiredActiveTurnIds(input);
    let reconciled = 0;
    for (const investigationId of ids) {
      try {
        const before = await this.store.findById(investigationId);
        const after = await this.execute(investigationId);
        if (before !== null && after.version !== before.version)
          reconciled += 1;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "investigation_concurrency_conflict"
        ) {
          throw error;
        }
      }
    }
    return reconciled;
  }
}
