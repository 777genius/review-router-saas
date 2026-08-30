import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertWorkspaceFeatureEntitlement,
  PrismaEntitlementRepository,
} from "@reviewrouter/features-entitlements";
import {
  PrismaCodexRotatingOAuthRepository,
  PrismaCodexZeroLoginRolloverLedger,
} from "@reviewrouter/features-action-control-plane";
import {
  requireReviewRouterDatabaseRecoveryWitness,
  resolveReviewRouterCodexRotatingActionRef,
  resolveReviewRouterCodexRotatingTrustedActionRefs,
  REVIEW_ROUTER_ACTION_REPOSITORY,
} from "@reviewrouter/platform-config";
import { activateConfirmedCodexNamespaceAfterWorkflowMerge } from "../../../../../src/server/codex-rotating-workflow-activation";
import { createGitHubAppInstallationOctokit } from "../../../../../src/server/dashboard-mutations";
import { createDashboardRateLimitPolicy } from "../../../../../src/server/dashboard-rate-limits";
import { authorizeGitHubCliRepository } from "../../../../../src/server/github-cli-repository-authorization";
import {
  getCodexEffectAuthorityPrisma,
  getPrisma,
} from "../../../../../src/server/prisma";
import { resolveWorkflowPublicApiUrl } from "../../../../../src/server/workflow-public-api-url";

const repositorySchema = z
  .object({
    repository: z
      .string()
      .max(256)
      .regex(/^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/),
  });
