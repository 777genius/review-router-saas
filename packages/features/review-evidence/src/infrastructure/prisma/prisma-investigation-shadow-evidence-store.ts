import {
  InvestigationShadowEvidenceAuthorityV1 as PrismaShadowAuthority,
  InvestigationShadowEvidenceSourceKindV1 as PrismaShadowSource,
  Prisma,
  ReviewInvestigationConclusionV1 as PrismaConclusion,
  ReviewProviderKindV2 as PrismaProviderKind,
  ReviewTrustDomainV2 as PrismaTrustDomain,
  type PrismaClient,
  type ReviewInvestigationShadowEvidence as ShadowEvidenceRecord,
} from "@prisma/client";
import {
  InvestigationShadowEvidencePersistenceStatus,
  type InvestigationShadowEvidenceCommandPort,
  type InvestigationShadowEvidencePersistenceResult,
  type InvestigationShadowEvidencePrunerPort,
  type InvestigationShadowEvidenceQueryPort,
} from "../../application/ports/investigation-shadow-evidence-ports";
import {
  InvestigationShadowEvidenceAuthority,
  InvestigationShadowEvidenceConclusion,
  InvestigationShadowEvidenceSourceKind,
  assertInvestigationShadowEvidenceEpochMilliseconds,
  createInvestigationShadowEvidence,
  investigationShadowEvidenceMaxPruneLimit,
  investigationShadowEvidenceMaxQueryLimit,
  sameInvestigationShadowEvidenceAcceptance,
  type InvestigationShadowEvidence,
} from "../../domain/investigation-shadow-evidence";
import {
  ReviewProviderKind,
  ReviewTrustDomain,
} from "../../domain/review-evidence-primitives";

