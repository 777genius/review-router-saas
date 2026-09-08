import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PairedActionSaasE2EHarness,
  PairedActionScenario,
  resetPairedActionSaasE2EDatabase,
} from "./support/paired-action-saas-e2e-harness.js";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const enabled =
  process.env.REVIEW_ROUTER_REVIEW_INVESTIGATION_PAIRED_E2E === "1";
const actionSourceDir =
  process.env.REVIEW_ROUTER_ACTION_SOURCE_DIR ??
  path.resolve("..", "review-router-investigation-action");

if (enabled && !databaseUrl) {
  throw new Error(
    "REVIEW_ROUTER_TEST_DATABASE_URL is required for review-investigation:paired-e2e",
  );
}
const describeWithDatabase = databaseUrl && enabled ? describe : describe.skip;

describeWithDatabase.sequential(
  "paired disposable Review Action investigation to SaaS PostgreSQL E2E",
  () => {
    let harness: PairedActionSaasE2EHarness | null = null;

    beforeEach(async () => {
      await resetPairedActionSaasE2EDatabase(databaseUrl!);
      harness = await PairedActionSaasE2EHarness.create({
        databaseUrl: databaseUrl!,
        actionSourceDir,
        actionRef: await resolveActionRef(actionSourceDir),
      });
    }, 60_000);

    afterEach(async () => {
      await harness?.close();
      harness = null;
      await resetPairedActionSaasE2EDatabase(databaseUrl!);
    }, 60_000);

    it("runs the real Action orchestration through attested expansion and critic to a persisted certificate", async () => {
      const fixture = requireHarness(harness);
      const action = await fixture.run(PairedActionScenario.Success);
      const persistedState = await investigationFailureState(fixture);

      expect(
        action,
        actionFailureMessage(action, fixture, persistedState),
      ).toMatchObject({
        ok: true,
        scenario: PairedActionScenario.Success,
        releaseManifestHash: fixture.releaseManifestHash,
        observation: {
          qualityFlags: expect.arrayContaining([
            "investigation_verified_clean",
          ]),
        },
      });
      expect(action.observation).toBeDefined();

      const investigation =
        await fixture.prisma.reviewInvestigation.findFirstOrThrow({
          where: {
            reviewRevisionHash: fixture.repository.reviewRevisionHash,
          },
          select: {
            investigationId: true,
            executionId: true,
            state: true,
            conclusion: true,
            certificateId: true,
            criticDecision: true,
            criticCycles: true,
            expansionDepth: true,
            semanticTurns: true,
          },
        });
      const [certificate, obligations, turns, leases, sessions, attestations] =
        await Promise.all([
          fixture.prisma.reviewInvestigationCertificate.findUniqueOrThrow({
            where: { certificateId: investigation.certificateId! },
          }),
          fixture.prisma.reviewInvestigationObligation.findMany({
            where: { investigationId: investigation.investigationId },
            orderBy: { obligationId: "asc" },
          }),
          fixture.prisma.reviewInvestigationTurn.findMany({
            where: { investigationId: investigation.investigationId },
            orderBy: { turnOrdinal: "asc" },
          }),
          fixture.prisma.reviewInvestigationLease.findMany({
            where: { investigationId: investigation.investigationId },
            orderBy: { leaseId: "asc" },
          }),
          fixture.prisma.reviewContextGatewaySession.findMany({
            where: { sourceExecutionId: investigation.executionId },
          }),
          fixture.prisma.reviewContextDependencyAttestation.findMany({
            where: {
              session: {
                sourceReviewRevisionHash: fixture.repository.reviewRevisionHash,
              },
            },
          }),
        ]);

      expect(investigation).toMatchObject({
        state: "concluded",
        conclusion: "verified_clean",
        criticDecision: "accept",
      });
      expect(investigation.expansionDepth).toBeGreaterThan(0);
      expect(investigation.semanticTurns).toBeGreaterThanOrEqual(2);
      expect(certificate).toMatchObject({
        certificateId: action.observation!.investigationCertificateId,
        certificateHash: action.observation!.investigationCertificateHash,
        terminalOutcomeHash: action.observation!.payloadHash,
        terminalActualModel: "gpt-paired-e2e",
        conclusion: "verified_clean",
        criticDecision: "accept",
      });
      expect(obligations.length).toBeGreaterThan(3);
      expect(obligations.every((item) => item.state === "satisfied")).toBe(
        true,
      );
      const related = obligations.filter(
        (item) => item.origin === "deterministic_expansion",
      );
      expect(related.length).toBeGreaterThan(0);
      const relationObligations = related.filter((obligation) => {
        const requirement = JSON.parse(
          obligation.canonicalRequirement,
        ) as Record<string, unknown>;
        return requirement.kind === "complete_relation_context";
      });
      expect(relationObligations.length).toBeGreaterThan(0);
      for (const obligation of relationObligations) {
        const requirement = JSON.parse(
          obligation.canonicalRequirement,
        ) as Record<string, unknown>;
        const receipt =
          await fixture.prisma.reviewInvestigationReceipt.findUniqueOrThrow({
            where: {
              investigationId_obligationId: {
                investigationId: obligation.investigationId,
                obligationId: obligation.obligationId,
              },
            },
          });
        expect(receipt.kind).toBe("relation");
        expect(requirement.searchProofVersion).toBe(1);
        expect(receipt.operationReceiptIds).toHaveLength(
          Number(requirement.requiredPathCount) + 1,
        );
      }
      expect(turns.map((turn) => turn.purpose)).toContain("critic");
      expect(
        turns.every(
          (turn) =>
            turn.state === "committed" && turn.acceptedAttestationId !== null,
        ),
      ).toBe(true);
      expect(leases.length).toBe(turns.length);
      expect(leases.every((lease) => lease.state !== "active")).toBe(true);
      expect(sessions.length).toBeGreaterThanOrEqual(turns.length);
      expect(
        sessions.every(
          (session) =>
            session.sourceLeaseAuthorityKind === "investigation_shadow",
        ),
      ).toBe(true);
      expect(attestations.length).toBeGreaterThanOrEqual(turns.length);
      expect(fixture.diagnostics).toEqual([]);
    }, 180_000);

    it("normalizes high-risk proposals and accepts a fresh same-provider critic", async () => {
      const fixture = requireHarness(harness);
      const action = await fixture.run(PairedActionScenario.HighRiskProposal);
      const persistedState = await investigationFailureState(fixture);

      expect(
        action,
        actionFailureMessage(action, fixture, persistedState),
      ).toMatchObject({
        ok: true,
        scenario: PairedActionScenario.HighRiskProposal,
        releaseManifestHash: fixture.releaseManifestHash,
        observation: {
          qualityFlags: expect.arrayContaining([
            "investigation_verified_clean",
          ]),
        },
      });
      await expect(
        fixture.prisma.reviewInvestigation.findFirstOrThrow({
          select: {
            state: true,
            conclusion: true,
            criticDecision: true,
          },
        }),
      ).resolves.toEqual({
        state: "concluded",
        conclusion: "verified_clean",
        criticDecision: "accept",
      });
      await expect(
        fixture.prisma.reviewInvestigationObligation.findFirstOrThrow({
          where: { origin: "agent_proposal" },
          select: {
            kind: true,
            state: true,
            riskPriority: true,
          },
        }),
      ).resolves.toEqual({
        kind: "direct_caller",
        state: "satisfied",
        riskPriority: 800_000,
      });
      expect(fixture.diagnostics).toEqual([]);
    }, 180_000);

    it("rejects a seed whose hash no longer matches the leased provider manifest", async () => {
      const fixture = requireHarness(harness);
      const action = await fixture.run(
        PairedActionScenario.TamperedSeedManifest,
      );

      expect(action).toMatchObject({
        ok: false,
        scenario: PairedActionScenario.TamperedSeedManifest,
        releaseManifestHash: fixture.releaseManifestHash,
      });
      expectExactDiagnostic(fixture, {
        operationId: "review_investigation_open_v2",
        protocolErrorCode: "stale_precondition",
        protocolIssues: ["investigation_seed_prepared_manifest_mismatch"],
        statusCode: 412,
      });
      await expect(fixture.prisma.reviewInvestigation.count()).resolves.toBe(0);
    }, 120_000);

    it("rejects a stale review revision before creating an investigation", async () => {
      const fixture = requireHarness(harness);
      const action = await fixture.run(PairedActionScenario.StaleRevision);

      expect(action).toMatchObject({
        ok: false,
        scenario: PairedActionScenario.StaleRevision,
        releaseManifestHash: fixture.releaseManifestHash,
      });
      expectExactDiagnostic(fixture, {
        operationId: "review_investigation_open_v2",
        protocolErrorCode: "stale_precondition",
        protocolIssues: ["review_revision_mismatch"],
        statusCode: 412,
      });
      await expect(fixture.prisma.reviewInvestigation.count()).resolves.toBe(0);
    }, 120_000);

    it("stays inconclusive when an attested relation closure omits one required path", async () => {
      const fixture = requireHarness(harness);
      const action = await fixture.run(
        PairedActionScenario.IncompletePathChain,
      );

      expect(action).toMatchObject({
        ok: true,
        scenario: PairedActionScenario.IncompletePathChain,
        releaseManifestHash: fixture.releaseManifestHash,
        observation: {
          qualityFlags: expect.arrayContaining(["investigation_inconclusive"]),
        },
      });
      expect(fixture.diagnostics).toEqual([]);
      const investigation =
        await fixture.prisma.reviewInvestigation.findFirstOrThrow({
          where: {
            reviewRevisionHash: fixture.repository.reviewRevisionHash,
          },
          select: {
            investigationId: true,
            certificateId: true,
            conclusion: true,
            criticDecision: true,
            state: true,
          },
        });
      expect(investigation).toMatchObject({
        certificateId: expect.any(String),
        conclusion: "inconclusive",
        criticDecision: null,
        state: "inconclusive",
      });
      await expect(
        fixture.prisma.reviewInvestigationObligation.count({
          where: {
            investigationId: investigation.investigationId,
            origin: "deterministic_expansion",
            state: "open",
          },
        }),
      ).resolves.toBeGreaterThan(0);
      await expect(
        fixture.prisma.reviewInvestigationCertificate.findFirstOrThrow({
          where: { investigationId: investigation.investigationId },
          select: { conclusion: true, criticDecision: true },
        }),
      ).resolves.toEqual({
        conclusion: "inconclusive",
        criticDecision: null,
      });
    }, 180_000);

    it.each(["independent", "dependency"] as const)(
      "replays %s evidence and completes the target with a fresh critic", async (change) => {
        const fixture = requireHarness(harness);
        const sourceAction = await fixture.run(PairedActionScenario.Success);
        expect(sourceAction, actionFailureMessage(sourceAction, fixture, await investigationFailureState(fixture))).toMatchObject({
          ok: true,
          scenario: PairedActionScenario.Success,
        });
        const sourceInvestigation =
          await fixture.prisma.reviewInvestigation.findFirstOrThrow({
            where: {
              reviewRevisionHash: fixture.repository.reviewRevisionHash,
            },
          });
        const sourceSnapshot = await replaySnapshot(fixture, sourceInvestigation.investigationId);
        expect(sourceInvestigation.state).toBe("concluded");
        const callerHash = createHash("sha256").update("src/caller-a.ts").digest("hex");
        expect(sourceSnapshot.obligations.some((obligation) => {
          const requirement = JSON.parse(obligation.canonicalRequirement);
          return obligation.state === "satisfied" &&
            requirement.kind === "complete_relation_context" &&
            requirement.requiredPathHashes.includes(callerHash);
        })).toBe(true);

        const targetRevision = await fixture.advanceReviewRevision(change);
        const action = await fixture.run(PairedActionScenario.ReplayPrepared);
        const persistedState = await investigationFailureState(fixture);

        expect(
          action,
          actionFailureMessage(action, fixture, persistedState),
        ).toMatchObject({
          ok: true,
          scenario: PairedActionScenario.ReplayPrepared,
          releaseManifestHash: fixture.releaseManifestHash,
          replayPreparationMissing: false,
          sourceInvestigationId: sourceInvestigation.investigationId,
        });
        expect(action.preparedObligationCount).toBeGreaterThan(0);
        const replayed =
          await fixture.prisma.reviewInvestigation.findFirstOrThrow({
            where: { reviewRevisionHash: targetRevision.reviewRevisionHash },
          });
        expect(action.replayedInvestigationId).toBe(replayed.investigationId);
        await expect(
          fixture.prisma.reviewInvestigationReceipt.count({
            where: {
              investigationId: replayed.investigationId,
              replayProofId: { not: null },
            },
          }),
        ).resolves.toBeGreaterThan(0);
        await expect(
          fixture.prisma.reviewContextTargetReplayProof.count(),
        ).resolves.toBeGreaterThan(0);
        // Preparation must never carry the source's clean conclusion forward.
        expect(replayed.certificateId).toBeNull();
        expect(replayed.conclusion).toBeNull();
        expect(replayed.criticDecision).toBeNull();
        expect(replayed.semanticTurns).toBe(0);
        expect(action.observation).toBeUndefined();
        const preparedSnapshot = await replaySnapshot(fixture, replayed.investigationId);
        expect(preparedSnapshot.certificates).toEqual([]);
        expect(preparedSnapshot.turns).toEqual([]);
        const hits = preparedSnapshot.receipts.filter((receipt) => receipt.replayProofId !== null);
        expect(hits.length).toBeGreaterThan(0);
        for (const receipt of hits) {
          await expect(fixture.prisma.reviewContextTargetReplayProof.findUniqueOrThrow({
            where: { replayProofId: receipt.replayProofId! },
          })).resolves.toMatchObject({
            targetExecutionId: replayed.executionId,
            targetWorkSlotId: replayed.workSlotId,
            targetReviewRevisionHash: targetRevision.reviewRevisionHash,
            targetCheckoutTreeOid: targetRevision.headTreeSha,
          });
        }
        const open = preparedSnapshot.obligations.filter((obligation) => obligation.state === "open");
        const hitIds = new Set(hits.map((receipt) => receipt.obligationId));
        const sourceById = new Map(sourceSnapshot.obligations.map((obligation) => [obligation.obligationId, obligation]));
        const preparedById = new Map(preparedSnapshot.obligations.map((obligation) => [obligation.obligationId, obligation]));
        const requirements = preparedSnapshot.obligations.map((obligation) => JSON.parse(obligation.canonicalRequirement));
        const inventories = preparedSnapshot.obligations.filter((obligation) => JSON.parse(obligation.canonicalRequirement).kind === "complete_inventory");
        expect(inventories).toHaveLength(1);
        const inventory = inventories[0]!;
        // Inventory identity includes the revision and tree, even when the review
        // unit still owns only contract.ts. It must be fresh in both scenarios.
        expect(sourceById.has(inventory.obligationId)).toBe(false);
        expect(JSON.parse(inventory.canonicalRequirement)).toMatchObject({
          reviewRevisionHash: targetRevision.reviewRevisionHash,
          treeOid: targetRevision.headTreeSha,
        });
        expect(inventory.state).toBe("open");
        const contractFiles = sourceSnapshot.obligations.filter((obligation) => {
          const requirement = JSON.parse(obligation.canonicalRequirement);
          return requirement.kind === "complete_changed_file" && requirement.path === "src/contract.ts";
        });
        expect(contractFiles.length).toBeGreaterThan(0);
        for (const source of contractFiles) {
          expect(preparedById.get(source.obligationId)).toMatchObject({ state: "satisfied" });
          expect(hitIds.has(source.obligationId)).toBe(true);
        }
        for (const obligation of preparedSnapshot.obligations) {
          const source = sourceById.get(obligation.obligationId);
          const requirement = JSON.parse(obligation.canonicalRequirement);
          if (source) {
            expect(obligation).toMatchObject({
              coverageContractVersion: source.coverageContractVersion,
              stableReviewUnitKey: source.stableReviewUnitKey,
              kind: source.kind,
              canonicalSubject: source.canonicalSubject,
              canonicalRequirement: source.canonicalRequirement,
            });
          } else {
            // New seeds are not replay misses of a source receipt. Check their
            // concrete provenance instead of requiring membership in the source.
            expect(obligation.state).toBe("open");
            switch (requirement.kind) {
              case "complete_inventory":
                expect(obligation.origin).toBe("coverage_contract");
                break;
              case "complete_changed_file":
                expect(obligation.origin).toBe("coverage_contract");
                expect(requirement.path).toBe(change === "dependency" ? "src/caller-a.ts" : "src/independent.ts");
                expect(requirement.pathHash).toBe(createHash("sha256").update(requirement.path).digest("hex"));
                break;
              case "complete_page_chain":
                expect(obligation.origin).toBe("deterministic_expansion");
                expect(requirements.some((item) => item.kind === "complete_changed_file" && item.pathHash === requirement.sourcePathHash)).toBe(true);
                break;
              default:
                throw new Error(`unexpected_new_replay_obligation:${obligation.obligationId}:${obligation.canonicalRequirement}`);
            }
          }
          if (obligation.state === "open") {
            expect(preparedSnapshot.receipts.some((receipt) => receipt.obligationId === obligation.obligationId)).toBe(false);
          } else {
            expect(obligation.state).toBe("satisfied");
            expect(source).toBeDefined();
            expect(hitIds.has(obligation.obligationId)).toBe(true);
          }
        }
        for (const receipt of hits) {
          expect(sourceById.has(receipt.obligationId)).toBe(true);
          expect(preparedById.has(receipt.obligationId)).toBe(true);
        }
        if (change === "dependency") {
          // Select the source searches whose authenticated relation includes the
          // edited caller. New inventory/file seeds must not mask missing misses.
          const callerQueries = new Set(sourceSnapshot.obligations.flatMap((obligation) => {
            const requirement = JSON.parse(obligation.canonicalRequirement);
            return requirement.kind === "complete_relation_context" && requirement.requiredPathHashes.includes(callerHash)
              ? [requirement.queryHash] : [];
          }));
          const dependentSearches = preparedSnapshot.obligations.filter((obligation) => {
            const requirement = JSON.parse(obligation.canonicalRequirement);
            return sourceById.has(obligation.obligationId) && requirement.kind === "complete_page_chain" && callerQueries.has(requirement.queryHash);
          });
          expect(dependentSearches.length).toBeGreaterThan(0);
          for (const obligation of dependentSearches) {
            expect(obligation.state).toBe("open");
            expect(hitIds.has(obligation.obligationId)).toBe(false);
          }
        }
        await expect(replaySnapshot(fixture, sourceInvestigation.investigationId)).resolves.toEqual(sourceSnapshot);

        // Resume through the real recording adapter, leases, gateway and turn runner.
        const completed = await fixture.run(PairedActionScenario.Success);
        expect(completed, actionFailureMessage(completed, fixture, await investigationFailureState(fixture))).toMatchObject({
          ok: true,
          observation: { qualityFlags: expect.arrayContaining(["investigation_verified_clean"]) },
        });
        const terminal = await replaySnapshot(fixture, replayed.investigationId);
        expect(terminal.investigation).toMatchObject({
          state: "concluded", conclusion: "verified_clean", criticDecision: "accept",
          reviewRevisionHash: targetRevision.reviewRevisionHash,
        });
        expect(terminal.certificates).toHaveLength(1);
        const certificate = terminal.certificates[0]!;
        expect(certificate).toMatchObject({
          certificateId: completed.observation!.investigationCertificateId,
          certificateHash: completed.observation!.investigationCertificateHash,
          terminalOutcomeHash: completed.observation!.payloadHash,
          investigationId: replayed.investigationId,
          reviewRevisionHash: targetRevision.reviewRevisionHash,
          conclusion: "verified_clean", criticDecision: "accept",
          terminalActualModel: "gpt-paired-e2e",
        });
        expect(certificate.certificateId).not.toBe(sourceInvestigation.certificateId);
        expect(certificate.certificateHash).not.toBe(sourceSnapshot.certificates[0]!.certificateHash);
        expect(certificate.criticAttestationId).not.toBe(sourceSnapshot.certificates[0]!.criticAttestationId);
        const critics = terminal.turns.filter((turn) => turn.purpose === "critic");
        expect(critics).toHaveLength(1);
        expect(critics[0]).toMatchObject({ state: "committed", acceptedAttestationId: certificate.criticAttestationId });
        // Committing the accepted critic advances its leased version once.
        // The certificate binds that ready-to-conclude version; concluding
        // advances the aggregate once more and checkpoints the resulting version.
        expect(certificate.terminalVersion).toBe(critics[0]!.leasedAtVersion + 1n);
        expect(terminal.investigation.version).toBe(certificate.terminalVersion + 1n);
        expect(terminal.investigation.certificateId).toBe(certificate.certificateId);
        const checkpoint = await fixture.prisma.reviewInvestigationReplayEvidenceCheckpoint.findUniqueOrThrow({
          where: { checkpointId: terminal.investigation.replayEvidenceCheckpointId! },
        });
        expect(checkpoint).toMatchObject({
          sourceInvestigationId: replayed.investigationId,
          sourceInvestigationVersion: terminal.investigation.version,
          sourceState: "concluded",
          sourceConclusion: "verified_clean",
          reviewRevisionHash: certificate.reviewRevisionHash,
          sourceDossierDigest: certificate.dossierDigest,
        });
        expect(certificate.criticAttestationId).toEqual(expect.any(String));
        expect(terminal.turns.every((turn) => turn.state === "committed" && turn.acceptedAttestationId !== null)).toBe(true);
        expect(terminal.obligations.every((obligation) => obligation.state === "satisfied")).toBe(true);
        const terminalById = new Map(terminal.obligations.map((obligation) => [obligation.obligationId, obligation]));
        // Discovery can synthesize relation obligations from a changed-file
        // search or a seeded page chain. Their identity includes that parent and
        // authenticated path set, so they need not have a source-revision ID.
        for (const obligation of terminal.obligations) {
          if (preparedById.has(obligation.obligationId)) continue;
          const requirement = JSON.parse(obligation.canonicalRequirement);
          expect(obligation.origin).toBe("deterministic_expansion");
          expect(requirement.kind).toBe("complete_relation_context");
          const parent = terminalById.get(requirement.sourceObligationId);
          expect(parent).toBeDefined();
          const parentRequirement = JSON.parse(parent!.canonicalRequirement);
          expect(["complete_changed_file", "complete_page_chain"]).toContain(parentRequirement.kind);
          expect(requirement.sourcePathHash).toBe(parentRequirement.pathHash ?? parentRequirement.sourcePathHash);
          if (parentRequirement.kind === "complete_page_chain") {
            expect(requirement.queryHash).toBe(parentRequirement.queryHash);
            expect(requirement.initialOperationInputHash).toBe(parentRequirement.initialOperationInputHash);
          }
          expect(requirement.requiredPathHashes.length).toBeGreaterThan(0);
          expect(requirement.requiredPathCount).toBe(requirement.requiredPathHashes.length);
          expect(terminal.receipts.find((receipt) => receipt.obligationId === obligation.obligationId)).toMatchObject({
            replayProofId: null,
            reviewRevisionHash: targetRevision.reviewRevisionHash,
          });
        }
        const discoveryIds = new Set(terminal.turns.filter((turn) => turn.purpose === "discovery").flatMap((turn) => turn.obligationIds as string[]));
        for (const obligation of open) expect(discoveryIds.has(obligation.obligationId)).toBe(true);
        for (const obligation of terminal.obligations) {
          if (!preparedById.has(obligation.obligationId)) {
            expect(discoveryIds.has(obligation.obligationId)).toBe(true);
          }
        }
        for (const receipt of hits) {
          expect(discoveryIds.has(receipt.obligationId)).toBe(false);
          expect(terminal.receipts.find((item) => item.obligationId === receipt.obligationId)).toEqual(receipt);
        }
        expect(terminal.receipts.every((receipt) => receipt.reviewRevisionHash === targetRevision.reviewRevisionHash)).toBe(true);
        await expect(replaySnapshot(fixture, sourceInvestigation.investigationId)).resolves.toEqual(sourceSnapshot);
        expect(fixture.diagnostics).toEqual([]);
    }, 360_000);
  },
);

