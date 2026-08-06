import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CommitAttestedInvestigationTurn,
  CommitInvestigationTurn,
  ContextCriticDecision,
  InvestigationBinaryArtifactContentKind,
  InvestigationFileContentKind,
  InvestigationFindingSeverity,
  InvestigationEvidenceRequirementKind,
  InvestigationObligationKind,
  InvestigationObligationOrigin,
  InvestigationOperationKind,
  InvestigationOperationRevision,
  InvestigationProbeKind,
  InvestigationTurnProviderKind,
  OpenReviewInvestigation,
  PlanNextInvestigationTurn,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
  canonicalInvestigationTerminalObservation,
  canonicalInvestigationTurnObservation,
  canonicalBinaryArtifactBoundarySubject,
  canonicalInvestigationEvidenceRequirement,
  canonicalInventoryObligationSubject,
  canonicalInventoryObligationSubjectV2,
  canonicalFileObligationSubject,
  canonicalPageObligationSubjectV2,
  canonicalStandardTextSearchOperationInput,
  obligationEvidenceRequirementVersion,
  obligationEvidenceRequirementVersionV2,
  InvestigationTextSearchMatchMode,
  parseInvestigationTurnObservation,
  reviewInvestigationCoverageProfileV2,
  type InvestigationTurnEvidencePort,
  type InvestigationTurnObservation,
  type ReviewInvestigation,
} from "../index";
import { InMemoryInvestigationStore } from "../infrastructure/memory/in-memory-investigation-store";
import { AesGcmInvestigationPrivateMaterialCipher } from "../infrastructure/crypto/aes-gcm-investigation-private-material-cipher";
import { NodeSha256InvestigationDigest } from "../infrastructure/node/node-sha256-digest";
import { PrepareInvestigationSearchQueryPrivateMaterial } from "../application/use-cases/prepare-investigation-search-query-private-material";
import {
  CurrentInvestigationExecutionAuthority,
  FixedInvestigationClock,
  digestBackedInvestigationManifestIdentity,
} from "../testing";

const hash = (character: string) => character.repeat(64);

