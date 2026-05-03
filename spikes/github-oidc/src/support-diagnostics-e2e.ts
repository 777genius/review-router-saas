import { recordAuditEvent } from "../../../packages/features/audit-log/src/index.ts";
import {
  getWorkspaceSupportDiagnostics,
  PrismaSupportDiagnosticsRepository,
} from "../../../packages/features/support-diagnostics/src/index.ts";
import { PrismaAuditLogRepository } from "../../../packages/features/audit-log/src/index.ts";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";
import { loadEnvFiles } from "./config.js";

loadEnvFiles();

const prisma = createPrismaClient();
const marker = Date.now();
const workspaceSlug = `rr-support-e2e-${marker}`;
let workspaceId: string | null = null;

try {
  const workspace = await prisma.workspace.create({
    data: { slug: workspaceSlug, name: `Support E2E ${marker}` },
    select: { id: true },
  });
  workspaceId = workspace.id;

  const installation = await prisma.gitHubInstallation.create({
    data: {
      workspaceId: workspace.id,
      githubInstallationId: BigInt(`93${String(marker).slice(-10)}`),
      accountLogin: "review-router-e2e",
      accountType: "User",
      repositorySelection: "selected",
      status: "active",
    },
    select: { id: true },
  });

  const repository = await prisma.repositoryConnection.create({
    data: {
      workspaceId: workspace.id,
      installationId: installation.id,
      githubRepositoryId: BigInt(`94${String(marker).slice(-10)}`),
      owner: "review-router-e2e",
      name: `repo-${marker}`,
      fullName: `review-router-e2e/repo-${marker}`,
      defaultBranch: "main",
      visibility: "private",
      selected: true,
      archived: false,
      setupStatus: "configured",
    },
    select: { id: true },
  });

  await prisma.actionRunHealthReport.create({
    data: {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      githubRunId: `support-e2e-${marker}`,
      githubRunAttempt: "1",
      eventName: "pull_request",
      actionVersion: "local-e2e",
      configVersion: 1,
      providerSetupState: "configured",
      providerHealth: "ok",
      safeErrorCategory: "none",
      receivedAt: new Date(),
    },
  });

  await prisma.workflowProvisioning.create({
    data: {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      status: "setup_pr_open",
      branch: "reviewrouter/setup",
      workflowPath: ".github/workflows/reviewrouter.yml",
      actionVersion: "777genius/review-router@v1",
      pullRequestUrl: "https://github.com/review-router-e2e/repo/pull/1",
    },
  });

  await prisma.outboxEvent.create({
    data: {
      type: "installation.sync_requested",
      version: 1,
      idempotencyKey: `support-e2e-${marker}`,
      workspaceId: workspace.id,
      repositoryId: repository.id,
      aggregateId: `workspace:${workspace.id}`,
      payload: { installationId: "1" },
      status: "dead_letter",
      occurredAt: new Date(),
      deadLetteredAt: new Date(),
      lastErrorCode: "github_permission_denied",
      safeLastErrorSummary: "GitHub permission denied",
    },
  });

  await recordAuditEvent(
    {
      workspaceId: workspace.id,
      actor: "system:e2e",
      action: "workflow.setup_pr_opened",
      targetType: "repository",
      targetId: repository.id,
      metadata: { branch: "reviewrouter/setup" },
    },
    { auditLog: new PrismaAuditLogRepository(prisma) },
  );

  const snapshot = await getWorkspaceSupportDiagnostics(
    {
      workspaceId: workspace.id,
      checkedAt: new Date("2026-05-03T20:00:00.000Z"),
      audit: {
        actor: "support:local-e2e",
        reason: "local_admin_override",
      },
    },
    {
      diagnostics: new PrismaSupportDiagnosticsRepository(prisma),
      auditLog: new PrismaAuditLogRepository(prisma),
    },
  );

  if (!snapshot) {
    throw new Error("support diagnostics snapshot was not returned");
  }
  if (snapshot.repositoryCounts.total !== 1) {
    throw new Error(
      `expected one repo, got ${snapshot.repositoryCounts.total}`,
    );
  }
  if (snapshot.providerCounts.configured !== 1) {
    throw new Error("provider setup state was not summarized");
  }
  if (snapshot.outboxCounts.deadLetter !== 1) {
    throw new Error("dead-letter outbox state was not summarized");
  }

  const supportAudit = await prisma.auditEvent.findFirst({
    where: {
      workspaceId: workspace.id,
      action: "support.diagnostics_viewed",
    },
    select: { metadata: true },
  });
  if (!supportAudit) {
    throw new Error("support diagnostics access was not audited");
  }
  if (JSON.stringify(supportAudit.metadata).includes("auth")) {
    throw new Error("support audit metadata contains unsafe auth-looking text");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspace: snapshot.workspaceSlug,
        repositories: snapshot.repositoryCounts,
        provider: snapshot.providerCounts,
        outbox: snapshot.outboxCounts,
        supportAudit: supportAudit.metadata,
      },
      null,
      2,
    ),
  );
} finally {
  if (workspaceId) {
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  await prisma.$disconnect();
}