function requireHarness(
  value: PairedActionSaasE2EHarness | null,
): PairedActionSaasE2EHarness {
  if (!value) throw new Error("paired_action_saas_harness_missing");
  return value;
}

function actionFailureMessage(
  action: Readonly<{ failure?: Readonly<{ message: string }> }>,
  fixture: PairedActionSaasE2EHarness,
  persistedState: unknown,
): string {
  return [
    action.failure?.message,
    JSON.stringify(fixture.diagnostics),
    JSON.stringify(persistedState),
  ]
    .filter(Boolean)
    .join(" diagnostics=");
}

async function investigationFailureState(fixture: PairedActionSaasE2EHarness) {
  const [investigations, turns, leases, sessions] = await Promise.all([
    fixture.prisma.reviewInvestigation.findMany({
      select: {
        state: true,
        semanticTurns: true,
        operationalAttempts: true,
        criticCycles: true,
        nextEligibleAt: true,
        activeTurnId: true,
        conclusion: true,
      },
    }),
    fixture.prisma.reviewInvestigationTurn.findMany({
      select: { state: true, purpose: true, abortReason: true },
    }),
    fixture.prisma.reviewInvestigationLease.findMany({
      select: { state: true, purpose: true },
    }),
    fixture.prisma.reviewContextGatewaySession.findMany({
      select: { state: true, sourceLeaseAuthorityKind: true },
    }),
  ]);
  return { investigations, turns, leases, sessions };
}