describe("CommitAttestedInvestigationTurn", () => {
  it("turns an attested binary suggestion into a deterministic unresolvable decision", async () => {
    const store = new InMemoryInvestigationStore();
    const authority = new CurrentInvestigationExecutionAuthority();
    const clock = new FixedInvestigationClock(
      new Date("2026-08-02T10:00:00.000Z"),
    );
    const digest = new NodeSha256InvestigationDigest();
    const revisionHash = hash("4");
    const path = "assets/logo.bin";
    const pathHash = await digest.digestUtf8(path);
    const inventoryPathSetHash = await digest.digestUtf8(
      JSON.stringify([pathHash]),
    );
    const inventoryRequirement = {
      requirementVersion: obligationEvidenceRequirementVersionV2,
      kind: InvestigationEvidenceRequirementKind.CompleteInventory,
      reviewRevisionHash: revisionHash,
      treeOid: "3".repeat(40),
      aggregateItemCount: 1,
      aggregateHash: hash("2"),
      aggregatePathCount: 1,
      aggregatePathSetHash: inventoryPathSetHash,
    } as const;
    const boundaryRequirement = {
      requirementVersion: obligationEvidenceRequirementVersion,
      kind: InvestigationEvidenceRequirementKind.BinaryArtifactBoundary,
      path,
      pathHash,
      revision: InvestigationOperationRevision.Head,
      contentKind: InvestigationBinaryArtifactContentKind.Binary,
      mode: "100644",
      objectOid: "5".repeat(40),
      byteCount: 128,
      status: "added",
    } as const;
    const opened = await new OpenReviewInvestigation(
      store,
      authority,
      digest,
      digestBackedInvestigationManifestIdentity(digest),
      clock,
    ).execute({
      commandId: "open-binary-unresolvable",
      scope: {
        workspaceId: "workspace-1",
        repositoryConnectionId: "repository-1",
        scmRepositoryIdentityId: "identity-1",
        pullRequestNumber: 1,
        trustDomain: "trusted_managed",
        authorizationScopeHash: hash("9"),
      },
      revision: {
        baseSha: "1".repeat(40),
        mergeBaseSha: "2".repeat(40),
        headSha: "3".repeat(40),
        reviewRevisionHash: revisionHash,
      },
      executionId: "execution-1",
      workSlotId: "work-slot-1",
      stableReviewUnitKey: "review-unit-binary",
      providerVoteLaneId: "provider-lane-1",
      providerStrategyId: "codex-primary",
      investigationManifestCanonicalJson: "{}",
      investigationManifestHash:
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
      contract: {
        ...reviewInvestigationCoverageProfileV2,
        producerReleaseId: "release-1",
      },
      policy: {
        policyId: "policy-1",
        maxObligations: 32,
        maxExpansionDepth: 4,
        maxSemanticTurns: 8,
        maxOperationalAttempts: 4,
        maxCriticCycles: 2,
        maxFindings: 32,
        maxProposalsPerTurn: 16,
        maxReceiptsPerTurn: 32,
        maxSeedProbesPerFile: 48,
        maxSeedProbesOverall: 384,
      },
      seedObligations: [
        {
          kind: InvestigationObligationKind.InventoryWitness,
          canonicalSubject:
            canonicalInventoryObligationSubjectV2(inventoryRequirement),
          canonicalRequirement:
            canonicalInvestigationEvidenceRequirement(inventoryRequirement),
          riskPriority: 1_000_000,
        },
        {
          kind: InvestigationObligationKind.ChangedContent,
          canonicalSubject: canonicalFileObligationSubject({
            pathHash,
            revision: InvestigationOperationRevision.Head,
          }),
          canonicalRequirement: canonicalInvestigationEvidenceRequirement({
            requirementVersion: obligationEvidenceRequirementVersionV2,
            kind: InvestigationEvidenceRequirementKind.CompleteChangedFile,
            path,
            pathHash,
            revision: InvestigationOperationRevision.Head,
          }),
          riskPriority: 900_000,
        },
        {
          kind: InvestigationObligationKind.BinaryArtifact,
          canonicalSubject:
            canonicalBinaryArtifactBoundarySubject(boundaryRequirement),
          canonicalRequirement:
            canonicalInvestigationEvidenceRequirement(boundaryRequirement),
          riskPriority: 800_000,
        },
      ],
      initialReceipts: [],
    });
    const inventoryPlan = await new PlanNextInvestigationTurn(
      store,
      authority,
      digest,
      clock,
    ).execute({
      commandId: "plan-binary-unresolvable",
      investigationId: opened.investigationId,
      expectedVersion: opened.version,
      leaseDurationMs: 300_000,
      maxObligationsForTurn: 8,
    });
    const provisional = (await store.findById(opened.investigationId))!;
    const inventory = provisional.obligations.find(
      (item) => item.kind === InvestigationObligationKind.InventoryWitness,
    )!;
    const inventoryReceiptId = hash("9");
    const inventoryObservation = observationFixture({
      turnId: inventoryPlan.turn!.turnId,
      dossierVersion: inventoryPlan.version,
      obligationId: inventory.obligationId,
      operationReceiptId: inventoryReceiptId,
    });
    const inventoryTerminalOutcomeHash = await digest.digestUtf8(
      canonicalInvestigationTerminalObservation(inventoryObservation),
    );
    const inventoryEvidence = {
      verify: vi
        .fn<InvestigationTurnEvidencePort["verify"]>()
        .mockResolvedValue({
          acceptedAttestationId: "attestation-1",
          acceptedAttestationHash: hash("8"),
          terminalOutcomeHash: inventoryTerminalOutcomeHash,
          gatewayPolicyVersion:
            reviewInvestigationCoverageProfileV2.gatewayPolicyVersion,
          actualProviderKind: InvestigationTurnProviderKind.Codex,
          operations: [
            inventoryOperationEvidence({
              operationReceiptId: inventoryReceiptId,
              pathHash,
              pathSetHash: inventoryPathSetHash,
              requirement: inventoryRequirement,
            }),
          ],
        }),
    };
    const inventoryFence = await acquireTestLease(store, provisional, {
      leaseId: "lease-inventory",
      attemptId: "attempt-inventory",
    });
    const afterInventory = await new CommitAttestedInvestigationTurn(
      store,
      inventoryEvidence,
      digest,
      new CommitInvestigationTurn(store, authority, digest, clock),
    ).execute({
      commandId: "commit-binary-inventory",
      investigationId: opened.investigationId,
      expectedVersion: inventoryPlan.version,
      turnId: inventoryPlan.turn!.turnId,
      sourceAttemptId: "attempt-inventory",
      sourceLeaseId: "lease-inventory",
      sourceFencingToken: inventoryFence,
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      turnObservationHash: await digest.digestUtf8(
        canonicalInvestigationTurnObservation(inventoryObservation),
      ),
      observation: inventoryObservation,
    });
    const planned = await new PlanNextInvestigationTurn(
      store,
      authority,
      digest,
      clock,
    ).execute({
      commandId: "plan-binary-boundary",
      investigationId: opened.investigationId,
      expectedVersion: afterInventory.version,
      leaseDurationMs: 300_000,
      maxObligationsForTurn: 8,
    });
    const current = (await store.findById(opened.investigationId))!;
    const boundary = current.obligations.find(
      (item) => item.kind === InvestigationObligationKind.BinaryArtifact,
    )!;
    const receiptId = hash("binary-receipt");
    const observation = {
      ...observationFixture({
        turnId: planned.turn!.turnId,
        dossierVersion: planned.version,
        obligationId: boundary.obligationId,
        operationReceiptId: receiptId,
        closureClaim: false,
      }),
      unresolvableClaims: [
        {
          obligationId: boundary.obligationId,
          reason: "provider cannot decode this artifact",
          evidenceOperationReceiptIds: [receiptId],
        },
      ],
    } as const;
    const terminalOutcomeHash = await digest.digestUtf8(
      canonicalInvestigationTerminalObservation(observation),
    );
    const evidence = {
      verify: vi
        .fn<InvestigationTurnEvidencePort["verify"]>()
        .mockResolvedValue({
          acceptedAttestationId: "attestation-1",
          acceptedAttestationHash: hash("8"),
          terminalOutcomeHash,
          gatewayPolicyVersion:
            reviewInvestigationCoverageProfileV2.gatewayPolicyVersion,
          actualProviderKind: InvestigationTurnProviderKind.Codex,
          operations: [
            inventoryOperationEvidence({
              operationReceiptId: receiptId,
              pathHash,
              pathSetHash: inventoryPathSetHash,
              requirement: inventoryRequirement,
            }),
          ],
        }),
    };
    const fence = await acquireTestLease(store, current, {
      leaseId: "lease-1",
      attemptId: "attempt-1",
    });
    const result = await new CommitAttestedInvestigationTurn(
      store,
      evidence,
      digest,
      new CommitInvestigationTurn(store, authority, digest, clock),
    ).execute({
      commandId: "commit-binary-unresolvable",
      investigationId: opened.investigationId,
      expectedVersion: planned.version,
      turnId: planned.turn!.turnId,
      sourceAttemptId: "attempt-1",
      sourceLeaseId: "lease-1",
      sourceFencingToken: fence,
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      turnObservationHash: await digest.digestUtf8(
        canonicalInvestigationTurnObservation(observation),
      ),
      observation,
    });

    expect(result.unresolvableObligationCount).toBe(1);
    expect((await store.findById(opened.investigationId))!.obligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          obligationId: boundary.obligationId,
          state: "unresolvable",
          unresolvableReason: "specialized_artifact_decoder_unavailable:binary",
        }),
      ]),
    );
  });

  it("binds an accepted gateway attestation and operation receipt", async () => {
    const fixture = await createFixture();
    const observation = observationFixture({
      turnId: fixture.turnId,
      dossierVersion: fixture.planned.version,
      obligationId: fixture.obligationId,
      operationReceiptId: hash("9"),
    });
    const terminalOutcomeHash = await fixture.digest.digestUtf8(
      canonicalInvestigationTerminalObservation(observation),
    );
    fixture.evidence.verify.mockResolvedValue(
      Object.freeze({
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
        terminalOutcomeHash,
        gatewayPolicyVersion: "context-gateway-v4",
        actualProviderKind: InvestigationTurnProviderKind.Codex,
        operations: Object.freeze([
          Object.freeze({
            operationReceiptId: hash("9"),
            operationKey: hash("7"),
            sequence: 1,
            operationKind: InvestigationOperationKind.CanonicalInventory,
            operationInputHash: hash("5"),
            evidenceDigest: hash("6"),
            treeOid: "3".repeat(40),
            queryDigest: hash("4"),
            cursorInputHash: null,
            pageOrdinal: 0,
            pageItemCount: 1,
            pageItemsHash: hash("3"),
            pagePathHashes: [],
            aggregatePathCount: 0,
            aggregatePathSetHash: await fixture.digest.digestUtf8(
              JSON.stringify([]),
            ),
            aggregateItemCount: 1,
            aggregateHash: hash("2"),
            complete: true,
            nextCursorHash: null,
          }),
        ]),
      }),
    );

    const result = await fixture.commit.execute({
      commandId: "commit-attested-1",
      investigationId: fixture.planned.investigationId,
      expectedVersion: fixture.planned.version,
      turnId: fixture.turnId,
      sourceAttemptId: "attempt-1",
      sourceLeaseId: "lease-1",
      sourceFencingToken: "1",
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      turnObservationHash: await fixture.digest.digestUtf8(
        canonicalInvestigationTurnObservation(observation),
      ),
      observation,
    });

    expect(result.state).toBe(ReviewInvestigationState.AwaitingCritic);
    expect(result.satisfiedObligationCount).toBe(1);
    const acceptedReceipt = (
      await fixture.store.findById(fixture.planned.investigationId)
    )?.obligations.find(
      (item) => item.obligationId === fixture.obligationId,
    )?.receipt;
    expect(acceptedReceipt).toMatchObject({
      operationReceiptIds: [hash("9")],
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
    });
    expect(fixture.evidence.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceExecutionId: "execution-1",
        sourceWorkSlotId: "work-slot-1",
        terminalOutcomeHash,
      }),
    );
  });

  it("accepts a finding only when complete head-file evidence binds its path and line", async () => {
    const fixture = await createFixture();
    const path = "src/service.ts";
    const receiptId = hash("9");
    const observation = {
      ...observationFixture({
        turnId: fixture.turnId,
        dossierVersion: fixture.planned.version,
        obligationId: fixture.obligationId,
        operationReceiptId: receiptId,
        closureClaim: false,
      }),
      findings: [
        {
          severity: InvestigationFindingSeverity.Major,
          title: "Broken caller",
          body: "The caller observes an invalid state.",
          path,
          line: 2,
          evidenceOperationReceiptIds: [receiptId],
        },
      ],
    } as const;
    const terminalOutcomeHash = await fixture.digest.digestUtf8(
      canonicalInvestigationTerminalObservation(observation),
    );
    fixture.evidence.verify.mockResolvedValue({
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      terminalOutcomeHash,
      gatewayPolicyVersion: "context-gateway-v4",
      actualProviderKind: InvestigationTurnProviderKind.Codex,
      operations: [
        await completeTextFileEvidence(fixture.digest, {
          receiptId,
          path,
          lineCount: 3,
        }),
      ],
    });

    const result = await fixture.commit.execute({
      commandId: "commit-attested-finding",
      investigationId: fixture.planned.investigationId,
      expectedVersion: fixture.planned.version,
      turnId: fixture.turnId,
      sourceAttemptId: "attempt-1",
      sourceLeaseId: "lease-1",
      sourceFencingToken: "1",
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      turnObservationHash: await fixture.digest.digestUtf8(
        canonicalInvestigationTurnObservation(observation),
      ),
      observation,
    });

    expect(result.findingCount).toBe(1);
  });

  it.each([
    [
      "unrelated path",
      "src/unrelated.ts",
      2,
      "investigation_finding_evidence_path_invalid",
    ],
    [
      "out-of-range line",
      "src/service.ts",
      4,
      "investigation_finding_evidence_line_invalid",
    ],
  ])(
    "rejects finding evidence for %s without mutating the investigation",
    async (_case, evidencePath, line, expectedError) => {
      const fixture = await createFixture();
      const path = "src/service.ts";
      const receiptId = hash("9");
      const observation = {
        ...observationFixture({
          turnId: fixture.turnId,
          dossierVersion: fixture.planned.version,
          obligationId: fixture.obligationId,
          operationReceiptId: receiptId,
          closureClaim: false,
        }),
        findings: [
          {
            severity: InvestigationFindingSeverity.Critical,
            title: "Unbound finding",
            body: "This must not enter durable review state.",
            path,
            line,
            evidenceOperationReceiptIds: [receiptId],
          },
        ],
      } as const;
      const terminalOutcomeHash = await fixture.digest.digestUtf8(
        canonicalInvestigationTerminalObservation(observation),
      );
      fixture.evidence.verify.mockResolvedValue({
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
        terminalOutcomeHash,
        gatewayPolicyVersion: "context-gateway-v4",
        actualProviderKind: InvestigationTurnProviderKind.Codex,
        operations: [
          await completeTextFileEvidence(fixture.digest, {
            receiptId,
            path: evidencePath,
            lineCount: 3,
          }),
        ],
      });

      await expect(
        fixture.commit.execute({
          commandId: `commit-invalid-finding-${line}`,
          investigationId: fixture.planned.investigationId,
          expectedVersion: fixture.planned.version,
          turnId: fixture.turnId,
          sourceAttemptId: "attempt-1",
          sourceLeaseId: "lease-1",
          sourceFencingToken: "1",
          acceptedAttestationId: "attestation-1",
          acceptedAttestationHash: hash("8"),
          turnObservationHash: await fixture.digest.digestUtf8(
            canonicalInvestigationTurnObservation(observation),
          ),
          observation,
        }),
      ).rejects.toThrow(expectedError);
      expect(
        (await fixture.store.findById(fixture.planned.investigationId))
          ?.version,
      ).toBe(fixture.planned.version);
    },
  );

  it.each([
    [
      "partial file",
      (base: CompleteTextFileEvidence) => [
        { ...base, byteCount: 32, eof: false, complete: false },
      ],
      "investigation_finding_evidence_path_invalid",
    ],
    [
      "gapped chunks",
      (base: CompleteTextFileEvidence) => [
        { ...base, byteCount: 16, eof: false, complete: false },
        {
          ...base,
          operationReceiptId: hash("a"),
          sequence: 2,
          startByte: 32,
          byteCount: 32,
        },
      ],
      "investigation_finding_evidence_path_invalid",
    ],
    [
      "overlapping chunks",
      (base: CompleteTextFileEvidence) => [
        { ...base, byteCount: 32, eof: false, complete: false },
        {
          ...base,
          operationReceiptId: hash("a"),
          sequence: 2,
          startByte: 16,
          byteCount: 48,
        },
      ],
      "investigation_finding_evidence_path_invalid",
    ],
    [
      "merge-base file",
      (base: CompleteTextFileEvidence) => [
        { ...base, revision: InvestigationOperationRevision.MergeBase },
      ],
      "investigation_finding_evidence_path_invalid",
    ],
    [
      "binary file with a line claim",
      (base: CompleteTextFileEvidence) => [
        {
          ...base,
          contentKind: InvestigationFileContentKind.Binary,
          lineCount: null,
        },
      ],
      "investigation_finding_evidence_line_invalid",
    ],
  ] as const)(
    "rejects finding evidence backed by a %s without mutation",
    async (_case, evidenceVariant, expectedError) => {
      const fixture = await createFixture();
      const path = "src/service.ts";
      const base = await completeTextFileEvidence(fixture.digest, {
        receiptId: hash("9"),
        path,
        lineCount: 3,
      });
      const operations = evidenceVariant(base);
      const receiptIds = operations.map(
        (operation) => operation.operationReceiptId,
      );
      const observation = {
        ...observationFixture({
          turnId: fixture.turnId,
          dossierVersion: fixture.planned.version,
          obligationId: fixture.obligationId,
          operationReceiptId: receiptIds[0]!,
          closureClaim: false,
        }),
        findings: [
          {
            severity: InvestigationFindingSeverity.Critical,
            title: "Unbound finding",
            body: "This must not enter durable review state.",
            path,
            line: 2,
            evidenceOperationReceiptIds: receiptIds,
          },
        ],
      } as const;
      const terminalOutcomeHash = await fixture.digest.digestUtf8(
        canonicalInvestigationTerminalObservation(observation),
      );
      fixture.evidence.verify.mockResolvedValue({
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
        terminalOutcomeHash,
        gatewayPolicyVersion: "context-gateway-v4",
        actualProviderKind: InvestigationTurnProviderKind.Codex,
        operations,
      });

      await expect(
        fixture.commit.execute({
          commandId: `commit-invalid-finding-${_case}`,
          investigationId: fixture.planned.investigationId,
          expectedVersion: fixture.planned.version,
          turnId: fixture.turnId,
          sourceAttemptId: "attempt-1",
          sourceLeaseId: "lease-1",
          sourceFencingToken: "1",
          acceptedAttestationId: "attestation-1",
          acceptedAttestationHash: hash("8"),
          turnObservationHash: await fixture.digest.digestUtf8(
            canonicalInvestigationTurnObservation(observation),
          ),
          observation,
        }),
      ).rejects.toThrow(expectedError);
      expect(
        (await fixture.store.findById(fixture.planned.investigationId))
          ?.version,
      ).toBe(fixture.planned.version);
    },
  );

  it("commits a parsed provider proposal as a server-owned open obligation", async () => {
    const fixture = await createFixture();
    const requirement = {
      requirementVersion: obligationEvidenceRequirementVersion,
      kind: InvestigationEvidenceRequirementKind.CompleteFile,
      path: "src/caller.ts",
      pathHash: createHash("sha256")
        .update("src/caller.ts", "utf8")
        .digest("hex"),
      revision: InvestigationOperationRevision.Head,
    } as const;
    const observation = parseInvestigationTurnObservation(
      observationFixture({
        turnId: fixture.turnId,
        dossierVersion: fixture.planned.version,
        obligationId: fixture.obligationId,
        operationReceiptId: hash("9"),
        closureClaim: false,
        obligationProposals: [
          {
            kind: InvestigationObligationKind.DirectCaller,
            canonicalSubject: canonicalFileObligationSubject(requirement),
            canonicalRequirement:
              canonicalInvestigationEvidenceRequirement(requirement),
            riskPriority: 0,
          },
        ],
      }),
    );
    const terminalOutcomeHash = await fixture.digest.digestUtf8(
      canonicalInvestigationTerminalObservation(observation),
    );
    fixture.evidence.verify.mockResolvedValue({
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      terminalOutcomeHash,
      gatewayPolicyVersion: "context-gateway-v4",
      actualProviderKind: InvestigationTurnProviderKind.Codex,
      operations: [],
    });

    const result = await fixture.commit.execute({
      commandId: "commit-provider-proposal",
      investigationId: fixture.planned.investigationId,
      expectedVersion: fixture.planned.version,
      turnId: fixture.turnId,
      sourceAttemptId: "attempt-1",
      sourceLeaseId: "lease-1",
      sourceFencingToken: "1",
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      turnObservationHash: await fixture.digest.digestUtf8(
        canonicalInvestigationTurnObservation(observation),
      ),
      observation,
    });
    const aggregate = await fixture.store.findById(result.investigationId);
    const proposal = aggregate!.obligations.find(
      (obligation) =>
        obligation.kind === InvestigationObligationKind.DirectCaller,
    );

    expect(proposal).toMatchObject({
      canonicalSubject: canonicalFileObligationSubject(requirement),
      canonicalRequirement:
        canonicalInvestigationEvidenceRequirement(requirement),
      riskPriority: 800_000,
      origin: InvestigationObligationOrigin.AgentProposal,
      state: "open",
      receipt: null,
      unresolvableReason: null,
    });
    expect(proposal?.obligationId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a provider proposal whose path hash is not derived from its path", async () => {
    const fixture = await createFixture();
    const requirement = {
      requirementVersion: obligationEvidenceRequirementVersion,
      kind: InvestigationEvidenceRequirementKind.CompleteFile,
      path: "src/caller.ts",
      pathHash: hash("b"),
      revision: InvestigationOperationRevision.Head,
    } as const;
    const observation = parseInvestigationTurnObservation(
      observationFixture({
        turnId: fixture.turnId,
        dossierVersion: fixture.planned.version,
        obligationId: fixture.obligationId,
        operationReceiptId: hash("9"),
        closureClaim: false,
        obligationProposals: [
          {
            kind: InvestigationObligationKind.DirectCaller,
            canonicalSubject: canonicalFileObligationSubject(requirement),
            canonicalRequirement:
              canonicalInvestigationEvidenceRequirement(requirement),
            riskPriority: 800_000,
          },
        ],
      }),
    );
    const terminalOutcomeHash = await fixture.digest.digestUtf8(
      canonicalInvestigationTerminalObservation(observation),
    );
    fixture.evidence.verify.mockResolvedValue({
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      terminalOutcomeHash,
      gatewayPolicyVersion: "context-gateway-v4",
      actualProviderKind: InvestigationTurnProviderKind.Codex,
      operations: [],
    });

    await expect(
      fixture.commit.execute({
        commandId: "commit-provider-proposal-path-mismatch",
        investigationId: fixture.planned.investigationId,
        expectedVersion: fixture.planned.version,
        turnId: fixture.turnId,
        sourceAttemptId: "attempt-1",
        sourceLeaseId: "lease-1",
        sourceFencingToken: "1",
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
        turnObservationHash: await fixture.digest.digestUtf8(
          canonicalInvestigationTurnObservation(observation),
        ),
        observation,
      }),
    ).rejects.toThrow("investigation_obligation_proposal_path_hash_mismatch");
    expect(
      (await fixture.store.findById(fixture.planned.investigationId))?.version,
    ).toBe(fixture.planned.version);
  });

  it("fails closed when attestation evidence is unavailable", async () => {
    const fixture = await createFixture();
    const observation = observationFixture({
      turnId: fixture.turnId,
      dossierVersion: fixture.planned.version,
      obligationId: fixture.obligationId,
      operationReceiptId: hash("9"),
    });
    fixture.evidence.verify.mockResolvedValue(null);

    await expect(
      fixture.commit.execute({
        commandId: "commit-attested-denied",
        investigationId: fixture.planned.investigationId,
        expectedVersion: fixture.planned.version,
        turnId: fixture.turnId,
        sourceAttemptId: "attempt-1",
        sourceLeaseId: "lease-1",
        sourceFencingToken: "1",
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
        turnObservationHash: await fixture.digest.digestUtf8(
          canonicalInvestigationTurnObservation(observation),
        ),
        observation,
      }),
    ).rejects.toThrow("investigation_turn_attestation_invalid");
    expect(
      (await fixture.store.findById(fixture.planned.investigationId))?.version,
    ).toBe(fixture.planned.version);
  });

  it("rejects a provider kind claimed by the agent that differs from the trusted session", async () => {
    const fixture = await createFixture();
    const observation = observationFixture({
      turnId: fixture.turnId,
      dossierVersion: fixture.planned.version,
      obligationId: fixture.obligationId,
      operationReceiptId: hash("9"),
    });
    const terminalOutcomeHash = await fixture.digest.digestUtf8(
      canonicalInvestigationTerminalObservation(observation),
    );
    fixture.evidence.verify.mockResolvedValue({
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      terminalOutcomeHash,
      gatewayPolicyVersion: "context-gateway-v4",
      actualProviderKind: InvestigationTurnProviderKind.ClaudeCode,
      operations: [],
    });

    await expect(
      fixture.commit.execute({
        commandId: "commit-provider-spoof-denied",
        investigationId: fixture.planned.investigationId,
        expectedVersion: fixture.planned.version,
        turnId: fixture.turnId,
        sourceAttemptId: "attempt-1",
        sourceLeaseId: "lease-1",
        sourceFencingToken: "1",
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
        turnObservationHash: await fixture.digest.digestUtf8(
          canonicalInvestigationTurnObservation(observation),
        ),
        observation,
      }),
    ).rejects.toThrow("investigation_turn_attestation_invalid");
  });

  it("rejects non-canonical or incomplete observation shapes", () => {
    expect(() =>
      parseInvestigationTurnObservation({
        ...observationFixture({
          turnId: "turn-1",
          dossierVersion: 2,
          obligationId: hash("5"),
          operationReceiptId: hash("9"),
        }),
        schemaComplete: false,
      }),
    ).toThrow("investigation_turn_observation_incomplete");

    expect(() =>
      parseInvestigationTurnObservation({
        ...observationFixture({
          turnId: "turn-1",
          dossierVersion: 2,
          obligationId: hash("5"),
          operationReceiptId: hash("9"),
        }),
        outputVersion: 1,
        observationVersion: 1,
      }),
    ).toThrow("investigation_turn_observation_incomplete");
  });

  it("enforces app-server token usage semantics", () => {
    const fixture = observationFixture({
      turnId: "turn-1",
      dossierVersion: 2,
      obligationId: hash("5"),
      operationReceiptId: hash("9"),
    });

    expect(parseInvestigationTurnObservation(fixture).usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 110,
    });
    expect(() =>
      parseInvestigationTurnObservation({
        ...fixture,
        usage: { ...fixture.usage, totalTokens: 115 },
      }),
    ).toThrow("investigation_turn_usage_invalid");
    expect(() =>
      parseInvestigationTurnObservation({
        ...fixture,
        usage: {
          ...fixture.usage,
          reasoningOutputTokens: 11,
        },
      }),
    ).toThrow("investigation_turn_usage_invalid");
  });

  it("copies and freezes operation-backed claim arrays", () => {
    const operationReceiptIds = [hash("9")];
    const claims = [
      {
        sourceObligationId: hash("5"),
        query: "service",
        operationReceiptIds,
      },
    ];
    const parsed = parseInvestigationTurnObservation({
      ...observationFixture({
        turnId: "turn-1",
        dossierVersion: 2,
        obligationId: hash("5"),
        operationReceiptId: hash("9"),
        closureClaim: false,
      }),
      operationBackedDiscoveryClaims: claims,
    });

    operationReceiptIds.push(hash("8"));
    claims.push({
      sourceObligationId: hash("6"),
      query: "other",
      operationReceiptIds: [hash("7")],
    });

    expect(parsed.operationBackedDiscoveryClaims).toHaveLength(1);
    expect(
      parsed.operationBackedDiscoveryClaims[0]!.operationReceiptIds,
    ).toEqual([hash("9")]);
    expect(Object.isFrozen(parsed.operationBackedDiscoveryClaims)).toBe(true);
    expect(
      Object.isFrozen(
        parsed.operationBackedDiscoveryClaims[0]!.operationReceiptIds,
      ),
    ).toBe(true);
  });

  it("rejects an operation-backed claim whose receipt is not attested", async () => {
    const fixture = await createFixture();
    const observation = observationFixture({
      turnId: fixture.turnId,
      dossierVersion: fixture.planned.version,
      obligationId: fixture.obligationId,
      operationReceiptId: hash("9"),
      closureClaim: false,
      discoveryQuery: "service",
    });
    const terminalOutcomeHash = await fixture.digest.digestUtf8(
      canonicalInvestigationTerminalObservation(observation),
    );
    fixture.evidence.verify.mockResolvedValue({
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      terminalOutcomeHash,
      gatewayPolicyVersion: "context-gateway-v4",
      actualProviderKind: InvestigationTurnProviderKind.Codex,
      operations: [],
    });

    await expect(
      fixture.commit.execute({
        commandId: "commit-missing-discovery-receipt",
        investigationId: fixture.planned.investigationId,
        expectedVersion: fixture.planned.version,
        turnId: fixture.turnId,
        sourceAttemptId: "attempt-1",
        sourceLeaseId: "lease-1",
        sourceFencingToken: "1",
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
        turnObservationHash: await fixture.digest.digestUtf8(
          canonicalInvestigationTurnObservation(observation),
        ),
        observation,
      }),
    ).rejects.toThrow("investigation_operation_receipt_missing");
  });

  it("expands every closed typed search even when the agent reports no discovery claim", async () => {
    const store = new InMemoryInvestigationStore();
    const authority = new CurrentInvestigationExecutionAuthority();
    const clock = new FixedInvestigationClock(
      new Date("2026-08-02T10:00:00.000Z"),
    );
    const digest = new NodeSha256InvestigationDigest();
    const revisionHash = hash("4");
    const pathHash = await digest.digestUtf8("src/service.ts");
    const query = "service";
    const queryHash = await digest.digestUtf8(query);
    const operationInputHash = await digest.digestUtf8(
      canonicalStandardTextSearchOperationInput(queryHash),
    );
    const matchedPathHash = hash("e");
    const matchedPathSetHash = await digest.digestUtf8(
      JSON.stringify([matchedPathHash]),
    );
    const opened = await new OpenReviewInvestigation(
      store,
      authority,
      digest,
      digestBackedInvestigationManifestIdentity(digest),
      clock,
      undefined,
      privateMaterialPreparer(digest),
    ).execute({
      commandId: "open-expansion-1",
      scope: {
        workspaceId: "workspace-1",
        repositoryConnectionId: "repository-1",
        scmRepositoryIdentityId: "identity-1",
        pullRequestNumber: 1,
        trustDomain: "trusted_managed",
        authorizationScopeHash: hash("9"),
      },
      revision: {
        baseSha: "1".repeat(40),
        mergeBaseSha: "2".repeat(40),
        headSha: "3".repeat(40),
        reviewRevisionHash: revisionHash,
      },
      executionId: "execution-1",
      workSlotId: "work-slot-1",
      stableReviewUnitKey: "review-unit-1",
      providerVoteLaneId: "provider-lane-1",
      providerStrategyId: "codex-primary",
      investigationManifestCanonicalJson: "{}",
      investigationManifestHash:
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
      contract: {
        ...reviewInvestigationCoverageProfileV2,
        producerReleaseId: "release-1",
      },
      policy: {
        policyId: "policy-1",
        maxObligations: 32,
        maxExpansionDepth: 4,
        maxSemanticTurns: 8,
        maxOperationalAttempts: 4,
        maxCriticCycles: 2,
        maxFindings: 32,
        maxProposalsPerTurn: 16,
        maxReceiptsPerTurn: 32,
        maxSeedProbesPerFile: 48,
        maxSeedProbesOverall: 384,
      },
      seedObligations: [
        inventorySeedV2({ reviewRevisionHash: revisionHash }),
        {
          kind: InvestigationObligationKind.ChangedContent,
          canonicalSubject: canonicalFileObligationSubject({
            pathHash,
            revision: InvestigationOperationRevision.Head,
          }),
          canonicalRequirement: canonicalInvestigationEvidenceRequirement({
            requirementVersion: obligationEvidenceRequirementVersionV2,
            kind: InvestigationEvidenceRequirementKind.CompleteChangedFile,
            path: "src/service.ts",
            pathHash,
            revision: InvestigationOperationRevision.Head,
          }),
          riskPriority: 800_000,
        },
        {
          kind: InvestigationObligationKind.DirectReferenceSearch,
          canonicalSubject: canonicalPageObligationSubjectV2({
            obligationKind: InvestigationObligationKind.DirectReferenceSearch,
            initialOperationInputHash: operationInputHash,
            probeKind: InvestigationProbeKind.DeclarationIdentifier,
            queryHash,
          }),
          canonicalRequirement: canonicalInvestigationEvidenceRequirement({
            requirementVersion: obligationEvidenceRequirementVersionV2,
            kind: InvestigationEvidenceRequirementKind.CompletePageChain,
            operationKind: InvestigationOperationKind.TextSearch,
            initialOperationInputHash: operationInputHash,
            matchMode: InvestigationTextSearchMatchMode.FixedString,
            query,
            queryHash,
            probeKind: InvestigationProbeKind.DeclarationIdentifier,
            paths: ["."],
            pageSize: 500,
            revision: InvestigationOperationRevision.Head,
            sourcePathHash: pathHash,
            searchPolicyVersion:
              reviewInvestigationCoverageProfileV2.searchPolicyVersion,
          }),
          riskPriority: 800_000,
        },
      ],
      initialReceipts: [],
    });
    const planned = await new PlanNextInvestigationTurn(
      store,
      authority,
      digest,
      clock,
    ).execute({
      commandId: "plan-expansion-1",
      investigationId: opened.investigationId,
      expectedVersion: opened.version,
      leaseDurationMs: 300_000,
      maxObligationsForTurn: 16,
    });
    const aggregate = (await store.findById(opened.investigationId))!;
    const search = aggregate.obligations.find(
      (item) => item.kind === InvestigationObligationKind.DirectReferenceSearch,
    )!;
    const observation = observationFixture({
      turnId: planned.turn!.turnId,
      dossierVersion: planned.version,
      obligationId: search.obligationId,
      operationReceiptId: hash("9"),
    });
    const terminalOutcomeHash = await digest.digestUtf8(
      canonicalInvestigationTerminalObservation(observation),
    );
    const evidence = {
      verify: vi.fn<InvestigationTurnEvidencePort["verify"]>(),
    };
    evidence.verify.mockResolvedValue({
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      terminalOutcomeHash,
      gatewayPolicyVersion: "context-gateway-v4",
      actualProviderKind: InvestigationTurnProviderKind.Codex,
      operations: [
        {
          operationReceiptId: hash("9"),
          operationKey: hash("7"),
          sequence: 1,
          operationKind: InvestigationOperationKind.TextSearch,
          operationInputHash,
          evidenceDigest: hash("6"),
          treeOid: "3".repeat(40),
          queryDigest: hash("d"),
          cursorInputHash: null,
          pageOrdinal: 0,
          pageItemCount: 2,
          pageItemsHash: hash("c"),
          pagePathHashes: [matchedPathHash],
          aggregatePathCount: 1,
          aggregatePathSetHash: matchedPathSetHash,
          aggregateItemCount: 2,
          aggregateHash: hash("b"),
          complete: true,
          nextCursorHash: null,
        },
      ],
    });
    const commit = new CommitAttestedInvestigationTurn(
      store,
      evidence,
      digest,
      new CommitInvestigationTurn(store, authority, digest, clock),
    );

    const command = {
      commandId: "commit-expansion-1",
      investigationId: opened.investigationId,
      expectedVersion: planned.version,
      turnId: planned.turn!.turnId,
      sourceAttemptId: "attempt-1",
      sourceLeaseId: "lease-1",
      sourceFencingToken: "1",
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      turnObservationHash: await digest.digestUtf8(
        canonicalInvestigationTurnObservation(observation),
      ),
      observation,
    } as const;
    await acquireTestLease(store, aggregate, {
      leaseId: command.sourceLeaseId,
      attemptId: command.sourceAttemptId,
    });
    const firstResult = await commit.execute(command);

    const committed = (await store.findById(opened.investigationId))!;
    expect(committed.obligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: InvestigationObligationKind.DirectCaller,
          origin: InvestigationObligationOrigin.DeterministicExpansion,
        }),
      ]),
    );
    expect(await commit.restoreCommittedCommand(command)).toEqual(firstResult);
    await expect(
      commit.restoreCommittedCommand({
        ...command,
        sourceFencingToken: "2",
      }),
    ).rejects.toThrow("investigation_idempotency_conflict");
    expect(await commit.execute(command)).toEqual(firstResult);
    expect(evidence.verify).toHaveBeenCalledTimes(1);
  });

  it("rejects an inventory closure when authenticated changed paths differ from seeded content", async () => {
    const store = new InMemoryInvestigationStore();
    const authority = new CurrentInvestigationExecutionAuthority();
    const clock = new FixedInvestigationClock(
      new Date("2026-08-02T10:00:00.000Z"),
    );
    const digest = new NodeSha256InvestigationDigest();
    const revisionHash = hash("4");
    const changedPathHash = await digest.digestUtf8("src/value.ts");
    const emptyPathSetHash = await digest.digestUtf8(JSON.stringify([]));
    const opened = await new OpenReviewInvestigation(
      store,
      authority,
      digest,
      digestBackedInvestigationManifestIdentity(digest),
      clock,
    ).execute({
      commandId: "open-inventory-mismatch",
      scope: {
        workspaceId: "workspace-1",
        repositoryConnectionId: "repository-1",
        scmRepositoryIdentityId: "identity-1",
        pullRequestNumber: 1,
        trustDomain: "trusted_managed",
        authorizationScopeHash: hash("9"),
      },
      revision: {
        baseSha: "1".repeat(40),
        mergeBaseSha: "2".repeat(40),
        headSha: "3".repeat(40),
        reviewRevisionHash: revisionHash,
      },
      executionId: "execution-1",
      workSlotId: "work-slot-1",
      stableReviewUnitKey: "review-unit-1",
      providerVoteLaneId: "provider-lane-1",
      providerStrategyId: "codex-primary",
      investigationManifestCanonicalJson: "{}",
      investigationManifestHash:
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
      contract: {
        ...reviewInvestigationCoverageProfileV2,
        producerReleaseId: "release-1",
      },
      policy: {
        policyId: "policy-1",
        maxObligations: 32,
        maxExpansionDepth: 4,
        maxSemanticTurns: 8,
        maxOperationalAttempts: 4,
        maxCriticCycles: 2,
        maxFindings: 32,
        maxProposalsPerTurn: 16,
        maxReceiptsPerTurn: 32,
        maxSeedProbesPerFile: 48,
        maxSeedProbesOverall: 384,
      },
      seedObligations: [
        inventorySeedV2({
          reviewRevisionHash: revisionHash,
          aggregateItemCount: 0,
          aggregateHash: hash("2"),
          aggregatePathCount: 0,
          aggregatePathSetHash: emptyPathSetHash,
        }),
        {
          kind: InvestigationObligationKind.ChangedContent,
          canonicalSubject: canonicalFileObligationSubject({
            pathHash: changedPathHash,
            revision: InvestigationOperationRevision.Head,
          }),
          canonicalRequirement: canonicalInvestigationEvidenceRequirement({
            requirementVersion: obligationEvidenceRequirementVersionV2,
            kind: InvestigationEvidenceRequirementKind.CompleteChangedFile,
            path: "src/value.ts",
            pathHash: changedPathHash,
            revision: InvestigationOperationRevision.Head,
          }),
          riskPriority: 800_000,
        },
      ],
      initialReceipts: [],
    });
    const planned = await new PlanNextInvestigationTurn(
      store,
      authority,
      digest,
      clock,
    ).execute({
      commandId: "plan-inventory-mismatch",
      investigationId: opened.investigationId,
      expectedVersion: opened.version,
      leaseDurationMs: 300_000,
      maxObligationsForTurn: 16,
    });
    const aggregate = (await store.findById(opened.investigationId))!;
    const inventory = aggregate.obligations.find(
      (item) => item.kind === InvestigationObligationKind.InventoryWitness,
    )!;
    const observation = observationFixture({
      turnId: planned.turn!.turnId,
      dossierVersion: planned.version,
      obligationId: inventory.obligationId,
      operationReceiptId: hash("9"),
    });
    const terminalOutcomeHash = await digest.digestUtf8(
      canonicalInvestigationTerminalObservation(observation),
    );
    const evidence = {
      verify: vi.fn<InvestigationTurnEvidencePort["verify"]>(),
    };
    evidence.verify.mockResolvedValue({
      acceptedAttestationId: "attestation-1",
      acceptedAttestationHash: hash("8"),
      terminalOutcomeHash,
      gatewayPolicyVersion: "context-gateway-v4",
      actualProviderKind: InvestigationTurnProviderKind.Codex,
      operations: [
        {
          operationReceiptId: hash("9"),
          operationKey: hash("7"),
          sequence: 1,
          operationKind: InvestigationOperationKind.CanonicalInventory,
          operationInputHash: hash("5"),
          evidenceDigest: hash("6"),
          treeOid: "3".repeat(40),
          queryDigest: hash("4"),
          cursorInputHash: null,
          pageOrdinal: 0,
          pageItemCount: 0,
          pageItemsHash: hash("3"),
          pagePathHashes: [],
          aggregatePathCount: 0,
          aggregatePathSetHash: await digest.digestUtf8(JSON.stringify([])),
          aggregateItemCount: 0,
          aggregateHash: hash("2"),
          complete: true,
          nextCursorHash: null,
        },
      ],
    });
    const commit = new CommitAttestedInvestigationTurn(
      store,
      evidence,
      digest,
      new CommitInvestigationTurn(store, authority, digest, clock),
    );

    await expect(
      commit.execute({
        commandId: "commit-inventory-mismatch",
        investigationId: opened.investigationId,
        expectedVersion: planned.version,
        turnId: planned.turn!.turnId,
        sourceAttemptId: "attempt-1",
        sourceLeaseId: "lease-1",
        sourceFencingToken: "1",
        acceptedAttestationId: "attestation-1",
        acceptedAttestationHash: hash("8"),
        turnObservationHash: await digest.digestUtf8(
          canonicalInvestigationTurnObservation(observation),
        ),
        observation,
      }),
    ).rejects.toThrow("investigation_inventory_seed_mismatch");
  });
});

