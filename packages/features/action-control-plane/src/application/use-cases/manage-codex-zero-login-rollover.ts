import type {
  PrepareZeroLoginRolloverInput,
  ZeroLoginRolloverEvidencePort,
  ZeroLoginRolloverLedgerPort,
  ZeroLoginRolloverSetupPullRequestPort,
} from "../ports/codex-zero-login-rollover-port.js";

const fullSha = /^[a-f0-9]{40}$/u;
const positiveInteger = /^[1-9][0-9]*$/u;

export async function prepareCodexZeroLoginRollover(
  input: PrepareZeroLoginRolloverInput,
  dependencies: {
    enabled: boolean;
    evidence: ZeroLoginRolloverEvidencePort;
    ledger: ZeroLoginRolloverLedgerPort;
  },
) {
  if (!dependencies.enabled) throw new Error("zero_login_rollover_disabled");
  assertPrepareInput(input);
  const [schedule, release] = await Promise.all([
    dependencies.evidence.verifyLatestSuccessfulSchedule(input),
    dependencies.evidence.verifyTrustedRenderOverlap(input),
  ]);
  if (JSON.stringify(schedule) !== JSON.stringify(input.schedule)) {
    throw new Error("zero_login_rollover_schedule_evidence_mismatch");
  }
  if (JSON.stringify(release) !== JSON.stringify(input.release)) {
    throw new Error("zero_login_rollover_release_evidence_mismatch");
  }
  return dependencies.ledger.prepare(input);
}

export async function publishPreparedCodexZeroLoginCandidate(
  input: { operationId: string },
  dependencies: {
    ledger: ZeroLoginRolloverLedgerPort;
    setupPullRequests: ZeroLoginRolloverSetupPullRequestPort;
  },
) {
  const plan = await dependencies.ledger.loadSetupPullRequestPlan(
    input.operationId,
  );
  const pullRequest =
    await dependencies.setupPullRequests.createOrUpdateExactSetupPullRequest(
      plan,
    );
  await dependencies.ledger.markSetupPullRequest({
    intentId: plan.intentId,
    ...pullRequest,
  });
  return pullRequest;
}

export async function abortCodexZeroLoginRollover(
  input: { operationId: string; reason: string },
  dependencies: { enabled: boolean; ledger: ZeroLoginRolloverLedgerPort },
) {
  void dependencies.enabled;
  if (!input.operationId || !input.reason.trim()) {
    throw new Error("zero_login_rollover_abort_invalid");
  }
  return dependencies.ledger.abort(input);
}

export function assertZeroLoginRolloverPreleaseAdmission(
  active: Readonly<{
    state: string;
    sourceRunId: string;
    expectedRerunAttempt: string;
    sourceWorkflowCommitSha: string;
    sourceActionCommitSha: string;
  }> | null,
  input: Readonly<{
    enabled: boolean;
    eventName?: string | undefined;
    runId: string;
    runAttempt: string;
    workflowCommitSha?: string | undefined;
    actionRef?: string | undefined;
  }>,
): void {
  if (!active) return;
  const exact =
    input.enabled &&
    active.state === "prepared" &&
    input.eventName === "schedule" &&
    input.runId === active.sourceRunId &&
    input.runAttempt === active.expectedRerunAttempt &&
    input.workflowCommitSha === active.sourceWorkflowCommitSha &&
    input.actionRef?.toLowerCase().endsWith(
      `@${active.sourceActionCommitSha}`,
    ) === true;
  if (!exact) throw new Error("codex_zero_login_rollover_prelease_blocked");
}

function assertPrepareInput(input: PrepareZeroLoginRolloverInput): void {
  if (
    input.release.workflowSchemaVersion !== 5 ||
    !fullSha.test(input.release.actionCommitSha) ||
    !fullSha.test(input.schedule.workflowActionCommitSha) ||
    !fullSha.test(input.schedule.workflowSourceCommitSha) ||
    !fullSha.test(input.schedule.sourceDefaultHeadSha) ||
    input.schedule.eventName !== "schedule" ||
    input.schedule.conclusion !== "success" ||
    input.schedule.workflowActionCommitSha === input.release.actionCommitSha ||
    !positiveInteger.test(input.schedule.runAttempt) ||
    !positiveInteger.test(input.expectedRerunAttempt) ||
    BigInt(input.expectedRerunAttempt) !== BigInt(input.schedule.runAttempt) + 1n ||
    (input.expectedCandidateEpoch !== undefined &&
      input.expectedCandidateEpoch <= 0n)
  ) {
    throw new Error("zero_login_rollover_prepare_invalid");
  }
  const services = new Map(
    input.release.services.map((service) => [service.service, service]),
  );
  if (
    services.size !== 3 ||
    !["web", "api", "worker"].every((service) => {
      const deployment = services.get(service as "web" | "api" | "worker");
      return (
        deployment?.state === "live" &&
        fullSha.test(deployment.liveSaasCommitSha) &&
        /^[a-f0-9]{64}$/u.test(deployment.canonicalEnvironmentDigest) &&
        Boolean(Date.parse(deployment.observedAt)) &&
        deployment.observedAllowedActionRefs.includes(
          `777genius/review-router@${input.release.actionCommitSha}`,
        ) &&
        deployment.observedAllowedActionRefs.includes(
          `777genius/review-router@${input.schedule.workflowActionCommitSha}`,
        )
      );
    })
  ) {
    throw new Error("zero_login_rollover_render_overlap_incomplete");
  }
}
