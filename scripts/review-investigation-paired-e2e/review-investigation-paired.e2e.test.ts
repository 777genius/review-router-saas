import { execFile } from "node:child_process";
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
        expect(receipt.operationReceiptIds).toHaveLength(
          Number(requirement.requiredPathCount),
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

    it("normalizes high-risk proposals and stays inconclusive without an independent critic", async () => {
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
          qualityFlags: expect.arrayContaining(["investigation_inconclusive"]),
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
        state: "inconclusive",
        conclusion: "inconclusive",
        criticDecision: "abstain",
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

    it("rejects an attested relation closure that omits one required path", async () => {
      const fixture = requireHarness(harness);
      const action = await fixture.run(
        PairedActionScenario.IncompletePathChain,
      );

      expect(action).toMatchObject({
        ok: false,
        scenario: PairedActionScenario.IncompletePathChain,
        releaseManifestHash: fixture.releaseManifestHash,
      });
      expectExactDiagnostic(fixture, {
        operationId: "review_investigation_turn_commit",
        protocolErrorCode: "invariant_violation",
        protocolIssues: ["investigation_obligation_evidence_mismatch"],
        statusCode: 422,
      });
      const investigation =
        await fixture.prisma.reviewInvestigation.findFirstOrThrow({
          where: {
            reviewRevisionHash: fixture.repository.reviewRevisionHash,
          },
          select: { investigationId: true, certificateId: true },
        });
      expect(investigation.certificateId).toBeNull();
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
        fixture.prisma.reviewInvestigationCertificate.count({
          where: { investigationId: investigation.investigationId },
        }),
      ).resolves.toBe(0);
    }, 180_000);

    it("accepts the Action domain-separated manifest key in replay preparation", async () => {
      const fixture = requireHarness(harness);
      const action = await fixture.run(
        PairedActionScenario.ReplayManifestIdentity,
      );

      expect(action).toMatchObject({
        ok: true,
        scenario: PairedActionScenario.ReplayManifestIdentity,
        releaseManifestHash: fixture.releaseManifestHash,
        replayPreparationMissing: true,
      });
      await expect(fixture.prisma.reviewInvestigation.count()).resolves.toBe(0);
      expect(fixture.diagnostics).toEqual([]);
    }, 120_000);
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
