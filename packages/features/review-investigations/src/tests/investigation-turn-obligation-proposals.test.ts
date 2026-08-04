import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContextCriticDecision,
  InvestigationEvidenceRequirementKind,
  InvestigationObligationKind,
  InvestigationOperationRevision,
  InvestigationTurnProviderKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationTurnPurpose,
  canonicalFileObligationSubject,
  canonicalInvestigationEvidenceRequirement,
  obligationEvidenceRequirementVersion,
  parseInvestigationTurnObservation,
} from "../index";

const digest = (character: string) => character.repeat(64);

describe("provider investigation obligation proposals", () => {
  it("accepts and freezes a canonical provider-neutral proposal", () => {
    const proposal = completeFileProposal();
    const parsed = parseInvestigationTurnObservation(observation([proposal]));

    expect(parsed.obligationProposals).toEqual([proposal]);
    expect(Object.isFrozen(parsed.obligationProposals)).toBe(true);
    expect(Object.isFrozen(parsed.obligationProposals[0])).toBe(true);
  });

  it("applies a server-owned critic risk floor", () => {
    const parsed = parseInvestigationTurnObservation(
      observation([{ ...completeFileProposal(), riskPriority: 0 }]),
    );

    expect(parsed.obligationProposals[0]?.riskPriority).toBe(800_000);
  });

  it("rejects unknown finding severity before aggregate mutation", () => {
    expect(() =>
      parseInvestigationTurnObservation({
        ...observation([]),
        findings: [
          {
            severity: "blocker",
            title: "Unsupported severity",
            body: "This value must not enter durable investigation state.",
            path: "src/caller.ts",
            line: 1,
            evidenceOperationReceiptIds: [],
          },
        ],
      }),
    ).toThrow("investigation_finding_severity_invalid");
  });

  it("rejects unknown, reserved, and extra proposal fields", () => {
    const valid = completeFileProposal();
    expect(() =>
      parseInvestigationTurnObservation(
        observation([{ ...valid, kind: "provider_specific_kind" }]),
      ),
    ).toThrow("investigation_obligation_proposal_kind_invalid");
    expect(() =>
      parseInvestigationTurnObservation(
        observation([
          { ...valid, kind: InvestigationObligationKind.ChangedContent },
        ]),
      ),
    ).toThrow("investigation_obligation_proposal_kind_unsupported");
    expect(() =>
      parseInvestigationTurnObservation(
        observation([{ ...valid, acceptedByServer: true }]),
      ),
    ).toThrow("investigation_obligation_proposal_shape_invalid");
  });

  it("rejects unknown, non-canonical, and unsupported requirements", () => {
    const valid = completeFileProposal();
    expect(() =>
      parseInvestigationTurnObservation(
        observation([
          {
            ...valid,
            canonicalRequirement: '{"kind":"unknown","requirementVersion":1}',
          },
        ]),
      ),
    ).toThrow("investigation_obligation_proposal_requirement_invalid");
    expect(() =>
      parseInvestigationTurnObservation(
        observation([
          {
            ...valid,
            canonicalRequirement: `${valid.canonicalRequirement} `,
          },
        ]),
      ),
    ).toThrow("investigation_obligation_proposal_requirement_invalid");
    expect(() =>
      parseInvestigationTurnObservation(
        observation([
          {
            ...valid,
            canonicalRequirement:
              '{"fact":"merge_base","kind":"complete_git_fact","requirementVersion":1}',
          },
        ]),
      ),
    ).toThrow("investigation_obligation_proposal_requirement_unsupported");
  });

  it("rejects a canonical requirement bound to the wrong subject", () => {
    expect(() =>
      parseInvestigationTurnObservation(
        observation([
          {
            ...completeFileProposal(),
            canonicalSubject: canonicalFileObligationSubject({
              pathHash: digest("b"),
              revision: InvestigationOperationRevision.Head,
            }),
          },
        ]),
      ),
    ).toThrow("investigation_obligation_proposal_subject_mismatch");
  });

  it.each([-1, 1.5, 1_000_001])(
    "rejects invalid risk priority %s",
    (riskPriority) => {
      expect(() =>
        parseInvestigationTurnObservation(
          observation([{ ...completeFileProposal(), riskPriority }]),
        ),
      ).toThrow("investigation_obligation_proposal_risk_priority_invalid");
    },
  );

  it("rejects duplicate proposal identities even when priority differs", () => {
    const proposal = completeFileProposal();
    expect(() =>
      parseInvestigationTurnObservation(
        observation([proposal, { ...proposal, riskPriority: 900_000 }]),
      ),
    ).toThrow("investigation_obligation_proposal_duplicate");
  });

  it("bounds proposal count and canonical text before commit", () => {
    const proposal = completeFileProposal();
    expect(() =>
      parseInvestigationTurnObservation(
        observation(Array.from({ length: 257 }, () => proposal)),
      ),
    ).toThrow("investigation_obligation_proposals_invalid");
    expect(() =>
      parseInvestigationTurnObservation(
        observation([{ ...proposal, canonicalSubject: "x".repeat(4_097) }]),
      ),
    ).toThrow("investigation_obligation_proposal_subject_invalid");
    expect(() =>
      parseInvestigationTurnObservation(
        observation([
          { ...proposal, canonicalRequirement: "x".repeat(64_001) },
        ]),
      ),
    ).toThrow("investigation_obligation_proposal_requirement_invalid");
  });
});

function completeFileProposal() {
  const requirement = {
    requirementVersion: obligationEvidenceRequirementVersion,
    kind: InvestigationEvidenceRequirementKind.CompleteFile,
    path: "src/caller.ts",
    pathHash: pathHash("src/caller.ts"),
    revision: InvestigationOperationRevision.Head,
  } as const;
  return Object.freeze({
    kind: InvestigationObligationKind.DirectCaller,
    canonicalSubject: canonicalFileObligationSubject(requirement),
    canonicalRequirement:
      canonicalInvestigationEvidenceRequirement(requirement),
    riskPriority: 800_000,
  });
}

function pathHash(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

function observation(obligationProposals: readonly unknown[]) {
  return {
    outputVersion: 2,
    findings: [],
    obligationProposals,
    closureClaims: [],
    operationBackedDiscoveryClaims: [],
    unresolvableClaims: [],
    criticDecision: null as ContextCriticDecision | null,
    observationVersion: 2,
    invocationId: "investigation-1:turn-1:attempt-1",
    turnId: "turn-1",
    dossierVersion: 2,
    purpose: ReviewInvestigationTurnPurpose.Discovery,
    actualProviderKind: InvestigationTurnProviderKind.Codex,
    actualModel: "gpt-5.6-sol",
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 115,
    },
    durationMs: 1_000,
    schemaComplete: true,
    streamComplete: true,
    contextAttestationReference: "attestation-1",
  };
}
