import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InvestigationShadowEvidenceAuthority,
  InvestigationShadowEvidenceConclusion,
  InvestigationShadowEvidenceCriticDecision,
  InvestigationShadowEvidencePersistenceStatus,
  ProjectInvestigationShadowEvidence,
  ProjectInvestigationShadowEvidenceStatus,
  PruneInvestigationShadowEvidence,
  ReviewProviderKind,
  ReviewTrustDomain,
  canonicalInvestigationShadowCertificate,
  investigationShadowEvidenceMaxPruneLimit,
  investigationShadowEvidenceRetentionMs,
  investigationShadowScopeCanonicalValue,
  stableJson,
  type InvestigationShadowEvidenceProjectionSource,
} from "../index";
import {
  FixedClock,
  InMemoryInvestigationShadowEvidenceStore,
  NodeSha256DigestAdapter,
} from "../testing";

const issuedAtMs = Date.UTC(2026, 7, 3, 10, 0, 0);
const digest = new NodeSha256DigestAdapter();

describe("investigation shadow evidence", () => {
  it("projects one certificate-bound non-authoritative record idempotently", async () => {
    const fixture = setup();
    const source = await projectionSource();

    const first = await fixture.project.execute(source);
    const retried = await fixture.project.execute(source);

    expect(first.status).toBe(
      ProjectInvestigationShadowEvidenceStatus.Projected,
    );
    expect(retried.status).toBe(
      ProjectInvestigationShadowEvidenceStatus.Idempotent,
    );
    expect(first.evidence.authority).toBe(
      InvestigationShadowEvidenceAuthority.NonAuthoritative,
    );
    expect(first.evidence.certificateHash).toBe(
      source.certificate.certificateHash,
    );
    expect(first.evidence.terminalPayloadHash).toBe(
      source.certificate.terminalOutcomeHash,
    );
    expect(fixture.store.all()).toHaveLength(1);
    await expect(
      fixture.store.findByCertificateId(source.certificate.certificateId),
    ).resolves.toMatchObject({ investigationId: source.investigationId });
  });

  it("rejects scope, terminal payload and certificate hash mismatches before persistence", async () => {
    const fixture = setup();
    const source = await projectionSource();

    await expect(
      fixture.project.execute({
        ...source,
        certificate: { ...source.certificate, scopeHash: hash("bad-scope") },
      }),
    ).rejects.toThrow("investigation_shadow_scope_hash_mismatch");
    await expect(
      fixture.project.execute({
        ...source,
        certificate: {
          ...source.certificate,
          terminalOutcomeHash: hash("bad-terminal"),
        },
      }),
    ).rejects.toThrow("investigation_shadow_terminal_outcome_hash_mismatch");
    await expect(
      fixture.project.execute({
        ...source,
        certificate: {
          ...source.certificate,
          certificateHash: hash("bad-certificate"),
        },
      }),
    ).rejects.toThrow("investigation_shadow_certificate_hash_mismatch");
    expect(fixture.store.all()).toHaveLength(0);
  });

  it("fails closed when one investigation identity is rebound to different content", async () => {
    const fixture = setup();
    const first = await projectionSource();
    await fixture.project.execute(first);
    const conflicting = await projectionSource({
      terminalPayload: terminalPayload("different finding"),
    });

    await expect(fixture.project.execute(conflicting)).rejects.toThrow(
      "investigation_shadow_evidence_conflict",
    );
    expect(fixture.store.all()).toHaveLength(1);
  });

  it("rejects clean certificates without an accepted critic and conclusion/payload mismatches", async () => {
    const fixture = setup();
    const findingsSource = await projectionSource();
    const cleanWithoutCritic = {
      ...findingsSource,
      conclusion: InvestigationShadowEvidenceConclusion.VerifiedClean,
      certificate: {
        ...findingsSource.certificate,
        conclusion: InvestigationShadowEvidenceConclusion.VerifiedClean,
        criticAttestationId: null,
        criticAttestationHash: null,
        criticDecision: null,
      },
    };
    cleanWithoutCritic.certificate.certificateHash = hash(
      canonicalInvestigationShadowCertificate(cleanWithoutCritic.certificate),
    );

    await expect(fixture.project.execute(cleanWithoutCritic)).rejects.toThrow(
      "investigation_shadow_verified_clean_critic_invalid",
    );
    await expect(
      fixture.project.execute(
        await projectionSource({ terminalPayload: cleanTerminalPayload() }),
      ),
    ).rejects.toThrow("investigation_shadow_conclusion_payload_mismatch");
    expect(fixture.store.all()).toHaveLength(0);
  });

  it("prunes only after the deterministic bounded retention horizon", async () => {
    const fixture = setup();
    const source = await projectionSource();
    await fixture.project.execute(source);
    const pruner = new PruneInvestigationShadowEvidence({
      records: fixture.store,
      clock: fixture.clock,
    });

    fixture.clock.set(issuedAtMs + investigationShadowEvidenceRetentionMs - 1);
    await expect(pruner.execute({ limit: 10 })).resolves.toBe(0);
    fixture.clock.set(issuedAtMs + investigationShadowEvidenceRetentionMs);
    await expect(pruner.execute({ limit: 10 })).resolves.toBe(1);
    expect(fixture.store.all()).toHaveLength(0);

    expect(() =>
      pruner.execute({ limit: investigationShadowEvidenceMaxPruneLimit + 1 }),
    ).toThrow("investigation_shadow_prune_limit_exceeded");
    fixture.clock.set(Number.NaN);
    expect(() => pruner.execute({ limit: 1 })).toThrow(
      "investigation_shadow_prune_now_ms_invalid",
    );
  });

  it("keeps the shadow ledger separate from normal observation persistence", async () => {
    const fixture = setup();
    const source = await projectionSource();
    const result = await fixture.project.execute(source);
    const directPersistence = await fixture.store.persist(result.evidence);

    expect(directPersistence.status).toBe(
      InvestigationShadowEvidencePersistenceStatus.Idempotent,
    );
    expect(result.evidence).not.toHaveProperty("sourceLeaseId");
    expect(result.evidence).not.toHaveProperty("attemptId");
    expect(result.evidence).not.toHaveProperty("providerInvocationKey");
  });
});