function privateMaterialPreparer(digest: NodeSha256InvestigationDigest) {
  return new PrepareInvestigationSearchQueryPrivateMaterial(
    new AesGcmInvestigationPrivateMaterialCipher(
      "test-key",
      new Map([["test-key", Buffer.alloc(32, 19)]]),
    ),
    digest,
    5 * 60 * 1_000,
  );
}

async function createFixture() {
  const store = new InMemoryInvestigationStore();
  const authority = new CurrentInvestigationExecutionAuthority();
  const clock = new FixedInvestigationClock(
    new Date("2026-08-02T10:00:00.000Z"),
  );
  const digest = new NodeSha256InvestigationDigest();
  const opened = await new OpenReviewInvestigation(
    store,
    authority,
    digest,
    digestBackedInvestigationManifestIdentity(digest),
    clock,
  ).execute({
    commandId: "open-attested-1",
    scope: {
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
      scmRepositoryIdentityId: "identity-1",
      pullRequestNumber: 1,
      trustDomain: "trusted_managed",
      authorizationScopeHash: hash("9"),
    },
    revision: {
      baseSha: "1".repeat(40),
      mergeBaseSha: "2".repeat(40),
      headSha: "3".repeat(40),
      reviewRevisionHash: hash("4"),
    },
    executionId: "execution-1",
    workSlotId: "work-slot-1",
    stableReviewUnitKey: "review-unit-1",
    providerVoteLaneId: "provider-lane-1",
    providerStrategyId: "codex-primary",
    investigationManifestCanonicalJson: "{}",
    investigationManifestHash:
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    contract: {
      coverageContractVersion: "coverage-v1",
      expansionRulesVersion: "expansion-v1",
      criticPolicyVersion: "critic-v1",
      gatewayPolicyVersion: "context-gateway-v4",
      probePolicyVersion: "probe-v1",
      producerReleaseId: "release-1",
      runtimeProfileVersion: "runtime-v1",
      searchPolicyVersion: "search-v1",
    },
    policy: {
      policyId: "policy-1",
      maxObligations: 32,
      maxExpansionDepth: 4,
      maxSemanticTurns: 8,
      maxOperationalAttempts: 4,
      maxCriticCycles: 2,
      maxFindings: 32,
      maxProposalsPerTurn: 16,
      maxReceiptsPerTurn: 32,
      maxSeedProbesPerFile: 48,
      maxSeedProbesOverall: 384,
    },
    seedObligations: [
      {
        kind: InvestigationObligationKind.InventoryWitness,
        canonicalSubject: canonicalInventoryObligationSubject(hash("4")),
        canonicalRequirement: canonicalInvestigationEvidenceRequirement({
          requirementVersion: obligationEvidenceRequirementVersion,
          kind: InvestigationEvidenceRequirementKind.CompleteInventory,
          reviewRevisionHash: hash("4"),
        }),
        riskPriority: 100,
      },
    ],
    initialReceipts: [],
  });
  const planned = await new PlanNextInvestigationTurn(
    store,
    authority,
    digest,
    clock,
  ).execute({
    commandId: "plan-attested-1",
    investigationId: opened.investigationId,
    expectedVersion: opened.version,
    leaseDurationMs: 300_000,
    maxObligationsForTurn: 8,
  });
  const aggregate = await store.findById(opened.investigationId);
  const obligationId = aggregate!.obligations[0]!.obligationId;
  const evidence = {
    verify: vi.fn<InvestigationTurnEvidencePort["verify"]>(),
  };
  const baseCommit = new CommitInvestigationTurn(
    store,
    authority,
    digest,
    clock,
  );
  await acquireTestLease(store, aggregate!, {
    leaseId: "lease-1",
    attemptId: "attempt-1",
  });
  return {
    store,
    digest,
    evidence,
    planned,
    obligationId,
    turnId: planned.turn!.turnId,
    commit: new CommitAttestedInvestigationTurn(
      store,
      evidence,
      digest,
      baseCommit,
    ),
  };
}

