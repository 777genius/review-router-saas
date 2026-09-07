import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../packages/platform/db/src/index.js";
import {
  canonicalHostedPoolProviderInstanceId,
  hostedPoolWorkflowSemanticSha256,
  readCanonicalHostedPoolWorkflowMetadata,
  scanCanonicalHostedPoolWorkflowV2,
} from "../packages/features/workflow-provisioning/src/domain/hosted-pool-workflow-template.js";
import { hostedCodexCanaryFaultPlanTokenMaxBytes } from "../packages/features/hosted-account-pool/src/application/ports/hosted-codex-canary-fault-plan-port.js";
import {
  createRenderHostedPoolControlPort,
  executeHostedPoolControl,
  HostedPoolRollbackError,
  type HostedPoolControlPort,
} from "./hosted-pool-production-control";
import type {
  CanaryRunEvidence,
  HostedPoolCanaryConfig,
  HostedPoolCanaryPhase,
  HostedPoolCanaryPort,
  HostedPoolDeploymentEvidencePort,
} from "./hosted-pool-production-ports";
import {
  assertCanonicalAttemptOnePullRequestRun,
  GITHUB_RUN_CLOCK_TOLERANCE_MS,
} from "./hosted-pool-production-github-dispatch";
import {
  captureHostedPoolPublicationSnapshot,
  type HostedPoolPublicationSnapshot,
  collectExactHostedPoolPublicationEvidence,
  createRenderHostedPoolDeploymentEvidencePort,
  readExactHostedPoolRunEvidence,
} from "./hosted-pool-production-evidence";
import { verifyHostedPoolRollbackEvidence } from "./hosted-pool-production-rollback-verification";
import type { CanaryPhaseScope } from "./hosted-pool-canary-phase-recovery";
export type {
  CanaryRunEvidence,
  HostedPoolCanaryConfig,
  HostedPoolCanaryPort,
} from "./hosted-pool-production-ports";

export const hostedPoolCanaryTarget = Object.freeze({
  owner: "777genius",
  repository: "rr-codex-rotating-e2e",
  fullName: "777genius/rr-codex-rotating-e2e",
  workflowPath: ".github/workflows/reviewrouter-codex.yml",
});

export function assertExactPullRequestHead(
  value: unknown,
  input: {
    pullRequestNumber: number;
    headSha: string;
    errorCode: string;
    repositoryId?: number;
    repositoryFullName?: string;
  },
) {
  const pullRequest = value as any;
  if (
    pullRequest?.number !== input.pullRequestNumber ||
    pullRequest?.state !== "open" ||
    String(pullRequest?.head?.sha ?? "").toLowerCase() !== input.headSha ||
    String(pullRequest?.merge_commit_sha ?? "").toLowerCase() ===
      input.headSha ||
    (input.repositoryId !== undefined &&
      (pullRequest?.base?.repo?.id !== input.repositoryId ||
        pullRequest?.head?.repo?.id !== input.repositoryId)) ||
    (input.repositoryFullName !== undefined &&
      String(pullRequest?.base?.repo?.full_name ?? "").toLowerCase() !==
        input.repositoryFullName.toLowerCase())
  )
    throw new Error(input.errorCode);
}

export function assertExactReleasePullRequestRevision(
  value: unknown,
  input: {
    pullRequestNumber: number;
    releaseHeadSha: string;
    repositoryFullName: string;
    errorCode: string;
  },
) {
  const pullRequest = value as any;
  const headSha = pullRequest?.head?.sha;
  const mergeCommitSha = pullRequest?.merge_commit_sha;
  const repositoryFullName = pullRequest?.base?.repo?.full_name;
  const shaPattern = /^[a-f0-9]{40}$/iu;
  const expectedSha =
    typeof input.releaseHeadSha === "string"
      ? input.releaseHeadSha.toLowerCase()
      : "";
  const normalizedHeadSha =
    typeof headSha === "string" ? headSha.toLowerCase() : "";
  const normalizedMergeCommitSha =
    typeof mergeCommitSha === "string" ? mergeCommitSha.toLowerCase() : "";
  const identityMatches =
    Number.isSafeInteger(input.pullRequestNumber) &&
    input.pullRequestNumber > 0 &&
    shaPattern.test(input.releaseHeadSha) &&
    typeof input.repositoryFullName === "string" &&
    input.repositoryFullName.length > 0 &&
    pullRequest?.number === input.pullRequestNumber &&
    typeof repositoryFullName === "string" &&
    repositoryFullName.toLowerCase() ===
      input.repositoryFullName.toLowerCase() &&
    typeof headSha === "string" &&
    shaPattern.test(headSha) &&
    (mergeCommitSha === null ||
      (typeof mergeCommitSha === "string" && shaPattern.test(mergeCommitSha)));
  const isExactOpenHead =
    pullRequest?.state === "open" &&
    pullRequest?.merged === false &&
    pullRequest?.merged_at === null &&
    normalizedHeadSha === expectedSha &&
    normalizedMergeCommitSha !== expectedSha;
  const mergedAtValue = pullRequest?.merged_at;
  const mergedAt =
    typeof mergedAtValue === "string" ? new Date(mergedAtValue) : null;
  const canonicalMergedAtValue =
    typeof mergedAtValue === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(mergedAtValue)
      ? `${mergedAtValue.slice(0, -1)}.000Z`
      : mergedAtValue;
  const isExactMergedRevision =
    pullRequest?.state === "closed" &&
    pullRequest?.merged === true &&
    typeof mergedAtValue === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(mergedAtValue) &&
    mergedAt !== null &&
    Number.isFinite(mergedAt.getTime()) &&
    mergedAt.toISOString() === canonicalMergedAtValue &&
    typeof mergeCommitSha === "string" &&
    normalizedMergeCommitSha === expectedSha;
  if (!identityMatches || (!isExactOpenHead && !isExactMergedRevision))
    throw new Error(input.errorCode);
}