export class PrismaInvestigationShadowEvidenceStore
  implements
    InvestigationShadowEvidenceCommandPort,
    InvestigationShadowEvidenceQueryPort,
    InvestigationShadowEvidencePrunerPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async persist(
    evidence: InvestigationShadowEvidence,
  ): Promise<InvestigationShadowEvidencePersistenceResult> {
    try {
      const created =
        await this.prisma.reviewInvestigationShadowEvidence.create({
          data: toCreateInput(evidence),
        });
      return Object.freeze({
        status: InvestigationShadowEvidencePersistenceStatus.Persisted,
        evidence: toDomain(created),
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.resolveExisting(evidence);
    }
  }

  async findById(
    shadowEvidenceId: string,
  ): Promise<InvestigationShadowEvidence | null> {
    const record =
      await this.prisma.reviewInvestigationShadowEvidence.findUnique({
        where: { shadowEvidenceId },
      });
    return record ? toDomain(record) : null;
  }

  async findByCertificateId(
    certificateId: string,
  ): Promise<InvestigationShadowEvidence | null> {
    const record =
      await this.prisma.reviewInvestigationShadowEvidence.findUnique({
        where: { certificateId },
      });
    return record ? toDomain(record) : null;
  }

  async findByInvestigationId(
    investigationId: string,
  ): Promise<InvestigationShadowEvidence | null> {
    const record =
      await this.prisma.reviewInvestigationShadowEvidence.findUnique({
        where: { investigationId },
      });
    return record ? toDomain(record) : null;
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
    const records =
      await this.prisma.reviewInvestigationShadowEvidence.findMany({
        where: {
          workspaceId: input.scope.workspaceId,
          repositoryConnectionId: input.scope.repositoryConnectionId,
          scmRepositoryIdentityId: input.scope.scmRepositoryIdentityId,
          pullRequestNumber: input.scope.pullRequestNumber,
          trustDomain: toPrismaTrustDomain(input.scope.trustDomain),
          authorizationScopeHash: input.scope.authorizationScopeHash,
          sourceReviewRevisionHash: input.reviewRevisionHash,
        },
        orderBy: [{ issuedAt: "desc" }, { shadowEvidenceId: "asc" }],
        take: input.limit,
      });
    return Object.freeze(records.map(toDomain));
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
    const removed = await this.prisma.$queryRaw<
      Array<{ shadowEvidenceId: string }>
    >(Prisma.sql`
      WITH removable AS (
        SELECT evidence."shadowEvidenceId"
        FROM "ReviewInvestigationShadowEvidence" AS evidence
        WHERE evidence."retainUntil" <= ${new Date(input.retainUntilOrBeforeMs)}
        ORDER BY evidence."retainUntil" ASC, evidence."shadowEvidenceId" ASC
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "ReviewInvestigationShadowEvidence" AS evidence
      USING removable
      WHERE evidence."shadowEvidenceId" = removable."shadowEvidenceId"
      RETURNING evidence."shadowEvidenceId"
    `);
    return removed.length;
  }

  private async resolveExisting(
    candidate: InvestigationShadowEvidence,
  ): Promise<InvestigationShadowEvidencePersistenceResult> {
    const record =
      await this.prisma.reviewInvestigationShadowEvidence.findFirst({
        where: {
          OR: [
            { shadowEvidenceId: candidate.shadowEvidenceId },
            { investigationId: candidate.investigationId },
            { certificateId: candidate.certificateId },
            { certificateHash: candidate.certificateHash },
            { recordHash: candidate.recordHash },
          ],
        },
        orderBy: { shadowEvidenceId: "asc" },
      });
    if (!record) {
      throw new Error("investigation_shadow_unique_conflict_missing");
    }
    const existing = toDomain(record);
    if (!sameInvestigationShadowEvidenceAcceptance(existing, candidate)) {
      return Object.freeze({
        status: InvestigationShadowEvidencePersistenceStatus.Conflict,
      });
    }
    return Object.freeze({
      status: InvestigationShadowEvidencePersistenceStatus.Idempotent,
      evidence: existing,
    });
  }
}

function toCreateInput(
  evidence: InvestigationShadowEvidence,
): Prisma.ReviewInvestigationShadowEvidenceUncheckedCreateInput {
  return {
    shadowEvidenceId: evidence.shadowEvidenceId,
    evidenceVersion: evidence.evidenceVersion,
    authority: toPrismaAuthority(evidence.authority),
    sourceKind: toPrismaSource(evidence.sourceKind),
    retentionPolicyVersion: evidence.retentionPolicyVersion,
    investigationId: evidence.investigationId,
    investigationVersion: BigInt(evidence.investigationVersion),
    workspaceId: evidence.scope.workspaceId,
    repositoryConnectionId: evidence.scope.repositoryConnectionId,
    scmRepositoryIdentityId: evidence.scope.scmRepositoryIdentityId,
    pullRequestNumber: evidence.scope.pullRequestNumber,
    trustDomain: toPrismaTrustDomain(evidence.scope.trustDomain),
    authorizationScopeHash: evidence.scope.authorizationScopeHash,
    sourceBaseSha: evidence.revision.baseSha,
    sourceMergeBaseSha: evidence.revision.mergeBaseSha,
    sourceHeadSha: evidence.revision.headSha,
    sourceReviewRevisionHash: evidence.revision.reviewRevisionHash,
    executionId: evidence.executionId,
    workSlotId: evidence.workSlotId,
    stableReviewUnitKey: evidence.stableReviewUnitKey,
    providerVoteLaneId: evidence.providerVoteLaneId,
    producerReleaseId: evidence.producerReleaseId,
    conclusion: toPrismaConclusion(evidence.conclusion),
    certificateId: evidence.certificateId,
    certificateHash: evidence.certificateHash,
    certificateCanonicalJson: evidence.certificateCanonicalJson,
    terminalProviderKind:
      evidence.terminalProviderKind === null
        ? null
        : toPrismaProviderKind(evidence.terminalProviderKind),
    terminalActualModel: evidence.terminalActualModel,
    terminalOutcomeHash: evidence.terminalOutcomeHash,
    terminalObservationCanonicalJson: evidence.terminalObservationCanonicalJson,
    terminalPayloadHash: evidence.terminalPayloadHash,
    terminalPayloadByteCount: evidence.terminalPayloadByteCount,
    findingCount: evidence.findingCount,
    recordHash: evidence.recordHash,
    issuedAt: new Date(evidence.issuedAtMs),
    retainUntil: new Date(evidence.retainUntilMs),
  };
}

function toDomain(record: ShadowEvidenceRecord): InvestigationShadowEvidence {
  const investigationVersion = Number(record.investigationVersion);
  if (!Number.isSafeInteger(investigationVersion)) {
    throw new Error("investigation_shadow_version_out_of_range");
  }
  return createInvestigationShadowEvidence({
    shadowEvidenceId: record.shadowEvidenceId,
    evidenceVersion: 1,
    authority: fromPrismaAuthority(record.authority),
    sourceKind: fromPrismaSource(record.sourceKind),
    retentionPolicyVersion:
      record.retentionPolicyVersion as InvestigationShadowEvidence["retentionPolicyVersion"],
    investigationId: record.investigationId,
    investigationVersion,
    scope: {
      workspaceId: record.workspaceId,
      repositoryConnectionId: record.repositoryConnectionId,
      scmRepositoryIdentityId: record.scmRepositoryIdentityId,
      pullRequestNumber: record.pullRequestNumber,
      trustDomain: fromPrismaTrustDomain(record.trustDomain),
      authorizationScopeHash: record.authorizationScopeHash,
    },
    revision: {
      baseSha: record.sourceBaseSha,
      mergeBaseSha: record.sourceMergeBaseSha,
      headSha: record.sourceHeadSha,
      reviewRevisionHash: record.sourceReviewRevisionHash,
    },
    executionId: record.executionId,
    workSlotId: record.workSlotId,
    stableReviewUnitKey: record.stableReviewUnitKey,
    providerVoteLaneId: record.providerVoteLaneId,
    producerReleaseId: record.producerReleaseId,
    conclusion: fromPrismaConclusion(record.conclusion),
    certificateId: record.certificateId,
    certificateHash: record.certificateHash,
    certificateCanonicalJson: record.certificateCanonicalJson,
    terminalProviderKind:
      record.terminalProviderKind === null
        ? null
        : fromPrismaProviderKind(record.terminalProviderKind),
    terminalActualModel: record.terminalActualModel,
    terminalOutcomeHash: record.terminalOutcomeHash,
    terminalObservationCanonicalJson: record.terminalObservationCanonicalJson,
    terminalPayloadHash: record.terminalPayloadHash,
    terminalPayloadByteCount: record.terminalPayloadByteCount,
    findingCount: record.findingCount,
    recordHash: record.recordHash,
    issuedAtMs: record.issuedAt.getTime(),
    retainUntilMs: record.retainUntil.getTime(),
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function toPrismaAuthority(
  value: InvestigationShadowEvidenceAuthority,
): PrismaShadowAuthority {
  if (value === InvestigationShadowEvidenceAuthority.NonAuthoritative) {
    return PrismaShadowAuthority.non_authoritative;
  }
  throw new Error("investigation_shadow_authority_unsupported");
}

function fromPrismaAuthority(
  value: PrismaShadowAuthority,
): InvestigationShadowEvidenceAuthority.NonAuthoritative {
  if (value === PrismaShadowAuthority.non_authoritative) {
    return InvestigationShadowEvidenceAuthority.NonAuthoritative;
  }
  throw new Error("investigation_shadow_authority_unsupported");
}

function toPrismaSource(
  value: InvestigationShadowEvidenceSourceKind,
): PrismaShadowSource {
  if (value === InvestigationShadowEvidenceSourceKind.TerminalCertificate) {
    return PrismaShadowSource.terminal_certificate;
  }
  throw new Error("investigation_shadow_source_unsupported");
}

function fromPrismaSource(
  value: PrismaShadowSource,
): InvestigationShadowEvidenceSourceKind.TerminalCertificate {
  if (value === PrismaShadowSource.terminal_certificate) {
    return InvestigationShadowEvidenceSourceKind.TerminalCertificate;
  }
  throw new Error("investigation_shadow_source_unsupported");
}

function toPrismaConclusion(
  value: InvestigationShadowEvidenceConclusion,
): PrismaConclusion {
  switch (value) {
    case InvestigationShadowEvidenceConclusion.VerifiedClean:
      return PrismaConclusion.verified_clean;
    case InvestigationShadowEvidenceConclusion.Findings:
      return PrismaConclusion.findings;
    case InvestigationShadowEvidenceConclusion.Inconclusive:
      return PrismaConclusion.inconclusive;
  }
}

function fromPrismaConclusion(
  value: PrismaConclusion,
): InvestigationShadowEvidenceConclusion {
  switch (value) {
    case PrismaConclusion.verified_clean:
      return InvestigationShadowEvidenceConclusion.VerifiedClean;
    case PrismaConclusion.findings:
      return InvestigationShadowEvidenceConclusion.Findings;
    case PrismaConclusion.inconclusive:
      return InvestigationShadowEvidenceConclusion.Inconclusive;
  }
}

function toPrismaProviderKind(value: ReviewProviderKind): PrismaProviderKind {
  switch (value) {
    case ReviewProviderKind.Codex:
      return PrismaProviderKind.codex;
    case ReviewProviderKind.ClaudeCode:
      return PrismaProviderKind.claude_code;
    case ReviewProviderKind.OpenRouter:
    case ReviewProviderKind.Unknown:
      throw new Error("investigation_shadow_provider_unsupported");
  }
}

function fromPrismaProviderKind(value: PrismaProviderKind): ReviewProviderKind {
  switch (value) {
    case PrismaProviderKind.codex:
      return ReviewProviderKind.Codex;
    case PrismaProviderKind.claude_code:
      return ReviewProviderKind.ClaudeCode;
    case PrismaProviderKind.openrouter:
      return ReviewProviderKind.OpenRouter;
  }
}

function toPrismaTrustDomain(value: ReviewTrustDomain): PrismaTrustDomain {
  switch (value) {
    case ReviewTrustDomain.TrustedManaged:
      return PrismaTrustDomain.trusted_managed;
    case ReviewTrustDomain.TrustedLocal:
      return PrismaTrustDomain.trusted_local;
    case ReviewTrustDomain.UntrustedContribution:
      return PrismaTrustDomain.untrusted_contribution;
    case ReviewTrustDomain.Unknown:
      throw new Error("investigation_shadow_trust_domain_unsupported");
  }
}

function fromPrismaTrustDomain(value: PrismaTrustDomain): ReviewTrustDomain {
  switch (value) {
    case PrismaTrustDomain.trusted_managed:
      return ReviewTrustDomain.TrustedManaged;
    case PrismaTrustDomain.trusted_local:
      return ReviewTrustDomain.TrustedLocal;
    case PrismaTrustDomain.untrusted_contribution:
      return ReviewTrustDomain.UntrustedContribution;
  }
}

function assertLimit(value: number, maximum: number, errorCode: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(errorCode);
  }
}
