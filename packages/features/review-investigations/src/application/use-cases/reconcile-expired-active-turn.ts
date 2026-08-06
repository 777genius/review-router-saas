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
  InvestigationStoreCommitGuardKind,
  InvestigationStoreTransitionKind,
  type InvestigationStorePort,
} from "../ports/investigation-store-port";
import { issueReplayEvidenceCheckpoint } from "../replay-evidence-checkpoint-issuer";
import {
  commitOrThrow,
  requireValidDossierDigest,
  withCurrentDossierDigest,
} from "./investigation-use-case-support";

export class ReconcileExpiredActiveTurn {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
    private readonly replayCheckpointTtlMs = 3_600_000,
  ) {}

  async execute(investigationId: string): Promise<ReviewInvestigation> {
    const current = await this.store.findById(investigationId);
    if (current === null) throw new Error("investigation_missing");
    await requireValidDossierDigest(this.digest, current);
    const turn = current.activeTurn;
    if (turn === null || new Date(turn.expiresAt) > this.clock.now()) {
      return current;
    }
    const verdict = await this.authority.check(current);
    const reconciled = reconcileExpiredActiveTurn({
      investigation: current,
      reconciledAt: this.clock.now().toISOString(),
      superseded:
        verdict === InvestigationExecutionAuthorityVerdict.Superseded ||
        verdict === InvestigationExecutionAuthorityVerdict.Missing ||
        verdict === InvestigationExecutionAuthorityVerdict.Unauthorized,
    });
    if (
      reconciled.disposition ===
      ExpiredActiveTurnReconciliationDisposition.Unchanged
    ) {
      return current;
    }
    let next = reconciled.investigation;
    if (
      reconciled.disposition ===
      ExpiredActiveTurnReconciliationDisposition.Superseded
    ) {
      next = {
        ...next,
        replayEvidenceCheckpoint: await issueReplayEvidenceCheckpoint({
          source: current,
          sourceState: next.state,
          sourceConclusion: next.conclusion,
          sourceVersion: next.version,
          issuedAt: this.clock.now(),
          ttlMs: this.replayCheckpointTtlMs,
          digest: this.digest,
        }),
      };
    }
    next = await withCurrentDossierDigest(this.digest, next);
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
      guard: {
        kind: InvestigationStoreCommitGuardKind.ExpiredActiveTurn,
        expectedVerdict: verdict,
        turnId: turn.turnId,
        expiresAt: turn.expiresAt,
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
          ![
            "investigation_concurrency_conflict",
            "investigation_lease_fencing_stale",
          ].includes(error.message)
        ) {
          throw error;
        }
      }
    }
    return reconciled;
  }
}