export function assertFreshAttemptTwoRun(
  value: unknown,
  input: {
    runId: number;
    expectedConclusion: "success" | "failure";
    sourceHeadSha: string;
    rerunRequestedAt: Date;
  },
) {
  const run = value as any;
  if (run?.run_attempt > 2)
    throw new Error(`hosted_pool_canary_run_replayed:${input.runId}`);
  if (run?.run_attempt !== 2 || run?.status !== "completed") return null;
  if (run.conclusion !== input.expectedConclusion)
    throw new Error(
      `hosted_pool_canary_run_failed:${input.runId}:${run.conclusion}`,
    );
  const startedAt = new Date(run.run_started_at);
  const finishedAt = new Date(run.updated_at);
  if (
    String(run.head_sha ?? "").toLowerCase() !== input.sourceHeadSha ||
    !Number.isFinite(startedAt.getTime()) ||
    !Number.isFinite(finishedAt.getTime()) ||
    startedAt.getTime() <
      input.rerunRequestedAt.getTime() - GITHUB_RUN_CLOCK_TOLERANCE_MS ||
    finishedAt < startedAt
  )
    throw new Error(`hosted_pool_canary_run_timestamps_invalid:${input.runId}`);
  return { startedAt, finishedAt };
}

export function parseHostedPoolCanaryConfig(
  env: Readonly<Record<string, string | undefined>>,
): HostedPoolCanaryConfig {
  const repositoryId = positive(
    env.REVIEW_ROUTER_HOSTED_POOL_CANARY_REPOSITORY_ID,
  );
  const installationId = positive(
    env.REVIEW_ROUTER_HOSTED_POOL_CANARY_INSTALLATION_ID,
  );
  const allowlist = required(
    env.REVIEW_ROUTER_HOSTED_POOL_CANARY_REPOSITORY_ALLOWLIST,
  )
    .split(",")
    .map((value) => positive(value));
  if (allowlist.length !== 1 || allowlist[0] !== repositoryId)
    throw new Error("hosted_pool_canary_exact_repository_allowlist_required");
  const actionSha = required(
    env.REVIEW_ROUTER_HOSTED_POOL_CANARY_ACTION_SHA,
  ).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(actionSha))
    throw new Error("hosted_pool_canary_action_sha_invalid");
  if (
    env.REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA?.trim().toLowerCase() !==
      actionSha ||
    env.REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF?.trim() !==
      `777genius/review-router@${actionSha}`
  )
    throw new Error("hosted_pool_canary_action_release_mismatch");
  const releasePullRequestNumber = positive(
    env.REVIEW_ROUTER_HOSTED_POOL_CANARY_RELEASE_PR_NUMBER,
  );
  const releaseHeadSha = required(
    env.REVIEW_ROUTER_HOSTED_POOL_CANARY_RELEASE_HEAD_SHA,
  ).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(releaseHeadSha))
    throw new Error("hosted_pool_canary_release_head_sha_invalid");
  const appSlug = required(
    env.REVIEW_ROUTER_HOSTED_POOL_CANARY_APP_SLUG,
  ).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(appSlug))
    throw new Error("hosted_pool_canary_app_slug_invalid");
  if (
    positive(env.REVIEW_ROUTER_HOSTED_POOL_CANARY_DISPOSABLE_REPOSITORY_ID) !==
    repositoryId
  )
    throw new Error("hosted_pool_canary_disposable_repository_id_mismatch");
  const poolId = required(env.REVIEW_ROUTER_HOSTED_POOL_CANARY_POOL_ID);
  const accountIds = parseExactStringTuple(
    env.REVIEW_ROUTER_HOSTED_POOL_CANARY_ACCOUNT_IDS_JSON,
    "hosted_pool_canary_exact_account_pool_required",
  );
  const faultPlans = parseExactObject(
    env.REVIEW_ROUTER_HOSTED_POOL_CANARY_FAULT_PLANS_JSON,
    ["unauthorized", "rate_limited", "dropped_response"] as const,
    "hosted_pool_canary_fault_plans_invalid",
  );
  if (
    Object.values(faultPlans).some(
      (token) =>
        !token.startsWith("rr-canary-fault-v2.") ||
        Buffer.byteLength(token, "utf8") >
          hostedCodexCanaryFaultPlanTokenMaxBytes,
    ) ||
    new Set(Object.values(faultPlans)).size !== 3
  )
    throw new Error("hosted_pool_canary_fault_plans_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      required(env.REVIEW_ROUTER_HOSTED_POOL_CANARY_RUN_IDS_JSON),
    );
  } catch {
    throw new Error("hosted_pool_canary_run_ids_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("hosted_pool_canary_run_ids_invalid");
  const names: HostedPoolCanaryPhase[] = [
    "simultaneous_a",
    "simultaneous_b",
    "unauthorized",
    "rate_limited",
    "dropped_response",
  ];
  if (Object.keys(parsed).sort().join(",") !== [...names].sort().join(","))
    throw new Error("hosted_pool_canary_run_ids_invalid");
  const runs = Object.fromEntries(
    names.map((name) => [
      name,
      positive((parsed as Record<string, unknown>)[name]),
    ]),
  ) as Record<HostedPoolCanaryPhase, number>;
  if (new Set(Object.values(runs)).size !== names.length)
    throw new Error("hosted_pool_canary_run_ids_not_unique");
  return Object.freeze({
    repositoryId,
    installationId,
    allowlistedRepositoryId: repositoryId,
    appSlug,
    actionSha,
    releasePullRequestNumber,
    releaseHeadSha,
    poolId,
    accountIds,
    faultPlans,
    runs,
  });
}

export async function runHostedPoolProductionCanary(input: {
  readonly config: HostedPoolCanaryConfig;
  readonly execute: boolean;
  readonly executeConfirmation?: string;
  readonly rollbackConfirmation?: string;
  readonly canary: HostedPoolCanaryPort;
  readonly deployment: HostedPoolDeploymentEvidencePort;
  readonly control: HostedPoolControlPort;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly quiescenceMs?: number;
}) {
  const now = input.now ?? (() => new Date());
  const [preflight, preflightDeployments] = await Promise.all([
    input.canary.preflight(input.config),
    input.deployment.readExactRevision(input.config.releaseHeadSha),
  ]);
  const records: Array<Record<string, unknown>> = [
    {
      phase: "preflight",
      at: now().toISOString(),
      ...preflight,
      deployments: preflightDeployments,
    },
  ];
  if (!input.execute)
    return seal({
      schemaVersion: 3,
      target: hostedPoolCanaryTarget.fullName,
      result: "dry_run",
      records,
    });
  if (
    input.executeConfirmation !== "EXECUTE ONE SHOT HOSTED POOL CANARY" ||
    input.rollbackConfirmation !== "ROLL BACK HOSTED POOL AFTER CANARY"
  )
    throw new Error("hosted_pool_canary_confirmations_required");

  let outcome = "passed";
  try {
    if (
      !input.control.prepareCanaryPhase ||
      !input.control.reconcileCanaryPhase ||
      !input.control.setFaultPlan
    )
      throw new Error("hosted_pool_canary_phase_recovery_control_missing");
    if (
      typeof preflight.repositoryBindingId !== "string" ||
      typeof preflight.bindingRevision !== "string"
    )
      throw new Error("hosted_pool_canary_phase_recovery_binding_missing");
    const protectedScope = await executeHostedPoolControl({
      command: "rollback",
      execute: true,
      confirmation: "EXECUTE HOSTED POOL ROLLBACK",
      port: input.control,
      now,
    });
    verifyHostedPoolRollbackEvidence(protectedScope.events);
    records.push({
      phase: "rollback_protected_scope_entered",
      at: now().toISOString(),
      evidenceSha256: protectedScope.evidenceSha256,
      events: protectedScope.events,
    });
    const activation = await executeHostedPoolControl({
      command: "activate",
      execute: true,
      confirmation: "EXECUTE HOSTED POOL ACTIVATE",
      port: input.control,
      now,
    });
    const activationDeployments = await input.deployment.readExactRevision(
      input.config.releaseHeadSha,
    );
    records.push({
      phase: "ordered_activation",
      at: now().toISOString(),
      evidenceSha256: activation.evidenceSha256,
      events: activation.events,
      deployments: activationDeployments,
    });
    await Promise.all([
      input.canary.rerun(input.config.runs.simultaneous_a),
      input.canary.rerun(input.config.runs.simultaneous_b),
    ]);
    await Promise.all([
      input.canary.waitForCompletion(
        input.config.runs.simultaneous_a,
        "success",
      ),
      input.canary.waitForCompletion(
        input.config.runs.simultaneous_b,
        "success",
      ),
    ]);
    const simultaneous = await Promise.all([
      input.canary.evidence(input.config.runs.simultaneous_a),
      input.canary.evidence(input.config.runs.simultaneous_b),
    ]);
    assertSimultaneousOneAccount(simultaneous);
    records.push({
      phase: "two_simultaneous_one_account",
      at: now().toISOString(),
      evidence: simultaneous,
    });

    for (const [phase, expected] of [
      ["unauthorized", "401"],
      ["rate_limited", "429"],
      ["dropped_response", "dropped"],
    ] as const) {
      const runId = input.config.runs[phase];
      const scope: CanaryPhaseScope = {
        phase,
        runId,
        poolId: input.config.poolId,
        accountIds: input.config.accountIds,
        repositoryId: input.config.repositoryId,
        actionSha: input.config.actionSha,
        repositoryBindingId: preflight.repositoryBindingId,
        bindingRevision: preflight.bindingRevision,
        planIdHash: createHash("sha256")
          .update(input.config.faultPlans[phase], "utf8")
          .digest("hex"),
      };
      let observed: CanaryRunEvidence;
      try {
        await input.control.prepareCanaryPhase(scope);
        // Stage may commit and lose its response. Cancellation must still run.
        await input.control.setFaultPlan(input.config.faultPlans[phase]);
        await input.canary.rerun(runId);
        await input.canary.waitForCompletion(
          runId,
          phase === "dropped_response" ? "failure" : "success",
        );
        observed = await input.canary.evidence(runId);
      } finally {
        await input.control.setFaultPlan(null);
      }
      assertClassifiedOutcome(observed, expected);
      if (phase === "dropped_response") {
        await (
          input.sleep ??
          ((milliseconds) =>
            new Promise((done) => setTimeout(done, milliseconds)))
        )(input.quiescenceMs ?? 15_000);
        const quiesced = await input.canary.evidence(runId);
        assertStableDroppedEvidence(observed, quiesced);
        observed = quiesced;
      }
      const reconciliation = await input.control.reconcileCanaryPhase(
        scope,
        observed,
      );
      records.push({
        phase,
        classification: expected,
        at: now().toISOString(),
        evidence: observed,
        reconciliation,
      });
    }
  } catch (error) {
    outcome = "failed";
    records.push({
      phase: "failure",
      at: now().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      const rollback = await executeHostedPoolControl({
        command: "rollback",
        execute: true,
        confirmation: "EXECUTE HOSTED POOL ROLLBACK",
        port: input.control,
        now,
      });
      verifyHostedPoolRollbackEvidence(rollback.events);
      const rollbackDeployments = await input.deployment.readExactRevision(
        input.config.releaseHeadSha,
      );
      records.push({
        phase: "ordered_rollback",
        at: now().toISOString(),
        outcome,
        evidenceSha256: rollback.evidenceSha256,
        events: rollback.events,
        deployments: rollbackDeployments,
      });
    } catch (error) {
      outcome = "failed";
      records.push({
        phase: "ordered_rollback_failed",
        at: now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof HostedPoolRollbackError
          ? { rollbackEvidence: error.rollbackEvidence }
          : {}),
      });
    }
  }
  return seal({
    schemaVersion: 3,
    target: hostedPoolCanaryTarget.fullName,
    result: outcome,
    records,
  });
}

export function assertSimultaneousOneAccount(
  items: readonly CanaryRunEvidence[],
) {
  const firstAttempt = items[0]?.attempts[0];
  const secondAttempt = items[1]?.attempts[0];
  const firstInterval = readSuccessfulAttemptInterval(items[0], firstAttempt);
  const secondInterval = readSuccessfulAttemptInterval(items[1], secondAttempt);
  const overlaps =
    firstInterval &&
    secondInterval &&
    firstInterval.startedAt < secondInterval.completedAt &&
    secondInterval.startedAt < firstInterval.completedAt;
  if (
    items.length !== 2 ||
    items[0]!.invocationId === items[1]!.invocationId ||
    items.some(
      (item) =>
        item.grantStatus === "revoked" || item.grantStatus === "expired",
    ) ||
    items[0]!.primaryAccountId !== items[1]!.primaryAccountId ||
    items[0]!.activeAccountId !== items[1]!.activeAccountId ||
    !overlaps ||
    items.some(
      (item) =>
        item.activeAccountId !== item.primaryAccountId ||
        item.failoverCount !== 0 ||
        item.requestStatuses.length !== 1 ||
        item.requestStatuses[0] !== "succeeded" ||
        item.requestErrorCode !== null ||
        item.attempts.length !== 1 ||
        item.attempts[0]!.state !== "succeeded" ||
        item.attempts[0]!.errorCode !== null ||
        item.attempts[0]!.accountId !== item.primaryAccountId ||
        !hasBoundProviderPublication(item) ||
        item.appBotPublicationCount < 1 ||
        item.nonAppBotPublicationCount !== 0 ||
        item.faultPlanConsumptionCount !== 0 ||
        item.faultPlanConsumptions.length !== 0,
    )
  )
    throw new Error("hosted_pool_canary_simultaneous_account_contract_failed");
}

export function assertClassifiedOutcome(
  item: CanaryRunEvidence,
  expected: "401" | "429" | "dropped",
) {
  if (expected === "dropped") {
    if (
      item.failoverCount !== 0 ||
      item.grantStatus !== "revoked" ||
      item.grantRevokedAt === null ||
      item.commentRefreshRevokedAt === null ||
      item.activeAccountId !== item.primaryAccountId ||
      item.requestStatuses.length !== 1 ||
      item.requestStatuses[0] !== "terminal_unknown" ||
      item.requestErrorCode !== "ambiguous_dropped_response" ||
      item.requestStartedAt === null ||
      item.successfulResponseStartedAt === null ||
      item.completedAt === null ||
      item.attempts.length !== 1 ||
      item.attempts[0]!.state !== "terminal_unknown" ||
      item.attempts[0]!.errorCode !== "ambiguous_dropped_response" ||
      item.attempts[0]!.accountId !== item.primaryAccountId ||
      item.attempts[0]!.dispatchStartedAt === null ||
      item.attempts[0]!.responseStartedAt === null ||
      item.attempts[0]!.completedAt === null ||
      !hasExactFaultConsumption(item, "drop_after_response_started") ||
      item.providerResponseIdHash !== null ||
      item.publicationAttemptId !== null ||
      item.publicationObjects.length !== 0 ||
      item.nonAppBotPublicationCount !== 0
    )
      throw new Error("hosted_pool_canary_dropped_response_replayed");
    return;
  }
  const syntheticAttempt = item.attempts[0];
  const successfulAttempt = item.attempts[1];
  if (
    item.failoverCount !== 1 ||
    !item.backupAccountId ||
    item.primaryAccountId === item.backupAccountId ||
    item.activeAccountId !== item.backupAccountId ||
    item.attempts.length !== 2 ||
    item.requestStatuses.length !== 1 ||
    item.requestStatuses[0] !== "succeeded" ||
    item.requestErrorCode !== null ||
    item.requestStartedAt === null ||
    item.successfulResponseStartedAt === null ||
    item.completedAt === null ||
    syntheticAttempt?.ordinal !== 1 ||
    syntheticAttempt.state !== "failed_no_effect" ||
    syntheticAttempt.errorCode !==
      (expected === "401" ? "credential_invalid" : "quota_limited") ||
    syntheticAttempt.accountId !== item.primaryAccountId ||
    syntheticAttempt.dispatchStartedAt !== null ||
    syntheticAttempt.responseStartedAt !== null ||
    syntheticAttempt.completedAt === null ||
    successfulAttempt?.ordinal !== 2 ||
    successfulAttempt.state !== "succeeded" ||
    successfulAttempt.errorCode !== null ||
    successfulAttempt.accountId !== item.backupAccountId ||
    successfulAttempt.dispatchStartedAt === null ||
    successfulAttempt.responseStartedAt === null ||
    successfulAttempt.completedAt === null ||
    !hasExactFaultConsumption(
      item,
      expected === "401" ? "synthetic_unauthorized" : "synthetic_rate_limited",
    ) ||
    !hasBoundProviderPublication(item) ||
    item.appBotPublicationCount < 1 ||
    item.nonAppBotPublicationCount !== 0
  )
    throw new Error(`hosted_pool_canary_${expected}_backup_contract_failed`);
}

function hasBoundProviderPublication(item: CanaryRunEvidence) {
  return (
    item.sourceRunAttempt === 2 &&
    /^[a-f0-9]{40}$/u.test(item.sourceHeadSha) &&
    item.sourceExecutionId.length > 0 &&
    /^[a-f0-9]{64}$/u.test(item.providerInvocationKey) &&
    /^[a-f0-9]{64}$/u.test(item.providerResponseIdHash ?? "") &&
    Boolean(item.publicationAttemptId) &&
    item.publicationObjects.length > 0
  );
}

function assertStableDroppedEvidence(
  before: CanaryRunEvidence,
  after: CanaryRunEvidence,
) {
  const stable = (item: CanaryRunEvidence) => ({
    sourceRunAttempt: item.sourceRunAttempt,
    sourceHeadSha: item.sourceHeadSha,
    sourceExecutionId: item.sourceExecutionId,
    grantId: item.grantId,
    invocationId: item.invocationId,
    workspaceId: item.workspaceId,
    githubRepositoryId: item.githubRepositoryId,
    actionRef: item.actionRef,
    activeAccountId: item.activeAccountId,
    primaryAccountId: item.primaryAccountId,
    backupAccountId: item.backupAccountId,
    failoverCount: item.failoverCount,
    grantStatus: item.grantStatus,
    grantRevokedAt: item.grantRevokedAt,
    commentRefreshRevokedAt: item.commentRefreshRevokedAt,
    repositoryBindingId: item.repositoryBindingId,
    bindingRevision: item.bindingRevision,
    issuedAt: item.issuedAt,
    completedAt: item.completedAt,
    requestId: item.requestId,
    requestOrdinal: item.requestOrdinal,
    requestErrorCode: item.requestErrorCode,
    requestReceivedAt: item.requestReceivedAt,
    requestStartedAt: item.requestStartedAt,
    successfulResponseStartedAt: item.successfulResponseStartedAt,
    providerInvocationKey: item.providerInvocationKey,
    providerResponseIdHash: item.providerResponseIdHash,
    publicationAttemptId: item.publicationAttemptId,
    appBotPublicationCount: item.appBotPublicationCount,
    nonAppBotPublicationCount: item.nonAppBotPublicationCount,
    publicationObjects: item.publicationObjects,
    requestStatuses: item.requestStatuses,
    attempts: item.attempts,
    faultPlanConsumptionCount: item.faultPlanConsumptionCount,
    faultPlanConsumptions: item.faultPlanConsumptions,
  });
  if (JSON.stringify(stable(before)) !== JSON.stringify(stable(after)))
    throw new Error("hosted_pool_canary_dropped_response_not_quiescent");
}

function hasExactFaultConsumption(
  item: CanaryRunEvidence,
  phase:
    | "synthetic_unauthorized"
    | "synthetic_rate_limited"
    | "drop_after_response_started",
) {
  const expectedInjectionPoint =
    phase === "drop_after_response_started"
      ? "after_response_started"
      : "before_provider_fetch";
  return (
    item.faultPlanConsumptionCount === 1 &&
    item.faultPlanConsumptions.length === 1 &&
    item.faultPlanConsumptions[0]!.phase === phase &&
    item.faultPlanConsumptions[0]!.repositoryId === item.githubRepositoryId &&
    item.faultPlanConsumptions[0]!.runAttempt === 2 &&
    item.faultPlanConsumptions[0]!.actionRef === item.actionRef &&
    item.faultPlanConsumptions[0]!.bindingId === item.repositoryBindingId &&
    item.faultPlanConsumptions[0]!.bindingRevision === item.bindingRevision &&
    item.faultPlanConsumptions[0]!.requestOrdinal === item.requestOrdinal &&
    item.faultPlanConsumptions[0]!.attemptOrdinal === 1 &&
    item.faultPlanConsumptions[0]!.injectionPoint === expectedInjectionPoint
  );
}

function readSuccessfulAttemptInterval(
  item: CanaryRunEvidence | undefined,
  attempt: CanaryRunEvidence["attempts"][number] | undefined,
) {
  if (
    !item ||
    !attempt?.dispatchStartedAt ||
    !attempt.responseStartedAt ||
    !attempt.completedAt ||
    !item.completedAt
  )
    return null;
  const issuedAt = new Date(item.issuedAt);
  const startedAt = new Date(attempt.dispatchStartedAt);
  const responseStartedAt = new Date(attempt.responseStartedAt);
  const completedAt = new Date(attempt.completedAt);
  const requestCompletedAt = new Date(item.completedAt);
  if (
    [
      issuedAt,
      startedAt,
      responseStartedAt,
      completedAt,
      requestCompletedAt,
    ].some((value) => !Number.isFinite(value.getTime())) ||
    startedAt < issuedAt ||
    responseStartedAt < startedAt ||
    completedAt < responseStartedAt ||
    requestCompletedAt < completedAt
  )
    return null;
  return { startedAt, completedAt };
}

function seal<T extends Record<string, unknown>>(
  payload: T,
): Readonly<T & { evidenceSha256: string }> {
  return Object.freeze({
    ...payload,
    evidenceSha256: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  });
}

export function createGitHubHostedPoolCanaryPort(input: {
  appJwt: string;
  repositoryToken: string;
  databaseUrl: string;
  now?: () => Date;
}): HostedPoolCanaryPort & { disconnect(): Promise<void> } {
  const prisma = createPrismaClient({
    databaseUrl: input.databaseUrl,
    poolMax: 1,
  });
  const pullRequests = new Map<number, number>();
  const sourceHeads = new Map<number, string>();
  const publicationBaselines = new Map<number, HostedPoolPublicationSnapshot>();
  const rerunRequestedAt = new Map<number, Date>();
  const attemptWindows = new Map<
    number,
    { readonly startedAt: Date; readonly finishedAt: Date }
  >();
  let expectedAppBot = "";
  let expectedBinding:
    | { readonly id: string; readonly revision: bigint }
    | undefined;
  const request = async (
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`hosted_pool_canary_github_${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  return {
    async preflight(config) {
      const repository: any = await request(
        input.repositoryToken,
        "GET",
        `/repos/${hostedPoolCanaryTarget.fullName}`,
      );
      if (
        repository.id !== config.repositoryId ||
        repository.full_name?.toLowerCase() !==
          hostedPoolCanaryTarget.fullName ||
        repository.archived === true ||
        !["private", "internal"].includes(String(repository.visibility))
      )
        throw new Error("hosted_pool_canary_repository_identity_mismatch");
      const installation: any = await request(
        input.appJwt,
        "GET",
        `/repos/${hostedPoolCanaryTarget.fullName}/installation`,
      );
      if (
        installation.id !== config.installationId ||
        installation.app_slug?.toLowerCase() !== config.appSlug
      )
        throw new Error("hosted_pool_canary_installation_identity_mismatch");
      const defaultBranchCommit: any = await request(
        input.repositoryToken,
        "GET",
        `/repos/${hostedPoolCanaryTarget.fullName}/commits/${encodeURIComponent(repository.default_branch)}`,
      );
      if (!/^[a-f0-9]{40}$/iu.test(String(defaultBranchCommit.sha ?? "")))
        throw new Error("hosted_pool_canary_default_branch_revision_invalid");
      const workflow: any = await request(
        input.repositoryToken,
        "GET",
        `/repos/${hostedPoolCanaryTarget.fullName}/contents/${hostedPoolCanaryTarget.workflowPath}?ref=${encodeURIComponent(defaultBranchCommit.sha)}`,
      );
      const source = Buffer.from(workflow.content ?? "", "base64").toString(
        "utf8",
      );
      const scan = scanCanonicalHostedPoolWorkflowV2(source);
      const metadata = scan.valid
        ? readCanonicalHostedPoolWorkflowMetadata(source)
        : null;
      if (
        !metadata ||
        metadata.actionRef !== `777genius/review-router@${config.actionSha}` ||
        metadata.providerInstanceId !==
          canonicalHostedPoolProviderInstanceId(String(config.repositoryId))
      )
        throw new Error("hosted_pool_canary_workflow_tuple_mismatch");
      expectedAppBot = `${config.appSlug}[bot]`.toLowerCase();
      const releasePullRequest: any = await request(
        input.repositoryToken,
        "GET",
        `/repos/777genius/review-router-saas/pulls/${config.releasePullRequestNumber}`,
      );
      assertExactReleasePullRequestRevision(releasePullRequest, {
        pullRequestNumber: config.releasePullRequestNumber,
        releaseHeadSha: config.releaseHeadSha,
        repositoryFullName: "777genius/review-router-saas",
        errorCode: "hosted_pool_canary_release_pr_head_mismatch",
      });
      for (const runId of Object.values(config.runs)) {
        const run: any = await request(
          input.repositoryToken,
          "GET",
          `/repos/${hostedPoolCanaryTarget.fullName}/actions/runs/${runId}`,
        );
        const sourceRun = assertCanonicalAttemptOnePullRequestRun(run, {
          runId,
          repositoryId: config.repositoryId,
          workflowPath: hostedPoolCanaryTarget.workflowPath,
        });
        const pullRequest: any = await request(
          input.repositoryToken,
          "GET",
          `/repos/${hostedPoolCanaryTarget.fullName}/pulls/${sourceRun.pullRequestNumber}`,
        );
        assertExactPullRequestHead(pullRequest, {
          pullRequestNumber: sourceRun.pullRequestNumber,
          headSha: sourceRun.headSha,
          repositoryId: config.repositoryId,
          errorCode: `hosted_pool_canary_source_pr_head_mismatch:${runId}`,
        });
        pullRequests.set(runId, sourceRun.pullRequestNumber);
        sourceHeads.set(runId, sourceRun.headSha);
        const runWorkflow: any = await request(
          input.repositoryToken,
          "GET",
          `/repos/${hostedPoolCanaryTarget.fullName}/contents/${hostedPoolCanaryTarget.workflowPath}?ref=${encodeURIComponent(sourceRun.headSha)}`,
        );
        const runSource = Buffer.from(
          runWorkflow.content ?? "",
          "base64",
        ).toString("utf8");
        const runScan = scanCanonicalHostedPoolWorkflowV2(runSource);
        const runMetadata = runScan.valid
          ? readCanonicalHostedPoolWorkflowMetadata(runSource)
          : null;
        if (
          !runMetadata ||
          runMetadata.actionRef !==
            `777genius/review-router@${config.actionSha}` ||
          runMetadata.bindingId !== metadata.bindingId ||
          runMetadata.bindingRevision !== metadata.bindingRevision ||
          runMetadata.providerInstanceId !== metadata.providerInstanceId
        )
          throw new Error(
            `hosted_pool_canary_source_run_tuple_mismatch:${runId}`,
          );
      }
      const activeBindings = await prisma.hostedCodexRepositoryBinding.findMany(
        {
          where: { status: "active" },
          select: {
            id: true,
            poolId: true,
            revision: true,
            workflowActionRef: true,
            workflowPath: true,
            workflowSourceCommitSha: true,
            workflowSourceBlobSha: true,
            workflowSourceSha256: true,
            workflowSemanticSha256: true,
            repositoryConnectionId: true,
            repository: {
              select: {
                githubRepositoryId: true,
                fullName: true,
                installation: {
                  select: { githubInstallationId: true, status: true },
                },
              },
            },
            pool: {
              select: {
                status: true,
                accounts: {
                  select: { id: true, state: true },
                  orderBy: { id: "asc" },
                },
              },
            },
          },
        },
      );
      if (activeBindings.length !== 1)
        throw new Error("hosted_pool_canary_non_target_active_binding_present");
      const binding = activeBindings[0];
      if (
        !binding ||
        binding.id !== metadata.bindingId ||
        binding.poolId !== config.poolId ||
        binding.revision !== BigInt(metadata.bindingRevision) ||
        binding.workflowActionRef !==
          `777genius/review-router@${config.actionSha}` ||
        binding.workflowPath !== hostedPoolCanaryTarget.workflowPath ||
        binding.workflowSourceCommitSha?.toLowerCase() !==
          String(defaultBranchCommit.sha).toLowerCase() ||
        binding.workflowSourceBlobSha?.toLowerCase() !==
          String(workflow.sha).toLowerCase() ||
        binding.workflowSourceSha256?.toLowerCase() !==
          createHash("sha256").update(source, "utf8").digest("hex") ||
        binding.workflowSemanticSha256?.toLowerCase() !==
          hostedPoolWorkflowSemanticSha256(source) ||
        binding.repository.githubRepositoryId !== BigInt(config.repositoryId) ||
        binding.repository.fullName.toLowerCase() !==
          hostedPoolCanaryTarget.fullName ||
        binding.repository.installation?.githubInstallationId !==
          BigInt(config.installationId) ||
        binding.repository.installation?.status !== "active"
      )
        throw new Error("hosted_pool_canary_binding_action_sha_mismatch");
      expectedBinding = { id: binding.id, revision: binding.revision };
      const observedAccountIds = binding.pool.accounts
        .map(({ id }) => id)
        .sort();
      if (
        binding.pool.status !== "active" ||
        observedAccountIds.join("\0") !==
          [...config.accountIds].sort().join("\0") ||
        binding.pool.accounts.some(({ state }) => state !== "healthy")
      )
        throw new Error("hosted_pool_canary_dedicated_account_pool_invalid");
      const configurations = await prisma.reviewConfiguration.findMany({
        where: { repositoryId: binding.repositoryConnectionId },
        select: {
          versions: {
            orderBy: { version: "desc" },
            take: 1,
            select: {
              fastMode: true,
              providerAuthMode: true,
              providers: {
                select: { fastMode: true, providerAuthMode: true },
              },
            },
          },
        },
      });
      const currentVersions = configurations.flatMap((item) => item.versions);
      if (
        currentVersions.length !== 1 ||
        currentVersions[0]!.fastMode ||
        currentVersions[0]!.providerAuthMode !==
          "codex_subscription_oauth_hosted_pool" ||
        currentVersions[0]!.providers.length < 1 ||
        currentVersions[0]!.providers.some(
          (provider) =>
            provider.fastMode ||
            provider.providerAuthMode !==
              "codex_subscription_oauth_hosted_pool",
        )
      )
        throw new Error(
          "hosted_pool_canary_hosted_dependency_contract_invalid",
        );
      // Capture every original source PR/head before any run can be dispatched.
      // Keep these snapshots for all evidence reads, including quiescence.
      for (const runId of Object.values(config.runs)) {
        publicationBaselines.set(
          runId,
          await captureHostedPoolPublicationSnapshot(
            {
              request: (method, path, body) =>
                request(input.repositoryToken, method, path, body),
            },
            {
              repository: hostedPoolCanaryTarget.fullName,
              pullRequestNumber: pullRequests.get(runId)!,
              sourceHeadSha: sourceHeads.get(runId)!,
              now: input.now,
            },
          ),
        );
      }
      return {
        repositoryId: config.repositoryId,
        installationId: config.installationId,
        allowlist: [config.repositoryId],
        actionSha: config.actionSha,
        repositoryConnectionId: binding.repositoryConnectionId,
        repositoryBindingId: binding.id,
        bindingRevision: binding.revision.toString(),
        poolId: binding.poolId,
        accountIds: observedAccountIds,
        workflowTuple: {
          reusableWorkflowRef: `777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@${config.actionSha}`,
          actionRef: `777genius/review-router@${config.actionSha}`,
        },
      };
    },
    async rerun(runId) {
      const baseline = publicationBaselines.get(runId);
      const dispatchedAt = (input.now ?? (() => new Date()))();
      if (
        !baseline ||
        !Number.isFinite(dispatchedAt.getTime()) ||
        Date.parse(baseline.captureCompletedAt) > dispatchedAt.getTime()
      )
        throw new Error(
          `hosted_pool_canary_publication_scope_missing:${runId}`,
        );
      rerunRequestedAt.set(runId, dispatchedAt);
      await request(
        input.repositoryToken,
        "POST",
        `/repos/${hostedPoolCanaryTarget.fullName}/actions/runs/${runId}/rerun`,
        { enable_debug_logging: false },
      );
    },
    async waitForCompletion(runId, expectedConclusion) {
      for (let poll = 0; poll < 120; poll += 1) {
        const run: any = await request(
          input.repositoryToken,
          "GET",
          `/repos/${hostedPoolCanaryTarget.fullName}/actions/runs/${runId}`,
        );
        const requestedAt = rerunRequestedAt.get(runId);
        const sourceHeadSha = sourceHeads.get(runId);
        if (!requestedAt || !sourceHeadSha)
          throw new Error(`hosted_pool_canary_run_scope_missing:${runId}`);
        const window = assertFreshAttemptTwoRun(run, {
          runId,
          expectedConclusion,
          sourceHeadSha,
          rerunRequestedAt: requestedAt,
        });
        if (window) {
          attemptWindows.set(runId, window);
          return;
        }
        await new Promise((done) => setTimeout(done, 5_000));
      }
      throw new Error(`hosted_pool_canary_run_timeout:${runId}`);
    },
    async evidence(runId) {
      const prNumber = pullRequests.get(runId);
      const sourceHeadSha = sourceHeads.get(runId);
      const attemptWindow = attemptWindows.get(runId);
      const baseline = publicationBaselines.get(runId);
      const dispatchedAt = rerunRequestedAt.get(runId);
      if (
        !prNumber ||
        !sourceHeadSha ||
        !expectedAppBot ||
        !expectedBinding ||
        !attemptWindow ||
        !baseline ||
        !dispatchedAt
      )
        throw new Error(
          `hosted_pool_canary_publication_scope_missing:${runId}`,
        );
      const publication = await collectExactHostedPoolPublicationEvidence(
        {
          request: (method, path, body) =>
            request(input.repositoryToken, method, path, body),
        },
        {
          repository: hostedPoolCanaryTarget.fullName,
          pullRequestNumber: prNumber,
          expectedAppBot,
          exactRunId: runId,
          sourceHeadSha,
          baseline,
          dispatchedAt,
          now: input.now,
          ...attemptWindow,
        },
      );
      return readExactHostedPoolRunEvidence({
        prisma,
        runId,
        runAttempt: 2,
        repositoryBindingId: expectedBinding.id,
        bindingRevision: expectedBinding.revision,
        sourceHeadSha,
        publication,
      });
    },
    disconnect: () => prisma.$disconnect(),
  };
}

async function main() {
  const config = parseHostedPoolCanaryConfig(process.env);
  const databaseUrl = required(
    process.env.REVIEW_ROUTER_HOSTED_POOL_OPERATOR_DATABASE_URL,
  );
  const canary = createGitHubHostedPoolCanaryPort({
    appJwt: required(process.env.REVIEW_ROUTER_HOSTED_POOL_CANARY_APP_JWT),
    repositoryToken: required(
      process.env.REVIEW_ROUTER_HOSTED_POOL_CANARY_REPOSITORY_TOKEN,
    ),
    databaseUrl,
  });
  const ids = required(process.env.REVIEW_ROUTER_HOSTED_POOL_RENDER_SERVICE_IDS)
    .split(",")
    .map((value) => value.trim());
  if (ids.length !== 2)
    throw new Error("hosted_pool_exact_api_web_service_ids_required");
  const control = createRenderHostedPoolControlPort({
    apiKey: required(process.env.RENDER_API_KEY),
    serviceIds: ids as [string, string],
    databaseUrl,
  });
  const deployment = createRenderHostedPoolDeploymentEvidencePort({
    apiKey: required(process.env.RENDER_API_KEY),
    serviceIds: ids as [string, string],
  });
  try {
    const result = await runHostedPoolProductionCanary({
      config,
      execute: process.argv.includes("--execute"),
      ...(process.env.REVIEW_ROUTER_HOSTED_POOL_CANARY_CONFIRM
        ? {
            executeConfirmation:
              process.env.REVIEW_ROUTER_HOSTED_POOL_CANARY_CONFIRM,
          }
        : {}),
      ...(process.env.REVIEW_ROUTER_HOSTED_POOL_CANARY_ROLLBACK_CONFIRM
        ? {
            rollbackConfirmation:
              process.env.REVIEW_ROUTER_HOSTED_POOL_CANARY_ROLLBACK_CONFIRM,
          }
        : {}),
      canary,
      deployment,
      control,
    });
    const output = resolve(
      process.env.REVIEW_ROUTER_HOSTED_POOL_CANARY_EVIDENCE_FILE ??
        `/tmp/reviewrouter-hosted-pool-canary/canary-${Date.now()}.json`,
    );
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        result: result.result,
        evidenceFile: output,
        evidenceSha256: result.evidenceSha256,
      }),
    );
    if (result.result !== "passed" && result.result !== "dry_run")
      process.exitCode = 1;
  } finally {
    await Promise.all([canary.disconnect(), control.disconnect()]);
  }
}

function required(value: unknown) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error("hosted_pool_canary_required_value_missing");
  return result;
}
function positive(value: unknown) {
  const parsed = Number(required(value));
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("hosted_pool_canary_positive_integer_required");
  return parsed;
}

function parseExactStringTuple(
  value: unknown,
  errorCode: string,
): readonly [string, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(required(value));
  } catch {
    throw new Error(errorCode);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    parsed.some((item) => typeof item !== "string" || item.length === 0) ||
    parsed[0] === parsed[1]
  )
    throw new Error(errorCode);
  return parsed as [string, string];
}

function parseExactObject<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
  errorCode: string,
): Record<Keys[number], string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(required(value));
  } catch {
    throw new Error(errorCode);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join("\0") !== [...keys].sort().join("\0") ||
    Object.values(parsed).some(
      (item) => typeof item !== "string" || item.length === 0,
    )
  )
    throw new Error(errorCode);
  return parsed as Record<Keys[number], string>;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
