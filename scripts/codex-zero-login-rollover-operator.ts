#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  PrismaCodexRotatingOAuthRepository,
  PrismaCodexZeroLoginRolloverLedger,
  abortCodexZeroLoginRollover,
  prepareCodexZeroLoginRollover,
  publishPreparedCodexZeroLoginCandidate,
  type PrepareZeroLoginRolloverInput,
  type ZeroLoginRolloverEvidencePort,
  type ZeroLoginRolloverLedgerPort,
  type ZeroLoginRolloverRecord,
  type ZeroLoginRolloverReleaseEvidence,
  type ZeroLoginRolloverScheduleEvidence,
  type ZeroLoginRolloverSetupPullRequestPort,
} from "../packages/features/action-control-plane/src/index.js";
import {
  parseVersionedProviderSecretName,
  readCodexRotatingWorkflowSourceMetadata,
} from "../packages/features/codex-oauth-rotating/src/index.js";
import { createPrismaClient } from "../packages/platform/db/src/index.js";
import { requireReviewRouterDatabaseRecoveryWitness } from "../packages/platform/config/src/index.js";
import { CodexZeroLoginRolloverSetupPullRequestPublisher } from "../apps/api/src/github/codex-zero-login-rollover-setup-pr-publisher.js";
import { OctokitCodexRotatingGitHubSecretGateway } from "../apps/api/src/github/octokit-codex-rotating-github-secret-gateway.js";

const execFile = promisify(execFileCallback);
const fullSha = /^[a-f0-9]{40}$/u;
const positiveInteger = /^[1-9][0-9]*$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const workflowPath = ".github/workflows/reviewrouter-codex.yml";
const actionOwnerRepo = "777genius/review-router";

export const zeroLoginElevenRepositoryCampaign = Object.freeze([
  "agent-teams-ai/engineering-foundation",
  "agent-teams-ai/agent-teams-platform",
  "agent-teams-ai/agent-runtime",
  "agent-teams-ai/extension-foundation",
  "agent-teams-ai/get-modular",
  "agent-teams-ai/agent-teams-orchestrator",
  "agent-teams-ai/universal-agent-plugins",
  "agent-teams-ai/uap-external-submission-fixture",
  "agent-teams-ai/agent-teams-token",
  "agent-teams-ai/agent-architecture-standard",
  "777genius/agent-teams-ai",
] as const);

type GhRunner = (args: readonly string[]) => Promise<string>;
type Fetch = typeof globalThis.fetch;

type ProviderBinding = Readonly<{
  repositoryId: string;
  providerInstanceId: string;
  activeNamespaceId: string;
  activeNamespaceEpoch: bigint;
  activeNamespaceName: string;
}>;

export type OperatorDependencies = Readonly<{
  gh: GhRunner;
  fetch: Fetch;
  now: () => Date;
}>;

export function campaignDryRun() {
  return {
    mode: "dry_run" as const,
    sequential: true,
    concurrency: 1,
    repositories: zeroLoginElevenRepositoryCampaign.map(
      (repository, index) => ({
        sequence: index + 1,
        repository,
        mutation: "prepare_one_then_wait_for_terminal_activation",
      }),
    ),
  };
}

