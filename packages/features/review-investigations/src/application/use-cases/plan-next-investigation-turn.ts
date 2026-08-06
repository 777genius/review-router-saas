import { canonicalJson } from "../../domain/canonicalization";
import { planInvestigationTurn } from "../../domain/review-investigation";
import type { InvestigationTurn } from "../../domain/investigation-turn";
import {
  InvestigationObligationKind,
  InvestigationObligationState,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
} from "../../domain/review-investigation-types";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationExecutionAuthorityPort } from "../ports/execution-authority-port";
import {
  InvestigationStoreTransitionKind,
  type InvestigationStorePort,
} from "../ports/investigation-store-port";
import {
  toInvestigationReadModel,
  type ReviewInvestigationReadModel,
} from "../investigation-read-model";
import {
  commitOrThrow,
  requireCurrentExecution,
  requireValidDossierDigest,
  restoreCommandOrThrow,
  withCurrentDossierDigest,
} from "./investigation-use-case-support";
import type { ReconcileExpiredActiveTurn } from "./reconcile-expired-active-turn";

export type PlanNextInvestigationTurnCommand = Readonly<{
  commandId: string;
  investigationId: string;
  expectedVersion: number;
  leaseDurationMs: number;
  maxObligationsForTurn: number;
}>;

export class PlanNextInvestigationTurn {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
    private readonly expiredTurns?: Pick<ReconcileExpiredActiveTurn, "execute">,
  ) {}

  async execute(
    command: PlanNextInvestigationTurnCommand,
  ): Promise<ReviewInvestigationReadModel> {
    if (this.expiredTurns) {
      await this.expiredTurns.execute(command.investigationId);
    }
    const commandHash = await this.digest.digestUtf8(
      canonicalJson({ operation: "plan_next_investigation_turn", command }),
    );
    const restored = await restoreCommandOrThrow({
      store: this.store,
      commandId: command.commandId,
      commandHash,
    });
    if (restored) return toInvestigationReadModel(restored);
    const current = await this.store.findById(command.investigationId);
    if (current === null) throw new Error("investigation_missing");
    await requireValidDossierDigest(this.digest, current);
    if (current.version !== command.expectedVersion) {
      throw new Error("investigation_concurrency_conflict");
    }
    await requireCurrentExecution({
      authority: this.authority,
      investigation: current,
    });
    if (
      !Number.isSafeInteger(command.leaseDurationMs) ||
      command.leaseDurationMs <= 0
    ) {
      throw new Error("turn_lease_duration_invalid");
    }
    if (
      !Number.isSafeInteger(command.maxObligationsForTurn) ||
      command.maxObligationsForTurn <= 0
    ) {
      throw new Error("turn_obligation_limit_invalid");
    }
    const now = this.clock.now();
    if (
      current.nextEligibleAt !== null &&
      new Date(current.nextEligibleAt).getTime() > now.getTime()
    ) {
      return toInvestigationReadModel(current);
    }
    const purpose =
      current.state === ReviewInvestigationState.AwaitingCritic
        ? ReviewInvestigationTurnPurpose.Critic
        : ReviewInvestigationTurnPurpose.Discovery;
    const obligationIds = current.obligations
      .filter((item) => item.state === InvestigationObligationState.Open)
      .filter(
        (item) =>
          current.state !== ReviewInvestigationState.Provisional ||
          item.kind === InvestigationObligationKind.InventoryWitness,
      )
      .sort(
        (left, right) =>
          right.riskPriority - left.riskPriority ||
          left.obligationId.localeCompare(right.obligationId),
      )
      .slice(0, command.maxObligationsForTurn)
      .map((item) => item.obligationId);
    const turnIdentity = canonicalJson({
      investigationId: current.investigationId,
      nextVersion: current.version + 1,
      dossierDigest: current.dossierDigest,
      purpose,
    });
    const turn: InvestigationTurn = {
      turnId: `turn-${(await this.digest.digestUtf8(turnIdentity)).slice(0, 32)}`,
      purpose,
      leasedAtVersion: current.version + 1,
      dossierDigest: current.dossierDigest,
      obligationIds,
      semanticTurnOrdinal:
        current.semanticTurns +
        (purpose === ReviewInvestigationTurnPurpose.Discovery ? 1 : 0),
      criticCycleOrdinal:
        current.criticCycles +
        (purpose === ReviewInvestigationTurnPurpose.Critic ? 1 : 0),
      leasedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + command.leaseDurationMs,
      ).toISOString(),
    };
    let next = planInvestigationTurn({ investigation: current, turn });
    next = await withCurrentDossierDigest(this.digest, next);
    const committed = await commitOrThrow({
      store: this.store,
      investigation: next,
      expectedVersion: current.version,
      commandId: command.commandId,
      commandHash,
      transition: {
        kind: InvestigationStoreTransitionKind.TurnPlanned,
        turnId: turn.turnId,
      },
    });
    return toInvestigationReadModel(committed);
  }
}
