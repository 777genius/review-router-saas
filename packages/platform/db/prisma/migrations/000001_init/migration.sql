-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "GitHubInstallationStatus" AS ENUM ('pending', 'active', 'suspended', 'removed', 'permission_error', 'sync_error');

-- CreateEnum
CREATE TYPE "RepositoryVisibility" AS ENUM ('public', 'private', 'internal');

-- CreateEnum
CREATE TYPE "RepositorySetupStatus" AS ENUM ('not_configured', 'setup_pr_open', 'configured', 'needs_attention');

-- CreateEnum
CREATE TYPE "WorkflowProvisioningStatus" AS ENUM ('not_started', 'setup_pr_open', 'configured', 'failed');

-- CreateEnum
CREATE TYPE "ProviderSecretState" AS ENUM ('unknown', 'missing', 'configured', 'stale_or_invalid', 'unavailable_in_fork_pr');

-- CreateEnum
CREATE TYPE "ActionProviderHealth" AS ENUM ('ok', 'skipped', 'failed', 'degraded');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('received', 'processing', 'processed', 'failed');

-- CreateEnum
CREATE TYPE "OutboxEventStatus" AS ENUM ('pending', 'processing', 'retry_wait', 'processed', 'dead_letter');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "githubUserId" BIGINT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "primaryEmail" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "githubLogin" TEXT,
    "role" "WorkspaceRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubInstallation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "githubInstallationId" BIGINT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "repositorySelection" TEXT NOT NULL,
    "status" "GitHubInstallationStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "githubRepositoryId" BIGINT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "visibility" "RepositoryVisibility" NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "setupStatus" "RepositorySetupStatus" NOT NULL DEFAULT 'not_configured',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositoryConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewConfiguration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "targetKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewConfigurationVersion" (
    "id" TEXT NOT NULL,
    "configurationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "providerKind" TEXT NOT NULL,
    "providerAuthMode" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reasoningEffort" TEXT NOT NULL,
    "agenticContext" BOOLEAN NOT NULL DEFAULT true,
    "failOnSeverity" TEXT NOT NULL,
    "inlineMaxComments" INTEGER NOT NULL,
    "targetTokensPerBatch" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewConfigurationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderSetupState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "targetKey" TEXT NOT NULL,
    "providerKind" TEXT NOT NULL,
    "authMode" TEXT NOT NULL,
    "state" "ProviderSecretState" NOT NULL DEFAULT 'unknown',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderSetupState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionRunHealthReport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "githubRunId" TEXT NOT NULL,
    "githubRunAttempt" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "actionVersion" TEXT NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "providerSetupState" "ProviderSecretState" NOT NULL,
    "providerHealth" "ActionProviderHealth" NOT NULL,
    "safeErrorCategory" TEXT NOT NULL,
    "safeErrorSummary" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionRunHealthReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowProvisioning" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "status" "WorkflowProvisioningStatus" NOT NULL DEFAULT 'not_started',
    "branch" TEXT NOT NULL,
    "workflowPath" TEXT NOT NULL,
    "actionVersion" TEXT NOT NULL,
    "pullRequestUrl" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowProvisioning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubWebhookDelivery" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "action" TEXT,
    "installationId" BIGINT,
    "payloadHash" TEXT,
    "normalizedEvent" JSONB,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'received',
    "errorSummary" TEXT,
    "processedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitHubWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "workspaceId" TEXT,
    "repositoryId" TEXT,
    "aggregateId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "safeLastErrorSummary" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceEntitlement" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free_beta',
    "status" TEXT NOT NULL DEFAULT 'active',
    "limits" JSONB NOT NULL,
    "flags" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_githubUserId_key" ON "User"("githubUserId");

-- CreateIndex
CREATE INDEX "User_githubLogin_idx" ON "User"("githubLogin");