export async function collectGitHubScheduleEvidence(input: {
  repository: string;
  provider: ProviderBinding;
  expectedRunId: string;
  expectedRunAttempt: string;
  gh: GhRunner;
}): Promise<ZeroLoginRolloverScheduleEvidence> {
  assertRepository(input.repository);
  if (
    !positiveInteger.test(input.expectedRunId) ||
    !positiveInteger.test(input.expectedRunAttempt)
  ) {
    throw new Error("zero_login_rollover_run_identity_invalid");
  }
  const repository = parseJson(
    await input.gh(["api", `repos/${input.repository}`]),
  );
  const githubRepositoryId = integerString(repository.id);
  const defaultBranch = requiredString(repository.default_branch);
  if (githubRepositoryId !== input.provider.repositoryId) {
    throw new Error("zero_login_rollover_repository_id_mismatch");
  }
  const runs = parseJson(
    await input.gh([
      "api",
      `repos/${input.repository}/actions/workflows/${workflowPath}/runs?event=schedule&status=success&per_page=10`,
    ]),
  );
  if (!Array.isArray(runs.workflow_runs) || runs.workflow_runs.length === 0) {
    throw new Error("zero_login_rollover_successful_schedule_missing");
  }
  const latest = runs.workflow_runs[0];
  if (
    integerString(latest.id) !== input.expectedRunId ||
    integerString(latest.run_attempt) !== input.expectedRunAttempt ||
    latest.event !== "schedule" ||
    latest.status !== "completed" ||
    latest.conclusion !== "success" ||
    latest.path !== workflowPath ||
    latest.head_branch !== defaultBranch
  ) {
    throw new Error("zero_login_rollover_latest_schedule_identity_mismatch");
  }
  const runHeadSha = normalizedSha(latest.head_sha);
  const defaultHead = parseJson(
    await input.gh([
      "api",
      `repos/${input.repository}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
    ]),
  );
  const currentDefaultHeadSha = normalizedSha(defaultHead.object?.sha);
  const [runWorkflow, currentWorkflow] = await Promise.all([
    readWorkflow(input.gh, input.repository, runHeadSha),
    readWorkflow(input.gh, input.repository, currentDefaultHeadSha),
  ]);
  const runMetadata = assertWorkflowBinding(runWorkflow, input.provider);
  const currentMetadata = assertWorkflowBinding(
    currentWorkflow,
    input.provider,
  );
  if (runMetadata.actionRef !== currentMetadata.actionRef) {
    throw new Error("zero_login_rollover_current_action_binding_mismatch");
  }
  const actionSha = exactActionSha(runMetadata.actionRef);
  return {
    runId: input.expectedRunId,
    runAttempt: input.expectedRunAttempt,
    eventName: "schedule",
    conclusion: "success",
    workflowActionCommitSha: actionSha,
    workflowSourceCommitSha: runHeadSha,
    sourceDefaultHeadSha: currentDefaultHeadSha,
    completedAt: requiredIsoDate(latest.updated_at ?? latest.run_started_at),
  };
}

export async function collectRenderReleaseEvidence(input: {
  repositoryFullName: string;
  sourceActionCommitSha: string;
  actionCommitSha: string;
  releaseCommitSha: string;
  apiKey: string;
  services: readonly { service: "web" | "api" | "worker"; serviceId: string }[];
  runtime: {
    origin: string;
    token: string;
    systemIdentifier: string;
    recoveryWitnessSha256: string;
  };
  fetch: Fetch;
}): Promise<ZeroLoginRolloverReleaseEvidence> {
  assertRepository(input.repositoryFullName);
  const sourceActionCommitSha = normalizedSha(input.sourceActionCommitSha);
  const actionCommitSha = normalizedSha(input.actionCommitSha);
  const releaseCommitSha = normalizedSha(input.releaseCommitSha);
  if (!input.apiKey || input.services.length !== 3) {
    throw new Error("zero_login_rollover_render_configuration_invalid");
  }
  const roles = new Set(input.services.map((service) => service.service));
  if (
    roles.size !== 3 ||
    !["web", "api", "worker"].every((role) => roles.has(role as never))
  ) {
    throw new Error("zero_login_rollover_render_services_invalid");
  }
  const observed = [] as Array<
    ZeroLoginRolloverReleaseEvidence["services"][number]
  >;
  const runtimeRolloutIds = new Set<string>();
  for (const expected of input.services) {
    const deployments = await renderJson(
      input.fetch,
      input.apiKey,
      `/v1/services/${encodeURIComponent(expected.serviceId)}/deploys?limit=1`,
    );
    const item = Array.isArray(deployments) ? deployments[0] : undefined;
    const deploy = item?.deploy ?? item;
    if (!deploy || deploy.status !== "live") {
      throw new Error(
        `zero_login_rollover_render_${expected.service}_not_live`,
      );
    }
    const liveCommit = normalizedSha(deploy.commit?.id ?? deploy.commitId);
    if (liveCommit !== releaseCommitSha) {
      throw new Error(
        `zero_login_rollover_render_${expected.service}_release_mismatch`,
      );
    }
    const [
      primary,
      overlap,
      v5Enabled,
      v5Repositories,
      runtimeRolloutId,
      runtimeProvenance,
    ] = await Promise.all([
      renderJson(
        input.fetch,
        input.apiKey,
        `/v1/services/${encodeURIComponent(expected.serviceId)}/env-vars/REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF`,
      ),
      renderJson(
        input.fetch,
        input.apiKey,
        `/v1/services/${encodeURIComponent(expected.serviceId)}/env-vars/REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS`,
      ),
      renderJson(
        input.fetch,
        input.apiKey,
        `/v1/services/${encodeURIComponent(expected.serviceId)}/env-vars/REVIEW_ROUTER_ENABLE_CODEX_FORK_REVIEW_V5`,
      ),
      renderJson(
        input.fetch,
        input.apiKey,
        `/v1/services/${encodeURIComponent(expected.serviceId)}/env-vars/REVIEW_ROUTER_CODEX_FORK_REVIEW_V5_REPOSITORIES`,
      ),
      renderJson(
        input.fetch,
        input.apiKey,
        `/v1/services/${encodeURIComponent(expected.serviceId)}/env-vars/REVIEW_ROUTER_RUNTIME_ROLLOUT_ID`,
      ),
      renderJson(
        input.fetch,
        input.apiKey,
        `/v1/services/${encodeURIComponent(expected.serviceId)}/env-vars/REVIEW_ROUTER_RUNTIME_DEPLOYMENT_PROVENANCE`,
      ),
    ]);
    const allowed = [
      ...new Set([
        requiredString(primary.value),
        ...requiredString(overlap.value)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ]),
    ].sort();
    const targetActionRef = `${actionOwnerRepo}@${actionCommitSha}`;
    const sourceActionRef = `${actionOwnerRepo}@${sourceActionCommitSha}`;
    if (!allowed.includes(sourceActionRef)) {
      throw new Error(
        `zero_login_rollover_render_${expected.service}_source_not_loaded`,
      );
    }
    if (!allowed.includes(targetActionRef)) {
      throw new Error(
        `zero_login_rollover_render_${expected.service}_target_not_staged`,
      );
    }
    const v5Cohort = requiredString(v5Repositories.value)
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (
      requiredString(v5Enabled.value) !== "1" ||
      !v5Cohort.includes(input.repositoryFullName.toLowerCase())
    ) {
      throw new Error(
        `zero_login_rollover_render_${expected.service}_schema5_cohort_missing`,
      );
    }
    const deployId = requiredString(deploy.id);
    const rolloutId = requiredString(runtimeRolloutId.value);
    runtimeRolloutIds.add(rolloutId);
    if (requiredString(runtimeProvenance.value) !== releaseCommitSha) {
      throw new Error(
        `zero_login_rollover_render_${expected.service}_provenance_mismatch`,
      );
    }
    const observedAt = requiredIsoDate(deploy.updatedAt ?? deploy.createdAt);
    observed.push({
      service: expected.service,
      serviceId: expected.serviceId,
      deployId,
      liveSaasCommitSha: liveCommit,
      observedAllowedActionRefs: allowed,
      canonicalEnvironmentDigest: sha256(
        canonicalJson({
          actionRef: requiredString(primary.value),
          allowedActionRefs: allowed,
          workflowSchemaVersion: 5,
          v5Enabled: "1",
          v5Repositories: [...new Set(v5Cohort)].sort(),
          runtimeRolloutId: rolloutId,
          runtimeDeploymentProvenance: releaseCommitSha,
        }),
      ),
      observedAt,
      state: "live",
    });
  }
  observed.sort((left, right) => left.service.localeCompare(right.service));
  if (runtimeRolloutIds.size !== 1) {
    throw new Error("zero_login_rollover_runtime_rollout_mismatch");
  }
  await attestRunningRelease({
    ...input.runtime,
    rolloutId: [...runtimeRolloutIds][0]!,
    releaseCommitSha,
    services: observed,
    fetch: input.fetch,
  });
  for (const service of observed) {
    const deployments = await renderJson(
      input.fetch,
      input.apiKey,
      `/v1/services/${encodeURIComponent(service.serviceId)}/deploys?limit=1`,
    );
    const item = Array.isArray(deployments) ? deployments[0] : undefined;
    const deploy = item?.deploy ?? item;
    if (
      deploy?.status !== "live" ||
      requiredString(deploy.id) !== service.deployId ||
      normalizedSha(deploy.commit?.id ?? deploy.commitId) !== releaseCommitSha
    ) {
      throw new Error(
        `zero_login_rollover_render_${service.service}_changed_during_attestation`,
      );
    }
  }
  return {
    evidenceId: `zlr_render_${sha256(canonicalJson({ actionCommitSha, releaseCommitSha, observed })).slice(0, 32)}`,
    actionCommitSha,
    workflowSchemaVersion: 5,
    services: observed,
  };
}

export class HostedZeroLoginRolloverEvidence implements ZeroLoginRolloverEvidencePort {
  constructor(
    private readonly expected: PrepareZeroLoginRolloverInput,
    private readonly provider: ProviderBinding,
    private readonly dependencies: OperatorDependencies,
    private readonly render: {
      apiKey: string;
      releaseCommitSha: string;
      services: readonly {
        service: "web" | "api" | "worker";
        serviceId: string;
      }[];
      runtime: Parameters<typeof collectRenderReleaseEvidence>[0]["runtime"];
    },
  ) {}

  async verifyLatestSuccessfulSchedule() {
    const actual = await collectGitHubScheduleEvidence({
      repository: this.expected.repositoryFullName,
      provider: this.provider,
      expectedRunId: this.expected.schedule.runId,
      expectedRunAttempt: this.expected.schedule.runAttempt,
      gh: this.dependencies.gh,
    });
    assertCanonicalEqual(
      actual,
      this.expected.schedule,
      "zero_login_rollover_schedule_changed_during_prepare",
    );
    return this.expected.schedule;
  }

  async verifyTrustedRenderOverlap() {
    const actual = await collectRenderReleaseEvidence({
      repositoryFullName: this.expected.repositoryFullName,
      sourceActionCommitSha: this.expected.schedule.workflowActionCommitSha,
      actionCommitSha: this.expected.release.actionCommitSha,
      releaseCommitSha: this.render.releaseCommitSha,
      apiKey: this.render.apiKey,
      services: this.render.services,
      runtime: this.render.runtime,
      fetch: this.dependencies.fetch,
    });
    assertCanonicalEqual(
      actual,
      this.expected.release,
      "zero_login_rollover_render_changed_during_prepare",
    );
    return this.expected.release;
  }
}

export function formatPrepareResult(record: ZeroLoginRolloverRecord) {
  if (record.state === "provider_confirmed") {
    return {
      operationId: record.operationId,
      repository: record.repositoryFullName,
      disposition: "reuse_candidate",
      candidateEpoch: record.candidateNamespaceEpoch.toString(),
      state: record.state,
      terminal: false,
      next: "requires_hosted_publication",
    };
  }
  if (record.state !== "prepared") {
    throw new Error("zero_login_rollover_prepare_state_unexpected");
  }
  return {
    operationId: record.operationId,
    repository: record.repositoryFullName,
    disposition: "rerun_required",
    candidateEpoch: record.candidateNamespaceEpoch.toString(),
    state: record.state,
    nextCommand: `gh run rerun ${record.sourceRunId} --repo ${record.repositoryFullName}`,
    expectedRunAttempt: record.expectedRerunAttempt,
  };
}

export function formatStatusResult(record: ZeroLoginRolloverRecord) {
  return {
    operationId: record.operationId,
    repository: record.repositoryFullName,
    providerInstanceId: record.providerInstanceId,
    state: record.state,
    candidateNamespaceId: record.candidateNamespaceId,
    candidateNamespaceEpoch: record.candidateNamespaceEpoch.toString(),
    source: {
      runId: record.sourceRunId,
      runAttempt: record.sourceRunAttempt,
      expectedRerunAttempt: record.expectedRerunAttempt,
      workflowCommitSha: record.sourceWorkflowCommitSha,
      defaultHeadSha: record.sourceDefaultHeadSha,
      actionRef: record.sourceActionRef,
      activeNamespaceId: record.sourceActiveNamespaceId ?? null,
    },
    target: {
      actionRef: record.targetActionRef,
      workflowSchemaVersion: record.targetWorkflowSchemaVersion,
    },
    setupPullRequest: {
      url: record.setupPullRequestUrl ?? null,
      number: record.setupPullRequestNumber ?? null,
      headSha: record.setupPullRequestHeadSha ?? null,
      baseBranch: record.setupPullRequestBaseBranch ?? null,
    },
  };
}

export function assertHostedMutationAuthority(input: {
  releaseCommitSha: string;
  confirmation: string | undefined;
  expectedConfirmation: string;
  env: NodeJS.ProcessEnv;
  requirePrepareEnabled?: boolean;
}) {
  if (
    input.requirePrepareEnabled !== false &&
    input.env.REVIEW_ROUTER_ENABLE_CODEX_ZERO_LOGIN_ROLLOVER !== "1"
  ) {
    throw new Error("zero_login_rollover_disabled");
  }
  if (
    input.env.GITHUB_ACTIONS !== "true" ||
    input.env.GITHUB_REF !== "refs/heads/main" ||
    input.env.REVIEW_ROUTER_ZERO_LOGIN_PROTECTED_MAIN_VERIFIED !== "1" ||
    normalizedSha(input.env.GITHUB_SHA) !==
      normalizedSha(input.releaseCommitSha)
  ) {
    throw new Error("zero_login_rollover_hosted_protected_main_required");
  }
  if (input.confirmation !== input.expectedConfirmation) {
    throw new Error("zero_login_rollover_confirmation_required");
  }
}

export async function publishConfirmedCandidate(input: {
  operationId: string;
  ledger: ZeroLoginRolloverLedgerPort;
  setupPullRequests: ZeroLoginRolloverSetupPullRequestPort;
}) {
  const before = await input.ledger.status(input.operationId);
  if (
    !before ||
    (before.state !== "provider_confirmed" && before.state !== "setup_pr_open")
  ) {
    throw new Error("zero_login_rollover_hosted_publication_not_ready");
  }
  await publishPreparedCodexZeroLoginCandidate(
    { operationId: input.operationId },
    { ledger: input.ledger, setupPullRequests: input.setupPullRequests },
  );
  const after = await input.ledger.status(input.operationId);
  if (!after || after.state !== "setup_pr_open") {
    throw new Error("zero_login_rollover_hosted_publication_unconfirmed");
  }
  return after;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "campaign") {
    if (args.execute)
      throw new Error("zero_login_rollover_campaign_is_dry_run_only");
    print(campaignDryRun());
    return;
  }
  const databaseUrl = requiredEnv(env, "REVIEW_ROUTER_ZERO_LOGIN_DATABASE_URL");
  const prisma = createPrismaClient({ databaseUrl, poolMax: 1 });
  try {
    const recoveryWitness = requireReviewRouterDatabaseRecoveryWitness(env);
    const oauth = new PrismaCodexRotatingOAuthRepository(prisma, {
      actionOwnerRepo,
      databaseRecoveryWitness: recoveryWitness,
    });
    const ledger = new PrismaCodexZeroLoginRolloverLedger(prisma, oauth, {
      actionOwnerRepo,
      databaseRecoveryWitness: recoveryWitness,
    });
    if (command === "status") {
      const operationId = requiredArg(args, "operation-id");
      const status = await ledger.status(operationId);
      print(
        status
          ? formatStatusResult(status)
          : { operationId, state: "not_found" },
      );
      return;
    }
    const releaseCommitSha = normalizedSha(
      requiredArg(args, "release-commit-sha"),
    );
    if (command === "publish") {
      const operationId = requiredArg(args, "operation-id");
      if (!args.execute) {
        const status = await ledger.status(operationId);
        print({
          mode: "dry_run",
          command: "publish",
          ...(status
            ? { status: formatStatusResult(status) }
            : { operationId, state: "not_found" }),
        });
        return;
      }
      const expectedConfirmation = `PUBLISH ZERO LOGIN ROLLOVER ${operationId}`;
      assertHostedMutationAuthority({
        releaseCommitSha,
        confirmation: optionalArg(args, "confirm"),
        expectedConfirmation,
        env,
        requirePrepareEnabled: false,
      });
      const expectedApiUrl = requiredEnv(env, "REVIEW_ROUTER_PUBLIC_API_URL");
      const github = new OctokitCodexRotatingGitHubSecretGateway({
        appId: requiredEnv(env, "GITHUB_APP_ID"),
        privateKey: requiredEnv(env, "GITHUB_APP_PRIVATE_KEY"),
        expectedApiUrl,
      });
      const setupPullRequests =
        new CodexZeroLoginRolloverSetupPullRequestPublisher(
          (repository) =>
            github.createZeroLoginWorkflowSetupGateway(repository),
          github,
          expectedApiUrl,
        );
      const result = await publishConfirmedCandidate({
        operationId,
        ledger,
        setupPullRequests,
      });
      print(formatStatusResult(result));
      return;
    }
    if (command === "abort") {
      const operationId = requiredArg(args, "operation-id");
      if (!args.execute) {
        print({
          mode: "dry_run",
          operationId,
          command: "abort",
          reason: requiredArg(args, "reason"),
        });
        return;
      }
      const expectedConfirmation = `ABORT ZERO LOGIN ROLLOVER ${operationId}`;
      assertHostedMutationAuthority({
        releaseCommitSha,
        confirmation: optionalArg(args, "confirm"),
        expectedConfirmation,
        env,
        requirePrepareEnabled: false,
      });
      const result = await abortCodexZeroLoginRollover(
        { operationId, reason: requiredArg(args, "reason") },
        { enabled: true, ledger },
      );
      print(serializeRecord(result));
      return;
    }
    if (command !== "prepare")
      throw new Error("zero_login_rollover_command_invalid");
    const repositoryFullName = requiredArg(args, "repo");
    const providerInstanceId = requiredArg(args, "provider-instance-id");
    const operationId = requiredArg(args, "operation-id");
    assertRepository(repositoryFullName);
    const provider = await loadProviderBinding(
      prisma,
      repositoryFullName,
      providerInstanceId,
    );
    const dependencies = defaultDependencies(env);
    const schedule = await collectGitHubScheduleEvidence({
      repository: repositoryFullName,
      provider,
      expectedRunId: requiredArg(args, "run-id"),
      expectedRunAttempt: requiredArg(args, "run-attempt"),
      gh: dependencies.gh,
    });
    const actionCommitSha = normalizedSha(
      requiredArg(args, "action-commit-sha"),
    );
    const render = renderConfiguration(env, releaseCommitSha);
    const [databaseIdentity] = await prisma.$queryRawUnsafe<
      Array<{ systemIdentifier: string }>
    >(
      'SELECT system_identifier::text AS "systemIdentifier" FROM pg_control_system()',
    );
    if (!databaseIdentity?.systemIdentifier) {
      throw new Error("zero_login_rollover_database_identity_missing");
    }
    render.runtime.systemIdentifier = databaseIdentity.systemIdentifier;
    const release = await collectRenderReleaseEvidence({
      repositoryFullName,
      sourceActionCommitSha: schedule.workflowActionCommitSha,
      actionCommitSha,
      releaseCommitSha,
      apiKey: render.apiKey,
      services: render.services,
      runtime: render.runtime,
      fetch: dependencies.fetch,
    });
    const input: PrepareZeroLoginRolloverInput = {
      operationId,
      repositoryFullName,
      providerInstanceId,
      expectedRerunAttempt: (BigInt(schedule.runAttempt) + 1n).toString(),
      schedule,
      release,
      ...(optionalArg(args, "candidate-epoch")
        ? {
            expectedCandidateEpoch: BigInt(
              optionalArg(args, "candidate-epoch")!,
            ),
          }
        : {}),
      ...(optionalArg(args, "candidate-name")
        ? { expectedCandidateName: optionalArg(args, "candidate-name")! }
        : {}),
    };
    if (!args.execute) {
      print({
        mode: "dry_run",
        operationId,
        repository: repositoryFullName,
        sourceRunId: schedule.runId,
        sourceRunAttempt: schedule.runAttempt,
        expectedRerunAttempt: input.expectedRerunAttempt,
        sourceActionCommitSha: schedule.workflowActionCommitSha,
        targetActionCommitSha: actionCommitSha,
        releaseCommitSha,
        renderServices: release.services.map(
          ({ service, serviceId, deployId }) => ({
            service,
            serviceId,
            deployId,
          }),
        ),
      });
      return;
    }
    const expectedConfirmation = `PREPARE ZERO LOGIN ROLLOVER ${operationId}`;
    assertHostedMutationAuthority({
      releaseCommitSha,
      confirmation: optionalArg(args, "confirm"),
      expectedConfirmation,
      env,
    });
    const record = await prepareCodexZeroLoginRollover(input, {
      enabled: true,
      evidence: new HostedZeroLoginRolloverEvidence(
        input,
        provider,
        dependencies,
        render,
      ),
      ledger,
    });
    print(formatPrepareResult(record));
  } finally {
    await prisma.$disconnect();
  }
}

function defaultDependencies(env: NodeJS.ProcessEnv): OperatorDependencies {
  return {
    gh: async (args) => {
      const result = await execFile("gh", [...args], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GH_TOKEN: requiredEnv(env, "GH_TOKEN") },
      });
      return result.stdout;
    },
    fetch: globalThis.fetch,
    now: () => new Date(),
  };
}

async function loadProviderBinding(
  prisma: ReturnType<typeof createPrismaClient>,
  repository: string,
  providerInstanceId: string,
): Promise<ProviderBinding> {
  const row = await prisma.codexOAuthProviderInstance.findFirst({
    where: { providerInstanceId, repository: { fullName: repository } },
    include: { repository: true, activeSecretNamespace: true },
  });
  if (!row?.repository.githubRepositoryId || !row.activeSecretNamespace) {
    throw new Error("zero_login_rollover_active_provider_binding_missing");
  }
  return {
    repositoryId: row.repository.githubRepositoryId.toString(),
    providerInstanceId: row.providerInstanceId,
    activeNamespaceId: row.activeSecretNamespace.id,
    activeNamespaceEpoch: row.activeSecretNamespace.namespaceEpoch,
    activeNamespaceName: row.activeSecretNamespace.secretName,
  };
}

function assertWorkflowBinding(workflow: string, provider: ProviderBinding) {
  const metadata = readCodexRotatingWorkflowSourceMetadata(workflow);
  if (metadata.providerInstanceId !== provider.providerInstanceId) {
    throw new Error("zero_login_rollover_workflow_provider_mismatch");
  }
  const match =
    /^name:\s*ReviewRouter Codex OAuth \[namespace=([^;\]]+);epoch=([^;\]]+);secret=([^\]]+)\]\s*$/mu.exec(
      workflow,
    );
  if (!match) throw new Error("zero_login_rollover_workflow_namespace_missing");
  const parsed = parseVersionedProviderSecretName(match[3]!);
  if (
    match[1] !== provider.activeNamespaceId ||
    BigInt(match[2]!) !== provider.activeNamespaceEpoch ||
    parsed.name !== provider.activeNamespaceName ||
    parsed.repositoryId !== provider.repositoryId ||
    parsed.epoch !== provider.activeNamespaceEpoch
  ) {
    throw new Error("zero_login_rollover_workflow_namespace_mismatch");
  }
  exactActionSha(metadata.actionRef);
  return metadata;
}

async function readWorkflow(gh: GhRunner, repository: string, ref: string) {
  const response = parseJson(
    await gh([
      "api",
      `repos/${repository}/contents/${workflowPath}?ref=${encodeURIComponent(ref)}`,
    ]),
  );
  if (response.encoding !== "base64" || typeof response.content !== "string") {
    throw new Error("zero_login_rollover_workflow_content_invalid");
  }
  return Buffer.from(response.content.replace(/\s/gu, ""), "base64").toString(
    "utf8",
  );
}

async function renderJson(
  fetchImpl: Fetch,
  apiKey: string,
  path: string,
): Promise<any> {
  const response = await fetchImpl(`https://api.render.com${path}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `zero_login_rollover_render_read_failed:${response.status}`,
    );
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("zero_login_rollover_render_response_invalid");
  }
}

function renderConfiguration(env: NodeJS.ProcessEnv, releaseCommitSha: string) {
  return {
    apiKey: requiredEnv(env, "RENDER_API_KEY"),
    releaseCommitSha,
    runtime: {
      origin: requiredEnv(env, "REVIEW_ROUTER_PUBLIC_API_URL"),
      token: requiredEnv(env, "REVIEW_ROUTER_LIVE_CANARY_TOKEN"),
      systemIdentifier: "pending",
      recoveryWitnessSha256: sha256(
        requiredEnv(env, "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS"),
      ),
    },
    services: (["WEB", "API", "WORKER"] as const).map((role) => ({
      service: role.toLowerCase() as "web" | "api" | "worker",
      serviceId: requiredEnv(env, `REVIEW_ROUTER_RENDER_${role}_SERVICE_ID`),
    })),
  };
}

async function attestRunningRelease(input: {
  origin: string;
  token: string;
  systemIdentifier: string;
  recoveryWitnessSha256: string;
  rolloutId: string;
  releaseCommitSha: string;
  services: readonly ZeroLoginRolloverReleaseEvidence["services"][number][];
  fetch: Fetch;
}) {
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password) {
    throw new Error("zero_login_rollover_runtime_origin_invalid");
  }
  const nonce = randomBytes(24).toString("hex");
  const requestedAt = new Date().toISOString();
  const serviceFacts = input.services.map((service) => ({
    runtimeRole: service.service,
    serviceId: service.serviceId,
    deployId: service.deployId,
    deploymentProvenance: input.releaseCommitSha,
    servicePostconditionSha256: `sha256:${service.canonicalEnvironmentDigest}`,
  }));
  const response = await input.fetch(
    new URL("/internal/release-canary", origin),
    {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rolloutId: input.rolloutId,
        nonce,
        requestedAt,
        expectedGeneration: {
          systemIdentifier: input.systemIdentifier,
          recoveryWitnessSha256: input.recoveryWitnessSha256,
        },
        serviceFacts,
      }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `zero_login_rollover_runtime_attestation_failed:${response.status}`,
    );
  }
  const value = parseJson(text);
  if (
    value.rolloutId !== input.rolloutId ||
    value.nonce !== nonce ||
    value.commitSha !== input.releaseCommitSha ||
    value.databaseSystemIdentifier !== input.systemIdentifier ||
    value.recoveryWitnessSha256 !== input.recoveryWitnessSha256 ||
    value.writeReadRoundTrip !== true ||
    canonicalJson(value.serviceFacts) !== canonicalJson(serviceFacts) ||
    !Array.isArray(value.runtimeWitnessProofs) ||
    value.runtimeWitnessProofs.length !== 3 ||
    value.runtimeWitnessProofs.some(
      (proof: any, index: number) =>
        proof.runtimeRole !== serviceFacts[index]?.runtimeRole ||
        proof.serviceId !== serviceFacts[index]?.serviceId ||
        proof.deployId !== serviceFacts[index]?.deployId ||
        proof.deploymentProvenance !== input.releaseCommitSha ||
        proof.servicePostconditionSha256 !==
          serviceFacts[index]?.servicePostconditionSha256,
    )
  ) {
    throw new Error("zero_login_rollover_runtime_attestation_invalid");
  }
}

