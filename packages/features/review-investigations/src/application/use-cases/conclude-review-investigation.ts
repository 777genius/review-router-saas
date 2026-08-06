import { canonicalJson } from "../../domain/canonicalization";
import { canonicalInvestigationScope } from "../../domain/coverage-contract";
import {
  certificateCandidateCanonicalValue,
  type ReviewInvestigationCertificate,
  type ReviewInvestigationCertificateCandidate,
} from "../../domain/investigation-certificate";
import {
  concludeReviewInvestigation,
  enforceCriticPolicyForConclusion,
  type ReviewInvestigation,
} from "../../domain/review-investigation";
import {
  ReviewInvestigationConclusion,
  ReviewInvestigationState,
} from "../../domain/review-investigation-types";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationExecutionAuthorityPort } from "../ports/execution-authority-port";
import type { InvestigationTerminalProjectionPort } from "../ports/investigation-terminal-projection-port";
import {
  canonicalContextAttestationSet,
  canonicalTurnProvenanceSet,
  latestCriticTurnProvenance,
  summarizeTerminalDiscoveryProvenance,
} from "../../domain/investigation-turn";
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
import { issueReplayEvidenceCheckpoint } from "../replay-evidence-checkpoint-issuer";

export type ConcludeReviewInvestigationCommand = Readonly<{
  commandId: string;
  investigationId: string;
  expectedVersion: number;
  certificateTtlMs: number;
}>;

export class ConcludeReviewInvestigation {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
    private readonly terminalProjection: InvestigationTerminalProjectionPort,
  ) {}

  async execute(
    command: ConcludeReviewInvestigationCommand,
  ): Promise<ReviewInvestigationReadModel> {
    const commandHash = await this.digest.digestUtf8(
      canonicalJson({ operation: "conclude_review_investigation", command }),
    );
    const restored = await restoreCommandOrThrow({
      store: this.store,
      commandId: command.commandId,
      commandHash,
    });
    if (restored) return toInvestigationReadModel(restored);
    const restoredCurrent = await this.store.findById(command.investigationId);
    if (restoredCurrent === null) throw new Error("investigation_missing");
    if (restoredCurrent.version !== command.expectedVersion) {
      throw new Error("investigation_concurrency_conflict");
    }
    await requireCurrentExecution({
      authority: this.authority,
      investigation: restoredCurrent,
    });
    const current = await withCurrentDossierDigest(
      this.digest,
      enforceCriticPolicyForConclusion(restoredCurrent),
    );
    if (
      !Number.isSafeInteger(command.certificateTtlMs) ||
      command.certificateTtlMs <= 0
    ) {
      throw new Error("certificate_ttl_invalid");
    }
    const now = this.clock.now();
    const conclusion =
      current.state === ReviewInvestigationState.Inconclusive
        ? ReviewInvestigationConclusion.Inconclusive
        : current.findings.length > 0
          ? ReviewInvestigationConclusion.Findings
          : ReviewInvestigationConclusion.VerifiedClean;
    const projection = await this.terminalProjection.project(current);
    if (projection.conclusion !== conclusion) {
      throw new Error("investigation_terminal_projection_conclusion_mismatch");
    }
    if (
      current.turnProvenance.length !==
      current.semanticTurns + current.criticCycles
    ) {
      throw new Error("investigation_turn_provenance_incomplete");
    }
    const criticProvenance = latestCriticTurnProvenance(current.turnProvenance);
    const terminalProvenance = summarizeTerminalDiscoveryProvenance(
      current.turnProvenance,
    );
    const candidate: ReviewInvestigationCertificateCandidate = {
      certificateId: `certificate-${current.investigationId.slice(-32)}`,
      investigationId: current.investigationId,
      investigationVersion: current.version,
      dossierDigest: current.dossierDigest,
      reviewRevisionHash: current.revision.reviewRevisionHash,
      stableReviewUnitKey: current.stableReviewUnitKey,
      providerVoteLaneId: current.providerVoteLaneId,
      coverageContractVersion: current.contract.coverageContractVersion,
      expansionRulesVersion: current.contract.expansionRulesVersion,
      gatewayPolicyVersion: current.contract.gatewayPolicyVersion,
      criticPolicyVersion: current.contract.criticPolicyVersion,
      runtimeProfileVersion: current.contract.runtimeProfileVersion,
      producerReleaseId: current.contract.producerReleaseId,
      conclusion,
      findingSetHash: await digestCanonical(
        this.digest,
        current.findings.map((item) => item.fingerprint).sort(),
      ),
      obligationSetHash: await digestCanonical(
        this.digest,
        current.obligations.map((item) => item.obligationId).sort(),
      ),
      receiptSetHash: await digestCanonical(
        this.digest,
        current.obligations
          .map((item) => item.receipt?.receiptId ?? null)
          .filter((item): item is string => item !== null)
          .sort(),
      ),
      scopeHash: await this.digest.digestUtf8(
        canonicalInvestigationScope(current.scope),
      ),
      coverageStateHash: await digestCanonical(
        this.digest,
        current.obligations.map((item) => ({
          obligationId: item.obligationId,
          state: item.state,
        })),
      ),
      contextAttestationSetHash: await this.digest.digestUtf8(
        canonicalContextAttestationSet(current.turnProvenance),
      ),
      turnProvenanceHash: await this.digest.digestUtf8(
        canonicalTurnProvenanceSet(current.turnProvenance),
      ),
      terminalProviderKind: terminalProvenance.providerKind,
      terminalActualModel: terminalProvenance.actualModel,
      terminalOutcomeHash: projection.terminalOutcomeHash,
      terminalObservationCanonicalJson: projection.canonicalJson,
      criticAttestationId: criticProvenance?.acceptedAttestationId ?? null,
      criticAttestationHash: criticProvenance?.acceptedAttestationHash ?? null,
      criticDecision: current.criticDecision,
      issuedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + command.certificateTtlMs,
      ).toISOString(),
    };
    const certificate: ReviewInvestigationCertificate = {
      ...candidate,
      certificateHash: await digestCanonical(
        this.digest,
        certificateCandidateCanonicalValue(candidate),
      ),
    };
    const terminalState =
      conclusion === ReviewInvestigationConclusion.Inconclusive
        ? ReviewInvestigationState.Inconclusive
        : ReviewInvestigationState.Concluded;
    const replayEvidenceCheckpoint = await issueReplayEvidenceCheckpoint({
      source: current,
      sourceState: terminalState,
      sourceConclusion: conclusion,
      sourceVersion: current.version + 1,
      issuedAt: now,
      ttlMs: command.certificateTtlMs,
      digest: this.digest,
    });
    let next = concludeReviewInvestigation({
      investigation: current,
      certificate,
      replayEvidenceCheckpoint,
      concludedAt: now.toISOString(),
    });
    next = await withCurrentDossierDigest(this.digest, next);
    const committed = await commitOrThrow({
      store: this.store,
      investigation: next,
      expectedVersion: current.version,
      commandId: command.commandId,
      commandHash,
      transition: { kind: InvestigationStoreTransitionKind.Concluded },
    });
    return toInvestigationReadModel(committed);
  }
}

export async function investigationCertificateInputHash(
  digest: InvestigationDigestPort,
  investigation: ReviewInvestigation,
): Promise<string> {
  return digest.digestUtf8(
    canonicalJson({
      dossierDigest: investigation.dossierDigest,
      version: investigation.version,
      state: investigation.state,
    }),
  );
}
