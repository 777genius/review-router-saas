import { canonicalJson } from "../../domain/canonicalization";
import type { ReviewInvestigation } from "../../domain/review-investigation";
import {
  VersionedCoverageExpansionPolicy,
  type CoverageExpansionPolicy,
  type PreparedOperationBackedDiscoveryClaim,
} from "../../domain/coverage-policies";
import {
  assertInvestigationTurnObligationClaimScope,
  type InvestigationFinding,
} from "../../domain/investigation-turn";
import {
  InvestigationFileContentKind,
  InvestigationOperationKind,
  InvestigationOperationRevision,
  type InvestigationFileReadEvidence,
} from "../../domain/investigation-operation-evidence";
import {
  InvestigationEvidenceRequirementKind,
  VersionedObligationClosurePolicy,
  canonicalStandardTextSearchOperationInput,
  obligationEvidenceRequirementVersionV2,
  parseInvestigationEvidenceRequirement,
  type ObligationClosurePolicy,
} from "../../domain/obligation-closure-policy";
import type { SeedInvestigationObligation } from "../../domain/coverage-contract";
import {
  canonicalInvestigationTerminalObservation,
  canonicalInvestigationTurnObservation,
  type InvestigationTurnObservation,
} from "../../domain/investigation-turn-observation";
import { AttestedTurnClosurePreparation } from "../attested-turn-closure-preparation";
import { AttestedTurnDiscoveryPreparation } from "../attested-turn-discovery-preparation";
import { AttestedTurnProposalPreparation } from "../attested-turn-proposal-preparation";
import { AttestedTurnUnresolvablePreparation } from "../attested-turn-unresolvable-preparation";
import type { InvestigationDigestPort } from "../ports/digest-port";
import {
  InvestigationStoreCommitGuardKind,
  type InvestigationStorePort,
} from "../ports/investigation-store-port";
import type { InvestigationTurnEvidencePort } from "../ports/investigation-turn-evidence-port";
import type { ReviewInvestigationReadModel } from "../investigation-read-model";
import { toInvestigationReadModel } from "../investigation-read-model";
import {
  createVerifiedOperationEvidenceIndex,
  type VerifiedOperationEvidenceIndex,
} from "../verified-operation-evidence-index";
import {
  CommitInvestigationTurn,
  type CommitInvestigationTurnCommand,
} from "./commit-investigation-turn";
import {
  digestCanonical,
  restoreCommandOrThrow,
} from "./investigation-use-case-support";
import type { ResolveInvestigationSearchQueryPrivateMaterial } from "./resolve-investigation-search-query-private-material";

export type CommitAttestedInvestigationTurnCommand = Readonly<{
  commandId: string;
  investigationId: string;
  expectedVersion: number;
  turnId: string;
  sourceAttemptId: string;
  sourceLeaseId: string;
  sourceFencingToken: string;
  sourceLeaseCapabilityId?: string;
  sourceAuthorizationId?: string;
  sourceMutationEpoch?: string;
  acceptedAttestationId: string;
  acceptedAttestationHash: string;
  turnObservationHash: string;
  observation: InvestigationTurnObservation;
  authorizationDeadline?: string;
  capabilityDeadline?: string;
  drainDeadline?: string;
}>;

export class CommitAttestedInvestigationTurn {
  private readonly closurePreparation: AttestedTurnClosurePreparation;
  private readonly discoveryPreparation: AttestedTurnDiscoveryPreparation;
  private readonly unresolvablePreparation =
    new AttestedTurnUnresolvablePreparation();
  private readonly proposalPreparation: AttestedTurnProposalPreparation;

  constructor(
    private readonly store: InvestigationStorePort,
    private readonly evidence: InvestigationTurnEvidencePort,
    private readonly digest: InvestigationDigestPort,
    private readonly commit: CommitInvestigationTurn,
    closurePolicy: ObligationClosurePolicy = new VersionedObligationClosurePolicy(),
    private readonly expansionPolicy: CoverageExpansionPolicy = new VersionedCoverageExpansionPolicy(),
    private readonly resolvePrivateQuery?: ResolveInvestigationSearchQueryPrivateMaterial,
  ) {
    this.closurePreparation = new AttestedTurnClosurePreparation(
      digest,
      closurePolicy,
    );
    this.discoveryPreparation = new AttestedTurnDiscoveryPreparation(digest);
    this.proposalPreparation = new AttestedTurnProposalPreparation(digest);
  }

