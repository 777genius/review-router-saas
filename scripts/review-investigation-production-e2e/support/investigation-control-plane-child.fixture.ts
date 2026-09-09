import { revisionFetch } from "./revision-fetch.fixture.js";
import {
  childDiagnostic,
  type ChildPhase,
} from "./child-diagnostics.fixture.js";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  createPrismaClient,
  type PrismaClient,
} from "../../../packages/platform/db/src/index.js";
import { composeReviewActionV2ProductionRoutes } from "../../../apps/api/src/review-action-v2-production-composition.js";
import type {
  Handlers,
  Message,
} from "./investigation-control-plane-process.fixture.js";

// Full rows deliberately include counters, authority identities and receipt
// hashes. Stable ordering makes duplicate effects visible without projections.
export async function durableSnapshot(
  prisma: PrismaClient,
  investigationId: string,
) {
  const investigation = await prisma.reviewInvestigation.findUniqueOrThrow({
    where: { investigationId },
  });
  const where = { investigationId };
  const [
    obligations,
    turns,
    receipts,
    commands,
    leases,
    executionLeases,
    certificates,
    shadows,
    telemetry,
  ] = await Promise.all([
    prisma.reviewInvestigationObligation.findMany({
      where,
      orderBy: { obligationId: "asc" },
    }),
    prisma.reviewInvestigationTurn.findMany({
      where,
      orderBy: { turnId: "asc" },
    }),
    prisma.reviewInvestigationReceipt.findMany({
      where,
      orderBy: { receiptId: "asc" },
    }),
    prisma.reviewInvestigationCommandReceipt.findMany({
      where,
      orderBy: { commandId: "asc" },
    }),
    prisma.reviewInvestigationLease.findMany({
      where,
      orderBy: { leaseId: "asc" },
    }),
    prisma.reviewInvocationLeaseV2.findMany({
      where: { executionId: investigation.executionId },
      orderBy: { leaseId: "asc" },
    }),
    prisma.reviewInvestigationCertificate.findMany({
      where,
      orderBy: { certificateId: "asc" },
    }),
    prisma.reviewInvestigationShadowEvidence.findMany({
      where,
      orderBy: { investigationId: "asc" },
    }),
    prisma.reviewInvestigationTelemetrySample.findMany({
      where: {
        producerReleaseId: investigation.producerReleaseId,
        reviewRevisionHash: investigation.reviewRevisionHash,
      },
      orderBy: { sampleId: "asc" },
    }),
  ]);
  return {
    investigation,
    obligations,
    turns,
    receipts,
    commands,
    leases,
    executionLeases,
    certificates,
    shadows,
    telemetry,
  };
}

// The marker is provisioned by the operator or CI wrapper on a NEW database.
// Exact name + run marker establish assignment; the parent claims it via CAS;
// a localhost/test-name heuristic alone must never authorize TRUNCATE.
export async function assertFixtureOwnership(
  prisma: PrismaClient,
  databaseUrl: string,
  runId: string,
) {
  if (!/^[a-f0-9]{32}$/.test(runId)) throw new Error("item11_invalid_run_id");
  const url = new URL(databaseUrl);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== `/item11_test_${runId}` ||
    url.search
  ) {
    throw new Error("item11_database_not_assigned");
  }
  const rows = await prisma.$queryRaw<
    Array<{ run_id: string; database_name: string }>
  >`
    SELECT run_id, current_database() AS database_name FROM item11_fixture_owner`;
  if (
    rows.length !== 1 ||
    rows[0]!.run_id !== runId ||
    rows[0]!.database_name !== `item11_test_${runId}`
  ) {
    throw new Error("item11_database_owner_mismatch");
  }
}

async function childMain() {
  let prisma: PrismaClient | undefined;
  let handlers: Handlers | undefined;
  let shuttingDown = false;
  let configured = false;
  let terminalDiagnostic = false;
  // Deny everything until the parent supplies its exact revision fixture.
  globalThis.fetch = async () => {
    throw new Error("item11_external_fetch_denied");
  };
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await prisma?.$disconnect();
    if (process.connected) process.disconnect();
  };
  process.on("disconnect", () => {
    void shutdown();
  });
  process.on("message", (message: Message) => {
    void (async () => {
      let phase: ChildPhase = "dispatch";
      const reply = (value: unknown) => {
        phase = "reply";
        if (process.connected) process.send?.({ id: message.id, value });
      };
      try {
        if (message.operation === "shutdown") {
          await shutdown();
          return;
        }
        if (shuttingDown) throw new Error("unavailable");
        if (message.operation === "configure") {
          if (configured) throw new Error("already_configured");
          configured = true;
          phase = "client";
          prisma = createPrismaClient({
            databaseUrl: message.config.databaseUrl,
            poolMax: 2,
          });
          phase = "ownership";
          await assertFixtureOwnership(
            prisma,
            message.config.databaseUrl,
            message.config.runId,
          );
          globalThis.fetch = revisionFetch(message.config.revisionFixture);
          phase = "composition";
          const routes = composeReviewActionV2ProductionRoutes({
            enabled: true,
            env: message.config.env,
            prisma,
            runtime: {
              readServerTime: async () => new Date(),
              createRequestId: () => `item11-${randomUUID()}`,
            },
            recordInvestigationOperationsDiagnostic: () => {
              terminalDiagnostic = true;
            },
          });
          const required = <T>(value: T | undefined): NonNullable<T> => {
            if (!value) throw new Error("handler_missing");
            return value;
          };
          phase = "handlers";
          handlers = {
            open: required(routes.investigation.openV2),
            plan: required(routes.investigation.planTurn),
            commit: required(routes.investigation.commitTurn),
            conclude: required(routes.investigation.conclude),
            acquire: required(routes.investigation.acquireLease),
            release: required(routes.investigation.releaseLease),
            executionAcquire: required(routes.execution.acquireLease),
            executionRelease: required(routes.execution.releaseLease),
          };
          reply({
            pid: process.pid,
            nonce: randomUUID(),
            runId: message.config.runId,
            rss: process.memoryUsage().rss,
          });
          return;
        }
        if (!handlers || !prisma) throw new Error("not_ready");
        if (message.operation === "snapshot") {
          phase = "snapshot";
          reply(await durableSnapshot(prisma, message.investigationId));
          return;
        }
        let result: unknown;
        // Fixed typed operations: no arbitrary method name, query or evaluation.
        phase = "execute";
        switch (message.operation) {
          case "open":
            result = await handlers.open.execute(message.request);
            break;
          case "plan":
            result = await handlers.plan.execute(message.request);
            break;
          case "commit":
            result = await handlers.commit.execute(message.request);
            break;
          case "conclude":
            result = await handlers.conclude.execute(message.request);
            break;
          case "acquire":
            result = await handlers.acquire.execute(message.request);
            break;
          case "release":
            result = await handlers.release.execute(message.request);
            break;
          case "executionAcquire":
            result = await handlers.executionAcquire.execute(message.request);
            break;
          case "executionRelease":
            result = await handlers.executionRelease.execute(message.request);
            break;
          default:
            throw new Error("operation_denied");
        }
        phase = "terminal_diagnostic";
        if (terminalDiagnostic) throw new Error("terminal_diagnostic");
        reply(result);
      } catch (error) {
        if (process.connected)
          process.send?.({
            id: message.id,
            error: childDiagnostic(error, message.operation, phase),
          });
      }
    })();
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.send
) {
  void childMain();
}
