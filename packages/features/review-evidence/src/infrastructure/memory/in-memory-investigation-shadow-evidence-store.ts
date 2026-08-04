import {
  InvestigationShadowEvidencePersistenceStatus,
  type InvestigationShadowEvidenceCommandPort,
  type InvestigationShadowEvidencePersistenceResult,
  type InvestigationShadowEvidencePrunerPort,
  type InvestigationShadowEvidenceQueryPort,
} from "../../application/ports/investigation-shadow-evidence-ports";
import {
  cloneInvestigationShadowEvidence,
  assertInvestigationShadowEvidenceEpochMilliseconds,
  investigationShadowEvidenceMaxPruneLimit,
  investigationShadowEvidenceMaxQueryLimit,
  sameInvestigationShadowEvidenceAcceptance,
  type InvestigationShadowEvidence,
} from "../../domain/investigation-shadow-evidence";

export class InMemoryInvestigationShadowEvidenceStore
  implements
    InvestigationShadowEvidenceCommandPort,
    InvestigationShadowEvidenceQueryPort,
    InvestigationShadowEvidencePrunerPort
{
  private readonly records = new Map<string, InvestigationShadowEvidence>();
  private readonly certificateIndex = new Map<string, string>();
  private readonly certificateHashIndex = new Map<string, string>();
  private readonly investigationIndex = new Map<string, string>();

  async persist(
    evidence: InvestigationShadowEvidence,
  ): Promise<InvestigationShadowEvidencePersistenceResult> {
    const candidate = cloneInvestigationShadowEvidence(evidence);
    const existing = this.resolveIdentity(candidate);
    if (existing) return resolveExisting(existing, candidate);
    this.records.set(candidate.shadowEvidenceId, candidate);
    this.certificateIndex.set(
      candidate.certificateId,
      candidate.shadowEvidenceId,
    );
    this.certificateHashIndex.set(
      candidate.certificateHash,
      candidate.shadowEvidenceId,
    );
    this.investigationIndex.set(
      candidate.investigationId,
      candidate.shadowEvidenceId,
    );
    return Object.freeze({
      status: InvestigationShadowEvidencePersistenceStatus.Persisted,
      evidence: cloneInvestigationShadowEvidence(candidate),
    });
  }

  async findById(
    shadowEvidenceId: string,
  ): Promise<InvestigationShadowEvidence | null> {
    return cloneOrNull(this.records.get(shadowEvidenceId));
  }

  async findByCertificateId(
    certificateId: string,
  ): Promise<InvestigationShadowEvidence | null> {
    return cloneOrNull(
      this.recordByIndex(this.certificateIndex, certificateId),
    );
  }

  async findByInvestigationId(
    investigationId: string,
  ): Promise<InvestigationShadowEvidence | null> {
    return cloneOrNull(
      this.recordByIndex(this.investigationIndex, investigationId),
    );
  }

  async findByScopeRevision(
    input: Parameters<
      InvestigationShadowEvidenceQueryPort["findByScopeRevision"]
    >[0],
  ): Promise<readonly InvestigationShadowEvidence[]> {
    assertLimit(
      input.limit,
      investigationShadowEvidenceMaxQueryLimit,
      "investigation_shadow_query_limit_invalid",
    );
    return Object.freeze(
      [...this.records.values()]
        .filter(
          (record) =>
            sameScope(record.scope, input.scope) &&
            record.revision.reviewRevisionHash === input.reviewRevisionHash,
        )
        .sort(
          (left, right) =>
            right.issuedAtMs - left.issuedAtMs ||
            left.shadowEvidenceId.localeCompare(right.shadowEvidenceId),
        )
        .slice(0, input.limit)
        .map(cloneInvestigationShadowEvidence),
    );
  }

  async prune(
    input: Parameters<InvestigationShadowEvidencePrunerPort["prune"]>[0],
  ): Promise<number> {
    assertLimit(
      input.limit,
      investigationShadowEvidenceMaxPruneLimit,
      "investigation_shadow_prune_limit_invalid",
    );
    assertInvestigationShadowEvidenceEpochMilliseconds(
      input.retainUntilOrBeforeMs,
      "investigation_shadow_prune_cutoff_ms",
    );
    const removable = [...this.records.values()]
      .filter((record) => record.retainUntilMs <= input.retainUntilOrBeforeMs)
      .sort(
        (left, right) =>
          left.retainUntilMs - right.retainUntilMs ||
          left.shadowEvidenceId.localeCompare(right.shadowEvidenceId),
      )
      .slice(0, input.limit);
    for (const record of removable) this.remove(record);
    return removable.length;
  }

  all(): readonly InvestigationShadowEvidence[] {
    return Object.freeze(
      [...this.records.values()]
        .sort((left, right) =>
          left.shadowEvidenceId.localeCompare(right.shadowEvidenceId),
        )
        .map(cloneInvestigationShadowEvidence),
    );
  }

  private resolveIdentity(
    candidate: InvestigationShadowEvidence,
  ): InvestigationShadowEvidence | null {
    return (
      this.records.get(candidate.shadowEvidenceId) ??
      this.recordByIndex(this.certificateIndex, candidate.certificateId) ??
      this.recordByIndex(
        this.certificateHashIndex,
        candidate.certificateHash,
      ) ??
      this.recordByIndex(this.investigationIndex, candidate.investigationId) ??
      null
    );
  }

  private recordByIndex(
    index: ReadonlyMap<string, string>,
    key: string,
  ): InvestigationShadowEvidence | undefined {
    const id = index.get(key);
    if (!id) return undefined;
    const record = this.records.get(id);
    if (!record) throw new Error("investigation_shadow_memory_index_corrupt");
    return record;
  }

  private remove(record: InvestigationShadowEvidence): void {
    this.records.delete(record.shadowEvidenceId);
    this.certificateIndex.delete(record.certificateId);
    this.certificateHashIndex.delete(record.certificateHash);
    this.investigationIndex.delete(record.investigationId);
  }
}

function resolveExisting(
  existing: InvestigationShadowEvidence,
  candidate: InvestigationShadowEvidence,
): InvestigationShadowEvidencePersistenceResult {
  if (!sameInvestigationShadowEvidenceAcceptance(existing, candidate)) {
    return Object.freeze({
      status: InvestigationShadowEvidencePersistenceStatus.Conflict,
    });
  }
  return Object.freeze({
    status: InvestigationShadowEvidencePersistenceStatus.Idempotent,
    evidence: cloneInvestigationShadowEvidence(existing),
  });
}

function cloneOrNull(
  record: InvestigationShadowEvidence | undefined,
): InvestigationShadowEvidence | null {
  return record ? cloneInvestigationShadowEvidence(record) : null;
}

function sameScope(
  left: InvestigationShadowEvidence["scope"],
  right: InvestigationShadowEvidence["scope"],
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.repositoryConnectionId === right.repositoryConnectionId &&
    left.scmRepositoryIdentityId === right.scmRepositoryIdentityId &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.trustDomain === right.trustDomain &&
    left.authorizationScopeHash === right.authorizationScopeHash
  );
}

function assertLimit(value: number, maximum: number, errorCode: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(errorCode);
  }
}