async function acquireTestLease(
  store: InMemoryInvestigationStore,
  investigation: ReviewInvestigation,
  identity: Readonly<{ leaseId: string; attemptId: string }>,
): Promise<string> {
  const turn = investigation.activeTurn!;
  const result = await store.acquireLease({
    leaseId: identity.leaseId,
    workspaceId: investigation.scope.workspaceId,
    repositoryConnectionId: investigation.scope.repositoryConnectionId,
    scmRepositoryIdentityId: investigation.scope.scmRepositoryIdentityId,
    pullRequestNumber: investigation.scope.pullRequestNumber,
    authorizationId: "authorization-test",
    mutationEpoch: 1n,
    executionId: investigation.executionId,
    workSlotId: investigation.workSlotId,
    revision: investigation.revision,
    investigationId: investigation.investigationId,
    investigationVersion: investigation.version,
    turnId: turn.turnId,
    turnPurpose: turn.purpose,
    providerVoteLaneId: investigation.providerVoteLaneId,
    providerStrategyId: investigation.providerStrategyId,
    investigationManifestCanonicalJson:
      investigation.investigationManifestCanonicalJson!,
    investigationManifestHash: investigation.investigationManifestHash!,
    attemptId: identity.attemptId,
    acquireRequestIdHash: createHash("sha256")
      .update(`acquire:${identity.leaseId}`)
      .digest("hex"),
    acquireRequestHash: createHash("sha256")
      .update(`request:${identity.leaseId}`)
      .digest("hex"),
    ownerIdHash: hash("a"),
    leaseCapabilityId: `capability-${identity.leaseId}`,
    capabilitySigningKeyId: "test-signing-key",
    acquiredAt: investigation.updatedAt,
    expiresAt: turn.expiresAt,
    resultReportUntil: turn.expiresAt,
    retainUntil: new Date(
      new Date(turn.expiresAt).getTime() + 3_600_000,
    ).toISOString(),
  });
  if (result.lease === null) throw new Error("test_lease_acquisition_failed");
  return result.lease.fencingToken.toString(10);
}

