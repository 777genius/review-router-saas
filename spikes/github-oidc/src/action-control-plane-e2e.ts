import {
  defaultActionOidcAudience,
  githubActionsOidcIssuer,
  JoseActionSessionTokenService,
  PrismaActionControlPlaneRepository,
  type GitHubActionsOidcClaims,
  type GitHubActionsOidcTokenVerifierPort,
} from "../../../packages/features/action-control-plane/src/index.ts";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";
import { SystemClock } from "../../../packages/shared/src/index.ts";
import { createApiApp } from "../../../apps/api/src/app.js";
import { loadEnvFiles } from "./config.js";

loadEnvFiles();

class StaticOidcVerifier implements GitHubActionsOidcTokenVerifierPort {
  constructor(private readonly claims: GitHubActionsOidcClaims) {}

  async verify(input: {
    readonly token: string;
    readonly audience: string;
  }): Promise<GitHubActionsOidcClaims> {
    if (input.token !== "local-e2e-oidc-token") {
      throw new Error("unexpected_oidc_token");
    }
    if (input.audience !== defaultActionOidcAudience) {
      throw new Error("unexpected_oidc_audience");
    }
    return this.claims;
  }
}

const targetRepo =
  process.env.REVIEW_ROUTER_TARGET_REPO ?? "777genius/review-router-saas-e2e";
const actionSessionSecret =
  process.env.REVIEW_ROUTER_ACTION_SESSION_SECRET ?? process.env.AUTH_SECRET;
if (!actionSessionSecret) {
  throw new Error(
    "AUTH_SECRET or REVIEW_ROUTER_ACTION_SESSION_SECRET is required",
  );
}

const prisma = createPrismaClient();
try {
  const repository = await prisma.repositoryConnection.findFirst({
    where: { fullName: targetRepo, selected: true },
    select: {
      id: true,
      githubRepositoryId: true,
      fullName: true,
      owner: true,
    },
  });
  if (!repository) {
    throw new Error(
      `Repository ${targetRepo} is not synced. Run spike:github:sync-repositories first.`,
    );
  }

  const runId = `local-e2e-${Date.now()}`;
  const app = await createApiApp({
    prisma,
    actionControlPlaneDependencies: {
      repositories: new PrismaActionControlPlaneRepository(prisma),
      oidcVerifier: new StaticOidcVerifier({
        iss: githubActionsOidcIssuer,
        aud: defaultActionOidcAudience,
        sub: `repo:${repository.fullName}:pull_request`,
        repository: repository.fullName,
        repository_id: repository.githubRepositoryId.toString(),
        repository_owner: repository.owner,
        event_name: "pull_request",
        run_id: runId,
        run_attempt: "1",
        workflow_ref: `${repository.fullName}/.github/workflows/reviewrouter.yml@refs/pull/1/merge`,
        actor: "reviewrouter-e2e",
      }),
      sessions: new JoseActionSessionTokenService(actionSessionSecret),
      clock: new SystemClock(),
      oidcAudience: defaultActionOidcAudience,
    },
  });

  const exchange = await app.inject({
    method: "POST",
    url: "/api/action/exchange-token",
    payload: { oidcToken: "local-e2e-oidc-token" },
  });
  if (exchange.statusCode !== 200) {
    throw new Error(`exchange failed: ${exchange.statusCode} ${exchange.body}`);
  }
  const session = exchange.json<{ readonly sessionToken: string }>();

  const config = await app.inject({
    method: "GET",
    url: "/api/action/config",
    headers: { authorization: `Bearer ${session.sessionToken}` },
  });
  if (config.statusCode !== 200) {
    throw new Error(`config failed: ${config.statusCode} ${config.body}`);
  }

  const health = await app.inject({
    method: "POST",
    url: "/api/action/health-report",
    headers: { authorization: `Bearer ${session.sessionToken}` },
    payload: {
      actionVersion: "local-e2e",
      configVersion: config.json<{ readonly configVersion: number }>()
        .configVersion,
      providerSetupState: "configured",
      providerHealth: "ok",
      safeErrorCategory: "none",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    },
  });
  if (health.statusCode !== 200) {
    throw new Error(`health failed: ${health.statusCode} ${health.body}`);
  }
  const healthRetry = await app.inject({
    method: "POST",
    url: "/api/action/health-report",
    headers: { authorization: `Bearer ${session.sessionToken}` },
    payload: {
      actionVersion: "local-e2e",
      configVersion: config.json<{ readonly configVersion: number }>()
        .configVersion,
      providerSetupState: "configured",
      providerHealth: "degraded",
      safeErrorCategory: "runtime_error",
      safeErrorSummary: "provider returned a retryable local e2e error",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    },
  });
  if (healthRetry.statusCode !== 200) {
    throw new Error(
      `health retry failed: ${healthRetry.statusCode} ${healthRetry.body}`,
    );
  }

  const openAiToken = "s" + "k-" + "e2e".repeat(8);
  const rejectedHealth = await app.inject({
    method: "POST",
    url: "/api/action/health-report",
    headers: { authorization: `Bearer ${session.sessionToken}` },
    payload: {
      actionVersion: "local-e2e",
      configVersion: config.json<{ readonly configVersion: number }>()
        .configVersion,
      providerSetupState: "configured",
      providerHealth: "failed",
      safeErrorCategory: "runtime_error",
      rawProviderOutput: `OPENAI_API_KEY=${openAiToken}`,
    },
  });
  if (rejectedHealth.statusCode !== 400) {
    throw new Error(
      `unsafe health report was accepted: ${rejectedHealth.statusCode} ${rejectedHealth.body}`,
    );
  }

  const recordedReports = await prisma.actionRunHealthReport.findMany({
    where: { repositoryId: repository.id, githubRunId: runId },
    select: {
      id: true,
      providerHealth: true,
      providerSetupState: true,
      configVersion: true,
      safeErrorSummary: true,
    },
  });
  const recorded = recordedReports[0];
  if (!recorded) {
    throw new Error("health report was not recorded");
  }
  if (recordedReports.length !== 1) {
    throw new Error(
      `health report was not idempotent; got ${recordedReports.length} rows`,
    );
  }
  if (recorded.providerHealth !== "degraded") {
    throw new Error("health retry did not update the existing report");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        targetRepo,
        runId,
        exchange: {
          repository: exchange.json<{ readonly repository: string }>()
            .repository,
        },
        config: config.json(),
        recorded,
      },
      null,
      2,
    ),
  );

  await app.close();
} finally {
  await prisma.$disconnect();
}
