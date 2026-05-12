import { recordAuditEvent } from "../../../packages/features/audit-log/src/index.ts";
import {
  getWorkspaceSupportDiagnostics,
  PrismaSupportDiagnosticsRepository,
} from "../../../packages/features/support-diagnostics/src/index.ts";
import { createMemoryBodyHash } from "../../../packages/features/memory/src/index.ts";
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

  const memoryBody =
    "Support diagnostics memory body must never leave the memory table.";
  const memoryItem = await prisma.memoryItem.create({
    data: {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      userId: null,
      scope: "repository",
      status: "active",
      body: memoryBody,
      bodyVersion: 1,
      bodyHash: createMemoryBodyHash(memoryBody),
      tags: [],
      riskLevel: "low",
      confidence: 1,
      source: {
        type: "dashboard",
        url: "https://example.test/private-memory-source",
        actorLogin: "support-e2e",
        redactedExcerpt: memoryBody,
        githubPullRequestNumber: null,
        sourceVisibility: "private",
      },
      policyVersion: 1,
      safetyPolicyVersion: 1,
      createdBy: "user:support-e2e",
      confirmedBy: "user:support-e2e",
      visibility: "repository_runtime",
      indexState: "indexed",
      indexVersion: 1,
    },
    select: { id: true },
  });
  const suggestionBody =
    "Support diagnostics suggestion body must never appear in diagnostics.";
  await prisma.memorySuggestion.create({
    data: {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      userId: null,
      suggestedScope: "repository",
      suggestedBody: suggestionBody,
      suggestedBodyVersion: 1,
      suggestedBodyHash: createMemoryBodyHash(suggestionBody),
      reason: "model_suggested_candidate",
      source: {
        type: "pr_comment",
        url: "https://example.test/private-suggestion-source",
        actorLogin: "support-e2e",
        redactedExcerpt: suggestionBody,
        githubPullRequestNumber: 1,
        sourceVisibility: "private",
      },
      safetyReport: {
        severity: "low",
        riskLevel: "low",
        flags: [],
        blockedReason: null,
        mayEmbed: true,
        mayUseInRuntimeBundle: true,
      },
      policyVersion: 1,
      safetyPolicyVersion: 1,
      status: "pending",
      createdByActor: "github:support-e2e",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      dedupeKey: `support-e2e-suggestion-${marker}`,
    },
  });
  await prisma.memoryUsageEvent.create({
    data: {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      memoryItemId: memoryItem.id,
      eventType: "action_bundle_exposed",
      bundleVersion: 1,
      dedupeKey: `support-e2e-memory-usage-${marker}`,
      metadata: {
        scope: "repository",
        bundleItemCount: 1,
      },
      occurredAt: new Date(),
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
  if (snapshot.memoryCounts.items.active !== 1) {
    throw new Error("active memory count was not summarized");
  }
  if (snapshot.memoryCounts.suggestions.pending !== 1) {
    throw new Error("pending memory suggestion count was not summarized");
  }
  if (snapshot.memoryCounts.usageEvents !== 1) {
    throw new Error("memory usage event count was not summarized");
  }
  const snapshotJson = JSON.stringify(snapshot);
  if (
    snapshotJson.includes(memoryBody) ||
    snapshotJson.includes(suggestionBody)
  ) {
    throw new Error("support diagnostics snapshot leaked memory body");
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
  const supportAuditJson = JSON.stringify(supportAudit.metadata);
  if (
    supportAuditJson.includes(memoryBody) ||
    supportAuditJson.includes(suggestionBody)
  ) {
    throw new Error("support audit metadata leaked memory body");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspace: snapshot.workspaceSlug,
        repositories: snapshot.repositoryCounts,
        provider: snapshot.providerCounts,
        outbox: snapshot.outboxCounts,
        memory: snapshot.memoryCounts,
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