function observationFixture(input: {
  turnId: string;
  dossierVersion: number;
  obligationId: string;
  operationReceiptId: string;
  closureClaim?: boolean;
  discoveryQuery?: string;
  obligationProposals?: InvestigationTurnObservation["obligationProposals"];
}): InvestigationTurnObservation {
  return Object.freeze({
    outputVersion: 2,
    findings: Object.freeze([]),
    obligationProposals: Object.freeze([...(input.obligationProposals ?? [])]),
    closureClaims: Object.freeze(
      input.closureClaim === false
        ? []
        : [
            Object.freeze({
              obligationId: input.obligationId,
              operationReceiptIds: Object.freeze([input.operationReceiptId]),
            }),
          ],
    ),
    operationBackedDiscoveryClaims: Object.freeze(
      input.discoveryQuery === undefined
        ? []
        : [
            Object.freeze({
              sourceObligationId: input.obligationId,
              query: input.discoveryQuery,
              operationReceiptIds: Object.freeze([input.operationReceiptId]),
            }),
          ],
    ),
    unresolvableClaims: Object.freeze([]),
    criticDecision: null as ContextCriticDecision | null,
    observationVersion: 2,
    invocationId: "investigation-1:turn-1:attempt-1",
    turnId: input.turnId,
    dossierVersion: input.dossierVersion,
    purpose: ReviewInvestigationTurnPurpose.Discovery,
    actualProviderKind: InvestigationTurnProviderKind.Codex,
    actualModel: "gpt-5.6-sol",
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    usage: Object.freeze({
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 110,
    }),
    durationMs: 1_000,
    schemaComplete: true,
    streamComplete: true,
    contextAttestationReference: "attestation-1",
  });
}