  async execute(
    command: CommitAttestedInvestigationTurnCommand,
  ): Promise<ReviewInvestigationReadModel> {
    const { commandHash: idempotencyHash, restored } =
      await this.restoreCommand(command);
    if (restored) return toInvestigationReadModel(restored);
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
    assertInvestigationTurnObligationClaimScope({
      turn: current.activeTurn,
      closureClaims: command.observation.closureClaims,
      unresolvableClaims: command.observation.unresolvableClaims,
    });
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
      verified.terminalOutcomeHash !== terminalOutcomeHash ||
      verified.actualProviderKind !== command.observation.actualProviderKind
    ) {
      throw new Error("investigation_turn_attestation_invalid");
    }
    const operationEvidence = createVerifiedOperationEvidenceIndex(
      verified.operations,
    );
    const preparedClosures = await this.closurePreparation.prepare({
      investigation: current,
      closureClaims: command.observation.closureClaims,
      operationEvidence,
      acceptedAttestationId: command.acceptedAttestationId,
      acceptedAttestationHash: command.acceptedAttestationHash,
    });
    const discoveryClaims = await this.discoveryPreparation.prepare({
      closureClaims: preparedClosures.acceptedProviderClaims,
      providerClaims: command.observation.operationBackedDiscoveryClaims,
      investigation: current,
      operationEvidence,
    });
    const deterministicExpansions = this.expansionPolicy.expand({
      contract: current.contract,
      currentObligations: current.obligations,
      discoveryClaims,
    });
    assertEvidenceReferences(
      command.observation.findings.flatMap(
        (finding) => finding.evidenceOperationReceiptIds,
      ),
      operationEvidence,
      "finding",
    );
    await assertFindingEvidenceBindings(
      command.observation.findings,
      operationEvidence,
      this.digest,
    );
    assertEvidenceReferences(
      command.observation.unresolvableClaims.flatMap(
        (claim) => claim.evidenceOperationReceiptIds,
      ),
      operationEvidence,
      "unresolvable",
    );
    const unresolvableDecisions = this.unresolvablePreparation.prepare({
      investigation: current,
      providerClaims: command.observation.unresolvableClaims,
      operationEvidence,
    });
    const proposals = await this.proposalPreparation.prepare(
      command.observation.obligationProposals,
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
      closureClaims: preparedClosures.closureClaims,
      // Provider output is only a suggestion; deterministic policy owns the decision.
      unresolvableDecisions,
      proposals,
      deterministicExpansions,
      findings,
      acceptedEvidenceReceiptIds: [...operationEvidence.operationReceiptIds],
      criticDecision: command.observation.criticDecision,
      usageTokens: command.observation.usage.totalTokens,
      durationMs: command.observation.durationMs,
      acceptedAttestationId: command.acceptedAttestationId,
      sanitizedOutcomeHash: command.turnObservationHash,
      provenance: {
        turnId: command.turnId,
        purpose: command.observation.purpose,
        actualProviderKind: verified.actualProviderKind,
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
        acceptedOperationReceiptIds: Object.freeze(
          [...operationEvidence.operationReceiptIds].sort(),
        ),
        terminalOutcomeHash,
      },
      idempotencyHash,
      storeCommitGuard: {
        kind: InvestigationStoreCommitGuardKind.LeaseFence,
        leaseId: command.sourceLeaseId,
        attemptId: command.sourceAttemptId,
        turnId: command.turnId,
        fencingToken: command.sourceFencingToken,
        ...(command.sourceLeaseCapabilityId === undefined
          ? {}
          : { leaseCapabilityId: command.sourceLeaseCapabilityId }),
        ...(command.sourceAuthorizationId === undefined
          ? {}
          : { authorizationId: command.sourceAuthorizationId }),
        ...(command.sourceMutationEpoch === undefined
          ? {}
          : { mutationEpoch: BigInt(command.sourceMutationEpoch) }),
      },
      ...(command.authorizationDeadline === undefined ||
      command.capabilityDeadline === undefined ||
      command.drainDeadline === undefined
        ? {}
        : {
            resultDeadlines: [
              command.authorizationDeadline,
              command.capabilityDeadline,
              command.drainDeadline,
            ],
          }),
    };
    return this.commit.execute(commitCommand, {
      prepareDeterministicExpansionQueries: () =>
        this.prepareDeterministicExpansionQueries({
          investigation: current,
          deterministicExpansions,
          discoveryClaims,
          providerClaims: command.observation.operationBackedDiscoveryClaims,
        }),
    });
  }

  async restoreCommittedCommand(
    command: CommitAttestedInvestigationTurnCommand,
  ): Promise<ReviewInvestigationReadModel | null> {
    const { restored } = await this.restoreCommand(command);
    return restored === null ? null : toInvestigationReadModel(restored);
  }

  private async restoreCommand(
    command: CommitAttestedInvestigationTurnCommand,
  ): Promise<
    Readonly<{
      commandHash: string;
      restored: ReviewInvestigation | null;
    }>
  > {
    const commandHash = await this.commandHash(command);
    const restored = await restoreCommandOrThrow({
      store: this.store,
      commandId: command.commandId,
      commandHash,
    });
    return Object.freeze({ commandHash, restored });
  }

  private commandHash(
    command: CommitAttestedInvestigationTurnCommand,
  ): Promise<string> {
    return this.digest.digestUtf8(
      canonicalJson({
        operation: "commit_attested_investigation_turn",
        command,
      }),
    );
  }

  private async prepareDeterministicExpansionQueries(input: {
    readonly investigation: ReviewInvestigation;
    readonly deterministicExpansions: readonly SeedInvestigationObligation[];
    readonly discoveryClaims: readonly PreparedOperationBackedDiscoveryClaim[];
    readonly providerClaims: InvestigationTurnObservation["operationBackedDiscoveryClaims"];
  }): Promise<
    readonly Readonly<{ canonicalSubject: string; query: string }>[]
  > {
    if (input.deterministicExpansions.length === 0) {
      return Object.freeze([]);
    }
    const providerQueries = new Map<string, string>();
    for (const claim of input.providerClaims) {
      const queryHash = await this.digest.digestUtf8(claim.query);
      const initialOperationInputHash = await this.digest.digestUtf8(
        canonicalStandardTextSearchOperationInput(queryHash),
      );
      providerQueries.set(
        discoveryQueryKey({
          sourceObligationId: claim.sourceObligationId,
          queryHash,
          initialOperationInputHash,
        }),
        claim.query,
      );
    }
    const queryByExpansionKey = new Map<string, string>();
    for (const claim of input.discoveryClaims) {
      const queryKey = discoveryQueryKey({
        sourceObligationId: claim.sourceObligationId,
        queryHash: claim.queryHash,
        initialOperationInputHash: claim.expectedInitialOperationInputHash,
      });
      let query = providerQueries.get(queryKey);
      if (!query) {
        const source = input.investigation.obligations.find(
          (obligation) => obligation.obligationId === claim.sourceObligationId,
        );
        if (!source || !this.resolvePrivateQuery) {
          throw new Error("investigation_private_material_required");
        }
        const requirement = parseInvestigationEvidenceRequirement(
          source.canonicalRequirement,
        );
        if (
          requirement.kind !==
            InvestigationEvidenceRequirementKind.CompletePageChain ||
          requirement.requirementVersion !==
            obligationEvidenceRequirementVersionV2 ||
          requirement.queryHash !== claim.queryHash ||
          requirement.initialOperationInputHash !==
            claim.expectedInitialOperationInputHash
        ) {
          throw new Error("investigation_private_material_binding_invalid");
        }
        query = await this.resolvePrivateQuery.execute({
          investigation: input.investigation,
          obligation: source,
        });
      }
      if ((await this.digest.digestUtf8(query)) !== claim.queryHash) {
        throw new Error("investigation_private_material_query_mismatch");
      }
      queryByExpansionKey.set(
        relationExpansionKey({
          sourceObligationId: claim.sourceObligationId,
          queryHash: claim.queryHash,
          initialOperationInputHash: claim.expectedInitialOperationInputHash,
          requiredPathSetHash: claim.authenticatedPathSetHash,
        }),
        query,
      );
    }
    return Object.freeze(
      input.deterministicExpansions.map((expansion) => {
        const requirement = parseInvestigationEvidenceRequirement(
          expansion.canonicalRequirement,
        );
        if (
          requirement.kind !==
            InvestigationEvidenceRequirementKind.CompleteRelationContext ||
          requirement.requirementVersion !==
            obligationEvidenceRequirementVersionV2
        ) {
          throw new Error("investigation_private_material_binding_invalid");
        }
        const query = queryByExpansionKey.get(
          relationExpansionKey({
            sourceObligationId: requirement.sourceObligationId,
            queryHash: requirement.queryHash,
            initialOperationInputHash: requirement.initialOperationInputHash,
            requiredPathSetHash: requirement.requiredPathSetHash,
          }),
        );
        if (!query) {
          throw new Error("investigation_private_material_required");
        }
        return Object.freeze({
          canonicalSubject: expansion.canonicalSubject,
          query,
        });
      }),
    );
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

function discoveryQueryKey(input: {
  readonly sourceObligationId: string;
  readonly queryHash: string;
  readonly initialOperationInputHash: string;
}): string {
  return canonicalJson(input);
}

function relationExpansionKey(input: {
  readonly sourceObligationId: string;
  readonly queryHash: string;
  readonly initialOperationInputHash: string;
  readonly requiredPathSetHash: string;
}): string {
  return canonicalJson(input);
}

function assertEvidenceReferences(
  receiptIds: readonly string[],
  evidence: VerifiedOperationEvidenceIndex,
  kind: string,
): void {
  if (receiptIds.some((receiptId) => !evidence.has(receiptId))) {
    throw new Error(`investigation_${kind}_evidence_invalid`);
  }
}

async function assertFindingEvidenceBindings(
  findings: InvestigationTurnObservation["findings"],
  evidence: VerifiedOperationEvidenceIndex,
  digest: InvestigationDigestPort,
): Promise<void> {
  for (const finding of findings) {
    const pathHash = await digest.digestUtf8(finding.path);
    const referencedFileReads = finding.evidenceOperationReceiptIds
      .map((receiptId) => evidence.get(receiptId))
      .filter(
        (operation): operation is InvestigationFileReadEvidence =>
          operation?.operationKind === InvestigationOperationKind.FileRead &&
          operation.revision === InvestigationOperationRevision.Head &&
          operation.pathHash === pathHash,
      );
    const completeGroups = groupFileReads(referencedFileReads).filter(
      isCompleteFileReadGroup,
    );
    if (completeGroups.length === 0) {
      throw new Error("investigation_finding_evidence_path_invalid");
    }
    const findingLine = finding.line;
    if (
      findingLine !== null &&
      !completeGroups.some(
        (group) =>
          group.every(
            (operation) =>
              operation.contentKind === InvestigationFileContentKind.Text &&
              operation.lineCount !== null &&
              operation.lineCount === group[0]!.lineCount,
          ) && findingLine <= group[0]!.lineCount!,
      )
    ) {
      throw new Error("investigation_finding_evidence_line_invalid");
    }
  }
}

function groupFileReads(
  reads: readonly InvestigationFileReadEvidence[],
): readonly (readonly InvestigationFileReadEvidence[])[] {
  const groups = new Map<string, InvestigationFileReadEvidence[]>();
  for (const read of reads) {
    const key = [read.treeOid, read.pathHash, read.blobOid, read.mode].join(
      ":",
    );
    const group = groups.get(key) ?? [];
    group.push(read);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) =>
    [...group].sort((left, right) => left.startByte - right.startByte),
  );
}

function isCompleteFileReadGroup(
  reads: readonly InvestigationFileReadEvidence[],
): boolean {
  if (reads.length === 0 || reads[0]!.startByte !== 0) return false;
  let nextByte = 0;
  for (const read of reads) {
    if (read.startByte !== nextByte || read.byteCount < 0) return false;
    nextByte += read.byteCount;
  }
  const terminal = reads.at(-1)!;
  return terminal.eof && terminal.complete;
}