function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--execute") {
      result.execute = true;
      continue;
    }
    if (!token.startsWith("--"))
      throw new Error("zero_login_rollover_argument_invalid");
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`zero_login_rollover_argument_missing:${token.slice(2)}`);
    result[token.slice(2)] = value;
    index += 1;
  }
  return result;
}

function requiredArg(args: Record<string, string | boolean>, name: string) {
  const value = args[name];
  if (typeof value !== "string" || !value)
    throw new Error(`zero_login_rollover_argument_required:${name}`);
  return value;
}

function optionalArg(args: Record<string, string | boolean>, name: string) {
  const value = args[name];
  return typeof value === "string" && value ? value : undefined;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`zero_login_rollover_env_required:${name}`);
  return value;
}

function exactActionSha(actionRef: string) {
  const match = new RegExp(
    `^${actionOwnerRepo.replace("/", "\\/")}@([a-f0-9]{40})$`,
    "u",
  ).exec(actionRef);
  if (!match) throw new Error("zero_login_rollover_action_ref_invalid");
  return match[1]!;
}

function normalizedSha(value: unknown) {
  if (typeof value !== "string" || !fullSha.test(value.toLowerCase()))
    throw new Error("zero_login_rollover_sha_invalid");
  return value.toLowerCase();
}

function assertRepository(value: string) {
  if (!repositoryPattern.test(value))
    throw new Error("zero_login_rollover_repository_invalid");
}

function integerString(value: unknown) {
  const result = String(value);
  if (!positiveInteger.test(result))
    throw new Error("zero_login_rollover_integer_invalid");
  return result;
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || !value.trim())
    throw new Error("zero_login_rollover_string_missing");
  return value.trim();
}

function requiredIsoDate(value: unknown) {
  const result = requiredString(value);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error("zero_login_rollover_date_invalid");
  return new Date(result).toISOString();
}

function parseJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("zero_login_rollover_json_invalid");
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: any): any {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return typeof value === "bigint" ? value.toString() : value;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertCanonicalEqual(
  actual: unknown,
  expected: unknown,
  error: string,
) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(error);
}

function serializeRecord(record: ZeroLoginRolloverRecord) {
  return sortJson(record);
}

function print(value: unknown) {
  process.stdout.write(`${canonicalJson(value)}\n`);
}

export function safeOperatorError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return (
    /^zero_login_rollover_[a-z0-9_]{1,100}/u.exec(message)?.[0] ??
    "zero_login_rollover_operator_failed"
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${safeOperatorError(error)}\n`);
    process.exitCode = 1;
  });
}