async function completeTextFileEvidence(
  digest: NodeSha256InvestigationDigest,
  input: Readonly<{
    receiptId: string;
    path: string;
    lineCount: number;
  }>,
) {
  return Object.freeze({
    operationReceiptId: input.receiptId,
    operationKey: hash("7"),
    sequence: 1,
    evidenceDigest: hash("6"),
    operationKind: InvestigationOperationKind.FileRead,
    operationInputHash: hash("5"),
    revision: InvestigationOperationRevision.Head,
    treeOid: "3".repeat(40),
    pathHash: await digest.digestUtf8(input.path),
    blobOid: "2".repeat(40),
    mode: "100644",
    startByte: 0,
    byteCount: 64,
    contentHash: hash("4"),
    contentKind: InvestigationFileContentKind.Text,
    lineCount: input.lineCount,
    eof: true,
    complete: true,
  } as const);
}

type CompleteTextFileEvidence = Awaited<
  ReturnType<typeof completeTextFileEvidence>
>;

function inventorySeedV2(input: {
  reviewRevisionHash: string;
  aggregateItemCount?: number;
  aggregateHash?: string;
  aggregatePathCount?: number;
  aggregatePathSetHash?: string;
}) {
  const requirement = {
    requirementVersion: obligationEvidenceRequirementVersionV2,
    kind: InvestigationEvidenceRequirementKind.CompleteInventory,
    reviewRevisionHash: input.reviewRevisionHash,
    treeOid: "3".repeat(40),
    aggregateItemCount: input.aggregateItemCount ?? 1,
    aggregateHash: input.aggregateHash ?? hash("2"),
    aggregatePathCount: input.aggregatePathCount ?? 0,
    aggregatePathSetHash: input.aggregatePathSetHash ?? hash("0"),
  } as const;
  return {
    kind: InvestigationObligationKind.InventoryWitness,
    canonicalSubject: canonicalInventoryObligationSubjectV2(requirement),
    canonicalRequirement:
      canonicalInvestigationEvidenceRequirement(requirement),
    riskPriority: 1_000_000,
  } as const;
}

function inventoryOperationEvidence(input: {
  operationReceiptId: string;
  pathHash: string;
  pathSetHash: string;
  requirement: {
    treeOid: string;
    aggregateItemCount: number;
    aggregateHash: string;
    aggregatePathCount: number;
    aggregatePathSetHash: string;
  };
}) {
  return {
    operationReceiptId: input.operationReceiptId,
    operationKey: hash("7"),
    sequence: 1,
    operationKind: InvestigationOperationKind.CanonicalInventory,
    operationInputHash: hash("5"),
    evidenceDigest: hash("6"),
    treeOid: input.requirement.treeOid,
    queryDigest: hash("4"),
    cursorInputHash: null,
    pageOrdinal: 0,
    pageItemCount: input.requirement.aggregateItemCount,
    pageItemsHash: hash("3"),
    pagePathHashes: [input.pathHash],
    aggregatePathCount: input.requirement.aggregatePathCount,
    aggregatePathSetHash: input.pathSetHash,
    aggregateItemCount: input.requirement.aggregateItemCount,
    aggregateHash: input.requirement.aggregateHash,
    complete: true,
    nextCursorHash: null,
  } as const;
}
