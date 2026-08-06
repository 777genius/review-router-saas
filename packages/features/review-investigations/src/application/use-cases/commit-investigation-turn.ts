import { canonicalJson } from "../../domain/canonicalization";
import type { SeedInvestigationObligation } from "../../domain/coverage-contract";
import {
  createInvestigationObligation,
  InvestigationObligationOrigin,
  obligationIdentity,
  type InvestigationEvidenceReceipt,
} from "../../domain/investigation-obligation";
import {
  commitHistoricalInvestigationTurn,
  commitInvestigationTurn,
  proposalOriginForTurn,
} from "../../domain/review-investigation";
import type {
  InvestigationFinding,
  InvestigationTurnProvenance,
} from "../../domain/investigation-turn";
import type { ContextCriticDecision } from "../../domain/review-investigation-types";
import {
  decideTurnResultAdmission,
  TurnResultAdmissionKind,
  TurnResultAuthority,
} from "../../domain/turn-result-admission";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import {
  InvestigationExecutionAuthorityVerdict,
  type InvestigationExecutionAuthorityPort,
} from "../ports/execution-authority-port";
import {
  type InvestigationStoreCommitGuard,
  InvestigationStoreTransitionKind,
  type InvestigationStorePort,
} from "../ports/investigation-store-port";
import {
  toInvestigationReadModel,
  type ReviewInvestigationReadModel,
} from "../investigation-read-model";
import { issueReplayEvidenceCheckpoint } from "../replay-evidence-checkpoint-issuer";
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
  deterministicExpansions?: readonly SeedInvestigationObligation[];
  findings: readonly InvestigationFinding[];
  acceptedEvidenceReceiptIds?: readonly string[];
  criticDecision: ContextCriticDecision | null;
  usageTokens: number;
  durationMs: number;
  acceptedAttestationId?: string | null;
  sanitizedOutcomeHash?: string | null;
  provenance?: InvestigationTurnProvenance | null;
  idempotencyHash?: string;
  storeCommitGuard?: InvestigationStoreCommitGuard;
  resultDeadlines?: readonly string[];
  admittedAt?: string;
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
    const { idempotencyHash, ...commandForHash } = command;
    const commandHash =
      idempotencyHash ??
      (await this.digest.digestUtf8(
        canonicalJson({
          operation: "commit_investigation_turn",
          command: commandForHash,
        }),
      ));
    const restored = await restoreCommandOrThrow({
      store: this.store,
      commandId: command.commandId,
      commandHash,
    });
    if (restored) return toInvestigationReadModel(restored);
    const current = await this.store.findById(command.investigationId);
    if (current === null) throw new Error("investigation_missing");
    if (
      current.version !== command.expectedVersion ||
      current.activeTurn === null
    ) {
      throw new Error("investigation_concurrency_conflict");
    }
    const authorityVerdict = await this.authority.check(current);
    const admittedAt = command.admittedAt ?? this.clock.now().toISOString();
    const admission = command.resultDeadlines
      ? decideTurnResultAdmission({
          authority: resultAuthority(authorityVerdict),
          admittedAt,
          deadlines: [current.activeTurn.expiresAt, ...command.resultDeadlines],
        })
      : null;
    if (admission === null) {
      await requireCurrentExecution({
        authority: this.authority,
        investigation: current,
      });
    } else if (admission.kind === TurnResultAdmissionKind.Rejected) {
      throw new Error(`investigation_turn_result_${authorityVerdict}`);
    }
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
    const deterministicObligations = await Promise.all(
      (command.deterministicExpansions ?? []).map(async (proposal) => {
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
          origin: InvestigationObligationOrigin.DeterministicExpansion,
        });
      }),
    );
    const isHistoricalDrain =
      admission?.kind === TurnResultAdmissionKind.HistoricalDrain;
    let next = (
      isHistoricalDrain
        ? commitHistoricalInvestigationTurn
        : commitInvestigationTurn
    )({
      investigation: current,
      commit: {
        turnId: command.turnId,
        closureClaims: command.closureClaims,
        unresolvableDecisions: command.unresolvableDecisions,
        proposedObligations: [
          ...deterministicObligations,
          ...proposedObligations,
        ],
        findings: command.findings,
        acceptedEvidenceReceiptIds: command.acceptedEvidenceReceiptIds ?? [],
        criticDecision: command.criticDecision,
        usageTokens: command.usageTokens,
        durationMs: command.durationMs,
        provenance: command.provenance ?? null,
      },
      committedAt: admittedAt,
    });
    if (isHistoricalDrain) {
      next = await withCurrentDossierDigest(this.digest, next);
      next = {
        ...next,
        replayEvidenceCheckpoint: await issueReplayEvidenceCheckpoint({
          source: next,
          sourceState: next.state,
          sourceConclusion: next.conclusion,
          sourceVersion: next.version,
          issuedAt: new Date(admittedAt),
          ttlMs: Math.max(
            1,
            Date.parse(admission.effectiveDeadline) - Date.parse(admittedAt),
          ),
          digest: this.digest,
        }),
      };
    }
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
        acceptedAttestationId: command.acceptedAttestationId ?? null,
        sanitizedOutcomeHash: command.sanitizedOutcomeHash ?? null,
      },
      ...(command.storeCommitGuard === undefined
        ? {}
        : {
            guard:
              admission === null
                ? command.storeCommitGuard
                : {
                    ...command.storeCommitGuard,
                    resultAdmission: admission.kind,
                    admittedAt,
                    effectiveDeadline: admission.effectiveDeadline,
                  },
          }),
    });
    return toInvestigationReadModel(committed);
  }
}

function resultAuthority(
  verdict: InvestigationExecutionAuthorityVerdict,
): TurnResultAuthority {
  switch (verdict) {
    case InvestigationExecutionAuthorityVerdict.Current:
      return TurnResultAuthority.Current;
    case InvestigationExecutionAuthorityVerdict.Superseded:
      return TurnResultAuthority.Superseded;
    case InvestigationExecutionAuthorityVerdict.Missing:
    case InvestigationExecutionAuthorityVerdict.Unauthorized:
      return TurnResultAuthority.Rejected;
  }
}