const requestSchema = z.union([
  repositorySchema
    .extend({
      rolloverOperationId: z.string().min(1).max(256),
      expectedNamespaceEpoch: z.string().regex(/^[1-9][0-9]*$/u),
      expectedDefaultHeadSha: z.string().regex(/^[a-f0-9]{40}$/u),
    })
    .strict(),
  repositorySchema.strict(),
]);

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const accessToken = readBearerToken(request);
    const body = requestSchema.parse(await request.json());
    const authorized = await authorizeGitHubCliRepository({
      accessToken,
      repositoryFullName: body.repository,
    });
    const prisma = getPrisma();
    const repository = await prisma.repositoryConnection.findFirst({
      where: {
        provider: "github",
        githubRepositoryId: BigInt(authorized.githubRepositoryId),
      },
      select: {
        id: true,
        workspaceId: true,
        githubRepositoryId: true,
        owner: true,
        name: true,
        fullName: true,
        defaultBranch: true,
        selected: true,
        archived: true,
        installation: {
          select: { status: true, githubInstallationId: true },
        },
      },
    });
    if (!repository?.githubRepositoryId)
      throw new Error("repository_not_found");
    if (
      repository.fullName.toLowerCase() !== authorized.fullName.toLowerCase()
    ) {
      throw new Error("repository_mismatch");
    }
    if (!repository.selected) throw new Error("repository_not_selected");
    if (repository.archived) throw new Error("repository_archived");
    if (repository.installation?.status !== "active") {
      throw new Error("installation_not_active");
    }
    await assertWorkspaceFeatureEntitlement(
      {
        workspaceId: repository.workspaceId,
        actor: `github-cli:${authorized.fullName.toLowerCase()}`,
        feature: "workflow_provisioning",
      },
      { entitlements: new PrismaEntitlementRepository(prisma) },
    );
    await createDashboardRateLimitPolicy(
      prisma,
    ).assertWorkflowActivationAllowed({
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
    });

    const octokit = await createGitHubAppInstallationOctokit(
      repository.installation.githubInstallationId.toString(),
    );
    const zeroLoginRollover =
      "rolloverOperationId" in body
        ? createZeroLoginRolloverActivation({
            prisma,
            operationId: body.rolloverOperationId,
            expectedNamespaceEpoch: BigInt(body.expectedNamespaceEpoch),
            expectedDefaultHeadSha: body.expectedDefaultHeadSha,
          })
        : undefined;
    const result = await activateConfirmedCodexNamespaceAfterWorkflowMerge({
      prisma,
      octokit,
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
      githubRepositoryId: repository.githubRepositoryId.toString(),
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
      expectedRepositoryFullName: repository.fullName,
      expectedApiUrl: resolveWorkflowPublicApiUrl(),
      ...(zeroLoginRollover ? { zeroLoginRollover } : {}),
    });
    if (result.status === "not_configured") {
      throw new Error("codex_rotating_not_enabled");
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const code = safeErrorCode(error);
    return NextResponse.json(
      { error: code },
      {
        status: statusForError(code),
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

function createZeroLoginRolloverActivation(input: {
  prisma: ReturnType<typeof getPrisma>;
  operationId: string;
  expectedNamespaceEpoch: bigint;
  expectedDefaultHeadSha: string;
}) {
  const databaseRecoveryWitness =
    requireReviewRouterDatabaseRecoveryWitness();
  const actionRef = resolveReviewRouterCodexRotatingActionRef();
  const runtimeWritebacks = new PrismaCodexRotatingOAuthRepository(
    input.prisma,
    {
      actionRef,
      allowedActionRefs: resolveReviewRouterCodexRotatingTrustedActionRefs(),
      actionOwnerRepo: REVIEW_ROUTER_ACTION_REPOSITORY,
      databaseRecoveryWitness,
      databaseEffectAuthority: getCodexEffectAuthorityPrisma(),
    },
  );
  return {
    operationId: input.operationId,
    expectedNamespaceEpoch: input.expectedNamespaceEpoch,
    expectedDefaultHeadSha: input.expectedDefaultHeadSha,
    ledger: new PrismaCodexZeroLoginRolloverLedger(
      input.prisma,
      runtimeWritebacks,
      {
        actionOwnerRepo: REVIEW_ROUTER_ACTION_REPOSITORY,
        databaseRecoveryWitness,
      },
    ),
  };
}

function readBearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  if (!token || token.length < 16 || token.length > 4096) {
    throw new Error("github_cli_token_required");
  }
  return token;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message.startsWith("rate_limit_exceeded:")) return "rate_limited";
  const code = message.split(":", 1)[0] ?? "unknown_error";
  const allowed = new Set([
    "github_cli_token_required",
    "github_cli_token_invalid",
    "github_cli_repository_forbidden",
    "github_cli_repository_not_found",
    "github_cli_repository_mismatch",
    "github_cli_api_error",
    "invalid_repository",
    "repository_not_found",
    "repository_mismatch",
    "repository_not_selected",
    "repository_archived",
    "installation_not_active",
    "entitlement_denied",
    "rate_limited",
    "codex_rotating_not_enabled",
    "codex_rotating_workflow_namespace_not_ready",
    "codex_rotating_workflow_default_branch_mismatch",
    "codex_rotating_workflow_repository_invalid_response",
    "codex_rotating_workflow_commit_invalid_response",
    "codex_rotating_workflow_content_invalid_response",
    "codex_rotating_workflow_blob_sha_mismatch",
    "codex_rotating_workflow_default_head_changed",
    "codex_rotating_setup_activation_mismatch",
    "codex_rotating_setup_activation_stale_epoch",
    "zero_login_rollover_activation_request_invalid",
    "zero_login_rollover_not_found",
    "zero_login_rollover_repository_mismatch",
    "zero_login_rollover_namespace_epoch_mismatch",
    "zero_login_rollover_activation_not_ready",
    "zero_login_rollover_setup_pr_evidence_missing",
    "zero_login_rollover_expected_default_head_mismatch",
    "zero_login_rollover_target_action_mismatch",
    "zero_login_rollover_v5_disabled_for_repository",
    "zero_login_rollover_setup_pr_not_exactly_merged",
    "zero_login_rollover_activation_namespace_mismatch",
    "zero_login_rollover_activation_state_invalid",
    "zero_login_rollover_activation_stale_epoch",
  ]);
  if (allowed.has(code)) return code;

  const messageTokens = new Set(message.split(/[^A-Za-z0-9_]+/u));
  const embeddedSafeCode = [
    "codex_rotating_retryable_uncommitted",
    "codex_rotating_setup_confirmation_stale_epoch",
    "codex_rotating_setup_manifest_digest_mismatch",
    "codex_rotating_setup_namespace_retired",
    "codex_rotating_setup_recovery_association_conflict",
    "codex_rotating_setup_recovery_transition_conflict",
    "codex_rotating_t0_action_ref_invalid",
    "codex_rotating_t0_refresh_schedule_not_canonical",
    "codex_rotating_t0_secret_namespace_metadata_invalid",
    "codex_rotating_t0_workflow_metadata_missing",
    "codex_rotating_t0_workflow_source_not_canonical",
    "codex_rotating_workflow_action_ref_not_trusted",
    "codex_rotating_workflow_api_url_not_trusted",
    "codex_rotating_workflow_mapping_required",
    "codex_rotating_workflow_non_finite_number",
    "codex_rotating_workflow_provider_instance_mismatch",
    "codex_rotating_workflow_repository_id_invalid",
    "codex_rotating_workflow_repository_identity_mismatch",
    "codex_rotating_workflow_string_required",
    "codex_rotating_workflow_v4_required",
    "codex_rotating_workflow_yaml_invalid",
    "provider_secret_namespace_epoch_mismatch",
    "provider_secret_namespace_id_mismatch",
    "provider_secret_namespace_name_mismatch",
    "provider_secret_namespace_provider_mismatch",
    "provider_secret_namespace_repository_mismatch",
    "codex_oauth_secret_namespace_identity_immutable",
    "codex_oauth_setup_claim_evidence_immutable",
    "codex_oauth_setup_manifest_promotion_evidence_invalid",
    "codex_oauth_setup_manifest_terminal_evidence_immutable",
    "codex_oauth_setup_recovery_evidence_immutable",
  ].find((candidate) => messageTokens.has(candidate));
  return embeddedSafeCode ?? "invalid_request";
}

function statusForError(code: string): number {
  if (
    code === "github_cli_token_required" ||
    code === "github_cli_token_invalid"
  ) {
    return 401;
  }
  if (code === "github_cli_repository_forbidden") return 403;
  if (code === "entitlement_denied") return 403;
  if (code === "rate_limited") return 429;
  if (
    code === "github_cli_repository_not_found" ||
    code === "repository_not_found"
  ) {
    return 404;
  }
  if (
    code === "codex_rotating_workflow_repository_invalid_response" ||
    code === "codex_rotating_workflow_commit_invalid_response" ||
    code === "codex_rotating_workflow_content_invalid_response"
  ) {
    return 502;
  }
  if (
    code.startsWith("codex_rotating_") ||
    code.startsWith("codex_oauth_") ||
    code.startsWith("zero_login_rollover_")
  ) {
    return 409;
  }
  return 400;
}