-- CreateIndex
CREATE INDEX "WorkspaceMember_workspaceId_role_idx" ON "WorkspaceMember"("workspaceId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_githubLogin_key" ON "WorkspaceMember"("workspaceId", "githubLogin");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubInstallation_githubInstallationId_key" ON "GitHubInstallation"("githubInstallationId");

-- CreateIndex
CREATE INDEX "GitHubInstallation_workspaceId_status_idx" ON "GitHubInstallation"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryConnection_githubRepositoryId_key" ON "RepositoryConnection"("githubRepositoryId");

-- CreateIndex
CREATE INDEX "RepositoryConnection_installationId_idx" ON "RepositoryConnection"("installationId");

-- CreateIndex
CREATE INDEX "RepositoryConnection_workspaceId_setupStatus_idx" ON "RepositoryConnection"("workspaceId", "setupStatus");

-- CreateIndex
CREATE INDEX "RepositoryConnection_workspaceId_selected_fullName_idx" ON "RepositoryConnection"("workspaceId", "selected", "fullName");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryConnection_workspaceId_fullName_key" ON "RepositoryConnection"("workspaceId", "fullName");

-- CreateIndex
CREATE INDEX "ReviewConfiguration_workspaceId_repositoryId_idx" ON "ReviewConfiguration"("workspaceId", "repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewConfiguration_workspaceId_targetKey_key" ON "ReviewConfiguration"("workspaceId", "targetKey");

-- CreateIndex
CREATE INDEX "ReviewConfigurationVersion_configurationId_createdAt_idx" ON "ReviewConfigurationVersion"("configurationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewConfigurationVersion_configurationId_version_key" ON "ReviewConfigurationVersion"("configurationId", "version");

-- CreateIndex
CREATE INDEX "ProviderSetupState_workspaceId_state_idx" ON "ProviderSetupState"("workspaceId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSetupState_workspaceId_targetKey_providerKind_authM_key" ON "ProviderSetupState"("workspaceId", "targetKey", "providerKind", "authMode");

-- CreateIndex
CREATE INDEX "ActionRunHealthReport_workspaceId_receivedAt_idx" ON "ActionRunHealthReport"("workspaceId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActionRunHealthReport_repositoryId_githubRunId_githubRunAtt_key" ON "ActionRunHealthReport"("repositoryId", "githubRunId", "githubRunAttempt");

-- CreateIndex
CREATE INDEX "WorkflowProvisioning_workspaceId_status_idx" ON "WorkflowProvisioning"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "WorkflowProvisioning_repositoryId_status_idx" ON "WorkflowProvisioning"("repositoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowProvisioning_repositoryId_branch_key" ON "WorkflowProvisioning"("repositoryId", "branch");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_createdAt_idx" ON "AuditEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_action_idx" ON "AuditEvent"("workspaceId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubWebhookDelivery_deliveryId_key" ON "GitHubWebhookDelivery"("deliveryId");

-- CreateIndex
CREATE INDEX "GitHubWebhookDelivery_eventName_createdAt_idx" ON "GitHubWebhookDelivery"("eventName", "createdAt");

-- CreateIndex
CREATE INDEX "GitHubWebhookDelivery_installationId_idx" ON "GitHubWebhookDelivery"("installationId");

-- CreateIndex
CREATE INDEX "GitHubWebhookDelivery_status_receivedAt_idx" ON "GitHubWebhookDelivery"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_idempotencyKey_key" ON "OutboxEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_workspaceId_status_idx" ON "OutboxEvent"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "OutboxEvent_repositoryId_status_idx" ON "OutboxEvent"("repositoryId", "status");

-- CreateIndex
CREATE INDEX "OutboxEvent_type_version_status_idx" ON "OutboxEvent"("type", "version", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceEntitlement_workspaceId_key" ON "WorkspaceEntitlement"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceEntitlement_plan_status_idx" ON "WorkspaceEntitlement"("plan", "status");

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubInstallation" ADD CONSTRAINT "GitHubInstallation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryConnection" ADD CONSTRAINT "RepositoryConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryConnection" ADD CONSTRAINT "RepositoryConnection_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "GitHubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewConfiguration" ADD CONSTRAINT "ReviewConfiguration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewConfiguration" ADD CONSTRAINT "ReviewConfiguration_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewConfigurationVersion" ADD CONSTRAINT "ReviewConfigurationVersion_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "ReviewConfiguration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSetupState" ADD CONSTRAINT "ProviderSetupState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSetupState" ADD CONSTRAINT "ProviderSetupState_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionRunHealthReport" ADD CONSTRAINT "ActionRunHealthReport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionRunHealthReport" ADD CONSTRAINT "ActionRunHealthReport_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowProvisioning" ADD CONSTRAINT "WorkflowProvisioning_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowProvisioning" ADD CONSTRAINT "WorkflowProvisioning_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceEntitlement" ADD CONSTRAINT "WorkspaceEntitlement_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

