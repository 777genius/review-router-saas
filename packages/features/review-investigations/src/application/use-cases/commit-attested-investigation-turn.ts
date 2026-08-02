import type { ReviewInvestigation } from "../../domain/review-investigation";
import {
  InvestigationReceiptKind,
  type InvestigationEvidenceReceipt,
} from "../../domain/investigation-obligation";
import type { InvestigationFinding } from "../../domain/investigation-turn";
import {
  canonicalInvestigationTerminalObservation,
  canonicalInvestigationTurnObservation,
  type InvestigationTurnObservation,
} from "../../domain/investigation-turn-observation";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationStorePort } from "../ports/investigation-store-port";
import type {
  InvestigationTurnEvidencePort,
  VerifiedInvestigationOperationEvidence,
} from "../ports/investigation-turn-evidence-port";
import type { ReviewInvestigationReadModel } from "../investigation-read-model";
import {
  CommitInvestigationTurn,
  type CommitInvestigationTurnCommand,
} from "./commit-investigation-turn";
import { digestCanonical } from "./investigation-use-case-support";

export type CommitAttestedInvestigationTurnCommand = Readonly<{
  commandId: string;
  investigationId: string;
  expectedVersion: number;
  turnId: string;
  sourceAttemptId: string;
  sourceLeaseId: string;
  sourceFencingToken: string;
  acceptedAttestationId: string;
  acceptedAttestationHash: string;
  turnObservationHash: string;
  observation: InvestigationTurnObservation;
}>;

export class CommitAttestedInvestigationTurn {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly evidence: InvestigationTurnEvidencePort,
    private readonly digest: InvestigationDigestPort,
    private readonly commit: CommitInvestigationTurn,
  ) {}

  async execute(
    command: CommitAttestedInvestigationTurnCommand,
  ): Promise<ReviewInvestigationReadModel> {
    const current = await this.store.findById(command.investigationId);
    if (
      current === null ||
      current.version !== command.expectedVersion ||
      current.activeTurn === null
    ) {
      throw new Error("investigation_concurrency_conflict");
    }
    assertObservationBinding(current, command);
    if (
      (await this.digest.digestUtf8(
        canonicalInvestigationTurnObservation(command.observation),
      )) !== command.turnObservationHash
    ) {
      throw new Error("investigation_turn_observation_hash_mismatch");
    }
    const terminalOutcomeHash = await this.digest.digestUtf8(
      canonicalInvestigationTerminalObservation(command.observation),
    );
    const verified = await this.evidence.verify({
      acceptedAttestationId: command.acceptedAttestationId,
      acceptedAttestationHash: command.acceptedAttestationHash,
      sourceExecutionId: current.executionId,
      sourceWorkSlotId: current.workSlotId,
      sourceReviewRevisionHash: current.revision.reviewRevisionHash,
      attemptId: command.sourceAttemptId,
      sourceLeaseId: command.sourceLeaseId,
      sourceFencingToken: command.sourceFencingToken,
      actualModel: command.observation.actualModel,
      terminalOutcomeHash,
    });
    if (
      verified === null ||
      verified.gatewayPolicyVersion !== current.contract.gatewayPolicyVersion ||
      verified.acceptedAttestationId !== command.acceptedAttestationId ||
      verified.acceptedAttestationHash !== command.acceptedAttestationHash ||
      verified.terminalOutcomeHash !== terminalOutcomeHash
    ) {
      throw new Error("investigation_turn_attestation_invalid");
    }
    const operationEvidence = new Map(
      verified.operations.map((item) => [item.operationReceiptId, item]),
    );
    const closureClaims = await Promise.all(
      command.observation.closureClaims.map(async (claim) => ({
        obligationId: claim.obligationId,
        receipt: await closureReceipt({
          claim,
          investigation: current,
          operationEvidence,
          digest: this.digest,
          acceptedAttestationId: command.acceptedAttestationId,
          acceptedAttestationHash: command.acceptedAttestationHash,
        }),
      })),
    );
    assertEvidenceReferences(
      command.observation.findings.flatMap(
        (finding) => finding.evidenceOperationReceiptIds,
      ),
      operationEvidence,
      "finding",
    );
    assertEvidenceReferences(
      command.observation.unresolvableClaims.flatMap(
        (claim) => claim.evidenceOperationReceiptIds,
      ),
      operationEvidence,
      "unresolvable",
    );
    const findings: InvestigationFinding[] = await Promise.all(
      command.observation.findings.map(async (finding) => ({
        fingerprint: await digestCanonical(this.digest, {
          severity: finding.severity,
          title: finding.title,
          body: finding.body,
          path: finding.path,
          line: finding.line,
          evidenceReceiptIds: [...finding.evidenceOperationReceiptIds].sort(),
        }),
        severity: finding.severity,
        title: finding.title,
        body: finding.body,
        path: finding.path,
        line: finding.line,
        evidenceReceiptIds: [...finding.evidenceOperationReceiptIds],
      })),
    );
    const commitCommand: CommitInvestigationTurnCommand = {
      commandId: command.commandId,
      investigationId: command.investigationId,
      expectedVersion: command.expectedVersion,
      turnId: command.turnId,
      closureClaims,
      // Provider output is evidence, not deterministic policy authority.
      unresolvableDecisions: [],
      proposals: command.observation.obligationProposals,
      findings,
      acceptedEvidenceReceiptIds: [...operationEvidence.keys()],
      criticDecision: command.observation.criticDecision,
      usageTokens: command.observation.usage.totalTokens,
      durationMs: command.observation.durationMs,
      acceptedAttestationId: command.acceptedAttestationId,
      sanitizedOutcomeHash: command.turnObservationHash,
      provenance: {
        turnId: command.turnId,
        purpose: command.observation.purpose,
        actualProviderKind: command.observation.actualProviderKind,
        actualModel: command.observation.actualModel,
        runtimeProfile: command.observation.runtimeProfile,
        inputTokens: command.observation.usage.inputTokens,
        cachedInputTokens: command.observation.usage.cachedInputTokens,
        outputTokens: command.observation.usage.outputTokens,
        reasoningOutputTokens: command.observation.usage.reasoningOutputTokens,
        totalTokens: command.observation.usage.totalTokens,
        durationMs: command.observation.durationMs,
        acceptedAttestationId: command.acceptedAttestationId,
        acceptedAttestationHash: command.acceptedAttestationHash,
        terminalOutcomeHash,
      },
    };
    return this.commit.execute(commitCommand);
  }
}

