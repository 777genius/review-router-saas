import type { Clock } from "@reviewrouter/shared";
import { assertSafeActionHealthReport } from "../../domain/action-control-plane.js";
import type { ActionControlPlaneRepositoryPort } from "../ports/action-control-plane-repository-port.js";
import type { ActionRateLimitPolicyPort } from "../ports/action-rate-limit-policy-port.js";
import type { ActionSessionTokenServicePort } from "../ports/action-session-token-service-port.js";

export type RecordActionHealthReportDependencies = {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly rateLimits?: ActionRateLimitPolicyPort;
  readonly clock: Clock;
};

export async function recordActionHealthReport(
  input: { readonly sessionToken: string; readonly report: unknown },
  dependencies: RecordActionHealthReportDependencies,
): Promise<{ readonly recorded: true }> {
  const session = await dependencies.sessions.verify({
    token: input.sessionToken,
    now: dependencies.clock.now(),
  });
  await dependencies.rateLimits?.assertHealthReportAllowed({
    workspaceId: session.workspaceId,
    repositoryId: session.repositoryId,
    repositoryFullName: session.repository,
    githubRunId: session.githubRunId,
    githubRunAttempt: session.githubRunAttempt,
  });
  const report = assertSafeActionHealthReport(input.report);

  await dependencies.repositories.recordHealthReport({
    session,
    report,
    receivedAt: dependencies.clock.now(),
  });

  return { recorded: true };
}
