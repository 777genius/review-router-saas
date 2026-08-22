import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../packages/platform/db/src/index.js";
import {
  createRenderHostedPoolControlPort,
  executeHostedPoolControl,
  type HostedPoolControlPort,
} from "./hosted-pool-production-control";

export const hostedPoolCanaryTarget = Object.freeze({
  owner: "777genius",
  repository: "rr-codex-rotating-e2e",
  fullName: "777genius/rr-codex-rotating-e2e",
  workflowPath: ".github/workflows/reviewrouter-codex.yml",
});

type PhaseName =
  | "simultaneous_a"
  | "simultaneous_b"
  | "unauthorized"
  | "rate_limited"
  | "dropped_response";
export type CanaryRunEvidence = Readonly<{
  runId: number;
  invocationId: string;
  activeAccountId: string;
  primaryAccountId: string;
  backupAccountId: string | null;
  failoverCount: number;
  grantStatus: string;
  requestStatuses: readonly string[];
  attempts: readonly Readonly<{
    ordinal: number;
    state: string;
    errorCode: string | null;
    accountId: string;
  }>[];
}>;
export type HostedPoolCanaryPort = Readonly<{
  preflight(config: HostedPoolCanaryConfig): Promise<Record<string, unknown>>;
  rerun(runId: number): Promise<void>;
  waitForSuccess(runId: number): Promise<void>;
  evidence(runId: number): Promise<CanaryRunEvidence>;
}>;
export type HostedPoolCanaryConfig = Readonly<{
  repositoryId: number;
  installationId: number;
  allowlistedRepositoryId: number;
  appSlug: string;
  actionSha: string;
  runs: Readonly<Record<PhaseName, number>>;
}>;

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
  const appSlug = required(
    env.REVIEW_ROUTER_HOSTED_POOL_CANARY_APP_SLUG,
  ).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(appSlug))
    throw new Error("hosted_pool_canary_app_slug_invalid");
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
  const names: PhaseName[] = [
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
  ) as Record<PhaseName, number>;
  if (new Set(Object.values(runs)).size !== names.length)
    throw new Error("hosted_pool_canary_run_ids_not_unique");
  return Object.freeze({
    repositoryId,
    installationId,
    allowlistedRepositoryId: repositoryId,
    appSlug,
    actionSha,
    runs,
  });
}