function assertObservationBinding(
  current: ReviewInvestigation,
  command: CommitAttestedInvestigationTurnCommand,
): void {
  const turn = current.activeTurn;
  if (
    turn === null ||
    command.observation.turnId !== command.turnId ||
    command.observation.turnId !== turn.turnId ||
    command.observation.dossierVersion !== command.expectedVersion ||
    command.observation.purpose !== turn.purpose ||
    command.observation.runtimeProfile !== current.runtimeProfile ||
    command.observation.contextAttestationReference !==
      command.acceptedAttestationId
  ) {
    throw new Error("investigation_turn_observation_binding_invalid");
  }
}

async function closureReceipt(input: {
  readonly claim: InvestigationTurnObservation["closureClaims"][number];
  readonly investigation: ReviewInvestigation;
  readonly operationEvidence: ReadonlyMap<
    string,
    VerifiedInvestigationOperationEvidence
  >;
  readonly digest: InvestigationDigestPort;
  readonly acceptedAttestationId: string;
  readonly acceptedAttestationHash: string;
}): Promise<InvestigationEvidenceReceipt> {
  const obligation = input.investigation.obligations.find(
    (item) => item.obligationId === input.claim.obligationId,
  );
  if (!obligation) throw new Error("investigation_obligation_missing");
  const operations = input.claim.operationReceiptIds.map((receiptId) => {
    const evidence = input.operationEvidence.get(receiptId);
    if (!evidence) throw new Error("investigation_operation_receipt_missing");
    return evidence;
  });
  const kinds = new Set(operations.map((item) => item.kind));
  return Object.freeze({
    receiptId: await digestCanonical(input.digest, {
      operationReceiptIds: [...input.claim.operationReceiptIds].sort(),
      obligationId: obligation.obligationId,
    }),
    operationKey: await digestCanonical(
      input.digest,
      operations.map((item) => item.operationKey).sort(),
    ),
    kind:
      kinds.size === 1
        ? operations[0]!.kind
        : InvestigationReceiptKind.Relation,
    canonicalSubject: obligation.canonicalSubject,
    reviewRevisionHash: input.investigation.revision.reviewRevisionHash,
    gatewayPolicyVersion: input.investigation.contract.gatewayPolicyVersion,
    evidenceDigest: await digestCanonical(
      input.digest,
      operations.map((item) => item.evidenceDigest).sort(),
    ),
    operationReceiptIds: [...input.claim.operationReceiptIds].sort(),
    acceptedAttestationId: input.acceptedAttestationId,
    acceptedAttestationHash: input.acceptedAttestationHash,
    complete: true,
    truncated: false,
    failed: false,
  });
}

function assertEvidenceReferences(
  receiptIds: readonly string[],
  evidence: ReadonlyMap<string, VerifiedInvestigationOperationEvidence>,
  kind: string,
): void {
  if (receiptIds.some((receiptId) => !evidence.has(receiptId))) {
    throw new Error(`investigation_${kind}_evidence_invalid`);
  }
}
