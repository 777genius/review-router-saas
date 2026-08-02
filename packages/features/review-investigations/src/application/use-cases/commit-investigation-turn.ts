import { canonicalJson } from "../../domain/canonicalization";
import type { SeedInvestigationObligation } from "../../domain/coverage-contract";
import {
  createInvestigationObligation,
  obligationIdentity,
  type InvestigationEvidenceReceipt,
} from "../../domain/investigation-obligation";
import {
  commitInvestigationTurn,
  proposalOriginForTurn,
} from "../../domain/review-investigation";
import type { InvestigationFinding } from "../../domain/investigation-turn";
import type { ContextCriticDecision } from "../../domain/review-investigation-types";
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
  digestCanonical,
  requireCurrentExecution,
  restoreCommandOrThrow,
  withCurrentDossierDigest,
} from "./investigation-use-case-support";

export type CommitInvestigationTurnCommand = Readonly<{
  commandId: string;
  investigationId: string;
  expectedVersion: number;
  turnId: string;
  closureClaims: readonly Readonly<{
    obligationId: string;
    receipt: InvestigationEvidenceReceipt;
  }>[];
  unresolvableDecisions: readonly Readonly<{
    obligationId: string;
    reason: string;
    deterministicPolicy: boolean;
  }>[];
  proposals: readonly SeedInvestigationObligation[];
  findings: readonly InvestigationFinding[];
  criticDecision: ContextCriticDecision | null;
  usageTokens: number;
  durationMs: number;
}>;

export class CommitInvestigationTurn {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
  ) {}

  async execute(
    command: CommitInvestigationTurnCommand,
  ): Promise<ReviewInvestigationReadModel> {
    const commandHash = await this.digest.digestUtf8(
      canonicalJson({ operation: "commit_investigation_turn", command }),
    );
    const restored = await restoreCommandOrThrow({
      store: this.store,
      commandId: command.commandId,
      commandHash,
    });
    if (restored) return toInvestigationReadModel(restored);
    const current = await this.store.findById(command.investigationId);
    if (current === null) throw new Error("investigation_missing");
    if (current.version !== command.expectedVersion || current.activeTurn === null) {
      throw new Error("investigation_concurrency_conflict");
    }
    await requireCurrentExecution({ authority: this.authority, investigation: current });
    const origin = proposalOriginForTurn(current.activeTurn.purpose);
    const proposedObligations = await Promise.all(
      command.proposals.map(async (proposal) => {
        const identity = obligationIdentity({
          coverageContractVersion: current.contract.coverageContractVersion,
          stableReviewUnitKey: current.stableReviewUnitKey,
          kind: proposal.kind,
          canonicalSubject: proposal.canonicalSubject,
          canonicalRequirement: proposal.canonicalRequirement,
        });
        return createInvestigationObligation({
          obligationId: await digestCanonical(this.digest, { ...identity }),
          identity,
          riskPriority: proposal.riskPriority,
          origin,
        });
      }),
    );
    let next = commitInvestigationTurn({
      investigation: current,
      commit: {
        turnId: command.turnId,
        closureClaims: command.closureClaims,
        unresolvableDecisions: command.unresolvableDecisions,
        proposedObligations,
        findings: command.findings,
        criticDecision: command.criticDecision,
        usageTokens: command.usageTokens,
        durationMs: command.durationMs,
      },
      committedAt: this.clock.now().toISOString(),
    });
    next = await withCurrentDossierDigest(this.digest, next);
    const committed = await commitOrThrow({
      store: this.store,
      investigation: next,
      expectedVersion: current.version,
      commandId: command.commandId,
      commandHash,
      transition: {
        kind: InvestigationStoreTransitionKind.TurnCommitted,
        turnId: command.turnId,
        acceptedAttestationId: null,
        sanitizedOutcomeHash: null,
      },
    });
    return toInvestigationReadModel(committed);
  }
}