function expectExactDiagnostic(
  fixture: PairedActionSaasE2EHarness,
  expected: Readonly<{
    operationId: string;
    protocolErrorCode: string;
    protocolIssues: readonly string[];
    statusCode: number;
  }>,
): void {
  expect(fixture.diagnostics.at(-1)).toEqual({
    ...expected,
    requestId: expect.any(String),
  });
}

async function resolveActionRef(sourceDir: string): Promise<string> {
  const configured = process.env.REVIEW_ROUTER_PAIRED_ACTION_REF;
  if (configured) return configured;
  return (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: sourceDir })
  ).stdout.trim();
}

async function replaySnapshot(fixture: PairedActionSaasE2EHarness, investigationId: string) {
  const where = { investigationId };
  const [investigation, obligations, receipts, turns, certificates] = await Promise.all([
    fixture.prisma.reviewInvestigation.findUniqueOrThrow({ where }),
    fixture.prisma.reviewInvestigationObligation.findMany({ where, orderBy: { obligationId: "asc" } }),
    fixture.prisma.reviewInvestigationReceipt.findMany({ where, orderBy: { obligationId: "asc" } }),
    fixture.prisma.reviewInvestigationTurn.findMany({ where, orderBy: { turnOrdinal: "asc" } }),
    fixture.prisma.reviewInvestigationCertificate.findMany({ where, orderBy: { certificateId: "asc" } }),
  ]);
  return { investigation, obligations, receipts, turns, certificates };
}
