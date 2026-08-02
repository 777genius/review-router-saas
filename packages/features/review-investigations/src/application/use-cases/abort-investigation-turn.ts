import { canonicalJson } from "../../domain/canonicalization";
import { abortInvestigationTurn } from "../../domain/review-investigation";
import type { ReviewInvestigationAbortReason } from "../../domain/review-investigation-types";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
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
  restoreCommandOrThrow,
  withCurrentDossierDigest,
} from "./investigation-use-case-support";

export type AbortInvestigationTurnCommand = Readonly<{
  commandId: string;
  investigationId: string;
  expectedVersion: number;
  turnId: string;
  reason: ReviewInvestigationAbortReason;
  nextEligibleAt: string | null;
}>;

export class AbortInvestigationTurn {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
  ) {}

  async execute(
    command: AbortInvestigationTurnCommand,
  ): Promise<ReviewInvestigationReadModel> {
    const commandHash = await this.digest.digestUtf8(
      canonicalJson({ operation: "abort_investigation_turn", command }),
    );
    const restored = await restoreCommandOrThrow({
      store: this.store,
      commandId: command.commandId,
      commandHash,
    });
    if (restored) return toInvestigationReadModel(restored);
    const current = await this.store.findById(command.investigationId);
    if (current === null) throw new Error("investigation_missing");
    if (current.version !== command.expectedVersion) {
      throw new Error("investigation_concurrency_conflict");
    }
    let next = abortInvestigationTurn({
      investigation: current,
      abort: {
        turnId: command.turnId,
        reason: command.reason,
        nextEligibleAt: command.nextEligibleAt,
      },
      abortedAt: this.clock.now().toISOString(),
    });
    next = await withCurrentDossierDigest(this.digest, next);
    const committed = await commitOrThrow({
      store: this.store,
      investigation: next,
      expectedVersion: current.version,
      commandId: command.commandId,
      commandHash,
      transition: {
        kind: InvestigationStoreTransitionKind.TurnAborted,
        turnId: command.turnId,
        reason: command.reason,
      },
    });
    return toInvestigationReadModel(committed);
  }
}