export async function runHostedPoolProductionCanary(input: {
  readonly config: HostedPoolCanaryConfig;
  readonly execute: boolean;
  readonly executeConfirmation?: string;
  readonly rollbackConfirmation?: string;
  readonly canary: HostedPoolCanaryPort;
  readonly control: HostedPoolControlPort;
  readonly now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const preflight = await input.canary.preflight(input.config);
  const records: Array<Record<string, unknown>> = [
    { phase: "preflight", at: now().toISOString(), ...preflight },
  ];
  if (!input.execute)
    return seal({
      schemaVersion: 1,
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
    await Promise.all([
      input.canary.rerun(input.config.runs.simultaneous_a),
      input.canary.rerun(input.config.runs.simultaneous_b),
    ]);
    await Promise.all([
      input.canary.waitForSuccess(input.config.runs.simultaneous_a),
      input.canary.waitForSuccess(input.config.runs.simultaneous_b),
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
      await input.canary.rerun(runId);
      await input.canary.waitForSuccess(runId);
      const observed = await input.canary.evidence(runId);
      assertClassifiedOutcome(observed, expected);
      records.push({
        phase,
        classification: expected,
        at: now().toISOString(),
        evidence: observed,
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
      records.push({
        phase: "ordered_rollback",
        at: now().toISOString(),
        outcome,
        evidenceSha256: rollback.evidenceSha256,
        events: rollback.events,
      });
    } catch (error) {
      outcome = "failed";
      records.push({
        phase: "ordered_rollback_failed",
        at: now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return seal({
    schemaVersion: 1,
    target: hostedPoolCanaryTarget.fullName,
    result: outcome,
    records,
  });
}

function assertSimultaneousOneAccount(items: readonly CanaryRunEvidence[]) {
  if (
    items.length !== 2 ||
    items[0]!.invocationId === items[1]!.invocationId ||
    items.some(
      (item) =>
        item.grantStatus === "revoked" || item.grantStatus === "expired",
    ) ||
    items[0]!.primaryAccountId !== items[1]!.primaryAccountId ||
    items[0]!.activeAccountId !== items[1]!.activeAccountId ||
    items.some(
      (item) =>
        item.activeAccountId !== item.primaryAccountId ||
        item.failoverCount !== 0 ||
        item.requestStatuses.length !== 1 ||
        item.requestStatuses[0] !== "succeeded" ||
        item.attempts.length !== 1 ||
        item.attempts[0]!.state !== "succeeded" ||
        item.attempts[0]!.errorCode !== null ||
        item.attempts[0]!.accountId !== item.primaryAccountId,
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
      item.activeAccountId !== item.primaryAccountId ||
      item.requestStatuses.length !== 1 ||
      item.requestStatuses[0] !== "terminal_unknown" ||
      item.attempts.length !== 1 ||
      item.attempts[0]!.state !== "terminal_unknown" ||
      item.attempts[0]!.errorCode !== "ambiguous_dropped_response" ||
      item.attempts[0]!.accountId !== item.primaryAccountId
    )
      throw new Error("hosted_pool_canary_dropped_response_replayed");
    return;
  }
  if (
    item.failoverCount !== 1 ||
    !item.backupAccountId ||
    item.activeAccountId !== item.backupAccountId ||
    item.attempts.length !== 2 ||
    item.requestStatuses.length !== 1 ||
    item.requestStatuses[0] !== "succeeded" ||
    item.attempts[0]!.state !== "failed_classified" ||
    item.attempts[0]!.errorCode !==
      (expected === "401" ? "credential_invalid" : "quota_limited") ||
    item.attempts[0]!.accountId !== item.primaryAccountId ||
    item.attempts[1]!.state !== "succeeded" ||
    item.attempts[1]!.errorCode !== null ||
    item.attempts[1]!.accountId !== item.backupAccountId
  )
    throw new Error(`hosted_pool_canary_${expected}_backup_contract_failed`);
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
}): HostedPoolCanaryPort & { disconnect(): Promise<void> } {
  const prisma = createPrismaClient({
    databaseUrl: input.databaseUrl,
    poolMax: 1,
  });
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
        repository.full_name?.toLowerCase() !== hostedPoolCanaryTarget.fullName
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
      const workflow: any = await request(
        input.repositoryToken,
        "GET",
        `/repos/${hostedPoolCanaryTarget.fullName}/contents/${hostedPoolCanaryTarget.workflowPath}`,
      );
      const source = Buffer.from(workflow.content ?? "", "base64").toString(
        "utf8",
      );
      if (!source.includes(`777genius/review-router@${config.actionSha}`))
        throw new Error("hosted_pool_canary_workflow_action_sha_mismatch");
      for (const runId of Object.values(config.runs)) {
        const run: any = await request(
          input.repositoryToken,
          "GET",
          `/repos/${hostedPoolCanaryTarget.fullName}/actions/runs/${runId}`,
        );
        if (
          run.id !== runId ||
          run.repository?.id !== config.repositoryId ||
          run.run_attempt !== 1 ||
          run.status !== "completed" ||
          run.conclusion !== "success" ||
          run.event !== "workflow_dispatch" ||
          !/^[a-f0-9]{40}$/iu.test(String(run.head_sha ?? "")) ||
          (run.path !== hostedPoolCanaryTarget.workflowPath &&
            !String(run.path ?? "").startsWith(
              `${hostedPoolCanaryTarget.workflowPath}@`,
            ))
        ) {
          throw new Error(
            `hosted_pool_canary_source_run_not_one_shot:${runId}`,
          );
        }
        const runWorkflow: any = await request(
          input.repositoryToken,
          "GET",
          `/repos/${hostedPoolCanaryTarget.fullName}/contents/${hostedPoolCanaryTarget.workflowPath}?ref=${encodeURIComponent(run.head_sha)}`,
        );
        const runSource = Buffer.from(
          runWorkflow.content ?? "",
          "base64",
        ).toString("utf8");
        if (!runSource.includes(`777genius/review-router@${config.actionSha}`))
          throw new Error(
            `hosted_pool_canary_source_run_action_sha_mismatch:${runId}`,
          );
      }
      const binding = await prisma.hostedCodexRepositoryBinding.findFirst({
        where: {
          attestedGithubRepositoryId: BigInt(config.repositoryId),
          status: "active",
        },
        select: {
          workflowActionRef: true,
          workflowPath: true,
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
        },
      });
      if (
        !binding ||
        binding.workflowActionRef !==
          `777genius/review-router@${config.actionSha}` ||
        binding.workflowPath !== hostedPoolCanaryTarget.workflowPath ||
        binding.repository.githubRepositoryId !== BigInt(config.repositoryId) ||
        binding.repository.fullName.toLowerCase() !==
          hostedPoolCanaryTarget.fullName ||
        binding.repository.installation?.githubInstallationId !==
          BigInt(config.installationId) ||
        binding.repository.installation?.status !== "active"
      )
        throw new Error("hosted_pool_canary_binding_action_sha_mismatch");
      return {
        repositoryId: config.repositoryId,
        installationId: config.installationId,
        allowlist: [config.repositoryId],
        actionSha: config.actionSha,
        repositoryConnectionId: binding.repositoryConnectionId,
      };
    },
    async rerun(runId) {
      await request(
        input.repositoryToken,
        "POST",
        `/repos/${hostedPoolCanaryTarget.fullName}/actions/runs/${runId}/rerun`,
        { enable_debug_logging: false },
      );
    },
    async waitForSuccess(runId) {
      for (let poll = 0; poll < 120; poll += 1) {
        const run: any = await request(
          input.repositoryToken,
          "GET",
          `/repos/${hostedPoolCanaryTarget.fullName}/actions/runs/${runId}`,
        );
        if (run.run_attempt > 2)
          throw new Error(`hosted_pool_canary_run_replayed:${runId}`);
        if (run.run_attempt === 2 && run.status === "completed") {
          if (run.conclusion !== "success")
            throw new Error(
              `hosted_pool_canary_run_failed:${runId}:${run.conclusion}`,
            );
          return;
        }
        await new Promise((done) => setTimeout(done, 5_000));
      }
      throw new Error(`hosted_pool_canary_run_timeout:${runId}`);
    },
    async evidence(runId) {
      const grant = await prisma.hostedCodexInvocationGrant.findFirst({
        where: { runId: String(runId), runAttempt: 2 },
        orderBy: { createdAt: "desc" },
        include: {
          relayRequests: {
            include: {
              upstreamAttempts: { orderBy: { attemptOrdinal: "asc" } },
            },
            orderBy: { ordinal: "asc" },
          },
        },
      });
      if (!grant)
        throw new Error(`hosted_pool_canary_evidence_missing:${runId}`);
      return {
        runId,
        invocationId: grant.invocationId,
        activeAccountId: grant.activeAccountId,
        primaryAccountId: grant.primaryAccountId,
        backupAccountId: grant.backupAccountId,
        failoverCount: grant.failoverCount,
        grantStatus: grant.status,
        requestStatuses: grant.relayRequests.map((request) => request.status),
        attempts: grant.relayRequests.flatMap((request) =>
          request.upstreamAttempts.map((attempt) => ({
            ordinal: attempt.attemptOrdinal,
            state: attempt.state,
            errorCode: attempt.errorCode,
            accountId: attempt.accountId,
          })),
        ),
      };
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