function setup() {
  const store = new InMemoryInvestigationShadowEvidenceStore();
  const clock = new FixedClock(issuedAtMs);
  return {
    store,
    clock,
    project: new ProjectInvestigationShadowEvidence({ records: store, digest }),
  };
}

async function projectionSource(
  input: { readonly terminalPayload?: string } = {},
): Promise<InvestigationShadowEvidenceProjectionSource> {
  const scope = {
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-1",
    scmRepositoryIdentityId: "scm-1",
    pullRequestNumber: 42,
    trustDomain: ReviewTrustDomain.TrustedManaged,
    authorizationScopeHash: hash("authorization-scope"),
  } as const;
  const terminalObservationCanonicalJson =
    input.terminalPayload ?? terminalPayload("finding body");
  const terminalOutcomeHash = hash(terminalObservationCanonicalJson);
  const certificate = {
    certificateId: "certificate-1",
    certificateHash: hash("placeholder"),
    investigationId: "investigation-1",
    investigationVersion: 7,
    dossierDigest: hash("dossier"),
    reviewRevisionHash: hash("revision"),
    stableReviewUnitKey: "unit-1",
    providerVoteLaneId: "lane-1",
    coverageContractVersion: "coverage-v1",
    expansionRulesVersion: "expansion-v1",
    gatewayPolicyVersion: "gateway-v1",
    criticPolicyVersion: "critic-v1",
    runtimeProfileVersion: "runtime-v1",
    producerReleaseId: "release-1",
    conclusion: InvestigationShadowEvidenceConclusion.Findings,
    findingSetHash: hash("findings"),
    obligationSetHash: hash("obligations"),
    receiptSetHash: hash("receipts"),
    scopeHash: hash(stableJson(investigationShadowScopeCanonicalValue(scope))),
    coverageStateHash: hash("coverage-state"),
    contextAttestationSetHash: hash("attestations"),
    turnProvenanceHash: hash("turn-provenance"),
    terminalProviderKind: ReviewProviderKind.Codex,
    terminalActualModel: "gpt-5.6-codex",
    terminalOutcomeHash,
    terminalObservationCanonicalJson,
    criticAttestationId: "attestation-critic-1",
    criticAttestationHash: hash("critic-attestation"),
    criticDecision: InvestigationShadowEvidenceCriticDecision.Accept,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + 24 * 60 * 60 * 1_000).toISOString(),
  };
  const certificateHash = hash(
    canonicalInvestigationShadowCertificate(certificate),
  );
  return {
    investigationId: certificate.investigationId,
    investigationVersion: certificate.investigationVersion + 1,
    certifiedDossierDigest: certificate.dossierDigest,
    scope,
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: certificate.reviewRevisionHash,
    },
    executionId: "execution-1",
    workSlotId: "slot-1",
    stableReviewUnitKey: certificate.stableReviewUnitKey,
    providerVoteLaneId: certificate.providerVoteLaneId,
    coverageContractVersion: certificate.coverageContractVersion,
    expansionRulesVersion: certificate.expansionRulesVersion,
    gatewayPolicyVersion: certificate.gatewayPolicyVersion,
    criticPolicyVersion: certificate.criticPolicyVersion,
    runtimeProfileVersion: certificate.runtimeProfileVersion,
    producerReleaseId: certificate.producerReleaseId,
    conclusion: certificate.conclusion,
    certificate: { ...certificate, certificateHash },
  };
}

function terminalPayload(message: string): string {
  return stableJson({
    normalizedFindings: [
      {
        category: "review_investigation",
        endLine: 10,
        evidence: ["receipt-1"],
        message,
        normalizedFailureModeHash: hash("failure"),
        path: "src/review.ts",
        placementConfidence: 1,
        severity: "major",
        startLine: 10,
        suggestion: null,
        title: "Finding",
      },
    ],
    normalizedLifecycleRevalidations: [],
    payloadVersion: 2,
    safeUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
}

function cleanTerminalPayload(): string {
  return stableJson({
    normalizedFindings: [],
    normalizedLifecycleRevalidations: [],
    payloadVersion: 2,
    safeUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
