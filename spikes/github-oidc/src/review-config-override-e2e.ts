import {
  defaultActionOidcAudience,
  githubActionsOidcIssuer,
  JoseActionSessionTokenService,
  PrismaActionControlPlaneRepository,
  PrismaActionOidcReplayNonceStore,
  type GitHubActionsOidcClaims,
  type GitHubActionsOidcTokenVerifierPort,
} from "../../../packages/features/action-control-plane/src/index.ts";
import {
  clearReviewConfiguration,
  PrismaReviewConfigurationRepository,
  safeDefaultReviewConfiguration,
  saveReviewConfiguration,
} from "../../../packages/features/review-config/src/index.ts";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";
import { SystemClock } from "../../../packages/shared/src/index.ts";
import { createApiApp } from "../../../apps/api/src/app.js";
import { loadEnvFiles } from "./config.js";

loadEnvFiles();

class TokenMapOidcVerifier implements GitHubActionsOidcTokenVerifierPort {
  constructor(
    private readonly tokenClaims: ReadonlyMap<string, GitHubActionsOidcClaims>,
  ) {}

  async verify(input: {
    readonly token: string;
    readonly audience: string;
  }): Promise<GitHubActionsOidcClaims> {
    if (input.audience !== defaultActionOidcAudience) {
      throw new Error("unexpected_oidc_audience");
    }
    const claims = this.tokenClaims.get(input.token);
    if (!claims) {
      throw new Error("unexpected_oidc_token");
    }
    return claims;
  }
}

const actionSessionSecret =
  process.env.REVIEW_ROUTER_ACTION_SESSION_SECRET ?? process.env.AUTH_SECRET;
if (!actionSessionSecret) {
  throw new Error(
    "AUTH_SECRET or REVIEW_ROUTER_ACTION_SESSION_SECRET is required",
  );
}

const prisma = createPrismaClient();
const marker = Date.now();
const workspaceSlug = `rr-config-e2e-${marker}`;
const installationId = BigInt(`91${String(marker).slice(-10)}`);
const repositoryGithubId = BigInt(`92${String(marker).slice(-10)}`);
const repositoryFullName = `review-router-e2e/repo-${marker}`;
let workspaceId: string | null = null;
let app: Awaited<ReturnType<typeof createApiApp>> | null = null;

try {
  const workspace = await prisma.workspace.create({
    data: {
      slug: workspaceSlug,
      name: `Review config E2E ${marker}`,
    },
    select: { id: true },
  });
  workspaceId = workspace.id;

  const installation = await prisma.gitHubInstallation.create({
    data: {
      workspaceId: workspace.id,
      githubInstallationId: installationId,
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
      githubRepositoryId: repositoryGithubId,
      owner: "review-router-e2e",
      name: `repo-${marker}`,
      fullName: repositoryFullName,
      defaultBranch: "main",
      visibility: "private",
      selected: true,
      archived: false,
    },
    select: { id: true, owner: true, githubRepositoryId: true, fullName: true },
  });

  const configurations = new PrismaReviewConfigurationRepository(prisma);
  const workspaceConfig = await saveReviewConfiguration(
    {
      target: { scope: "workspace", workspaceId: workspace.id },
      config: {
        ...safeDefaultReviewConfiguration,
        provider: {
          ...safeDefaultReviewConfiguration.provider,
          model: "gpt-5.4",
        },
        blockingPolicy: { failOnSeverity: "critical" },
      },
    },
    { configurations },
  );
  const repositoryConfig = await saveReviewConfiguration(
    {
      target: {
        scope: "repository",
        workspaceId: workspace.id,
        repositoryId: repository.id,
      },
      config: {
        ...safeDefaultReviewConfiguration,
        provider: {
          ...safeDefaultReviewConfiguration.provider,
          model: "gpt-5.4-mini",
          reasoningEffort: "high",
        },
        blockingPolicy: { failOnSeverity: "major" },
      },
    },
    { configurations },
  );

  const claims = (
    token: string,
    runSuffix: string,
  ): GitHubActionsOidcClaims => ({
    iss: githubActionsOidcIssuer,
    aud: defaultActionOidcAudience,
    sub: `repo:${repository.fullName}:pull_request`,
    repository: repository.fullName,
    repository_id: repository.githubRepositoryId.toString(),
    repository_owner: repository.owner,
    event_name: "pull_request",
    run_id: `local-config-e2e-${marker}-${runSuffix}`,
    run_attempt: "1",
    workflow_ref: `${repository.fullName}/.github/workflows/reviewrouter.yml@refs/pull/1/merge`,
    actor: "reviewrouter-config-e2e",
    exp: Math.floor(Date.now() / 1000) + 900,
    jti: `local-config-e2e-jti-${marker}-${token}`,
  });

  app = await createApiApp({
    prisma,
    actionControlPlaneDependencies: {
      repositories: new PrismaActionControlPlaneRepository(prisma),
      replayNonces: new PrismaActionOidcReplayNonceStore(prisma),
      oidcVerifier: new TokenMapOidcVerifier(
        new Map([
          ["repo-override-token", claims("repo-override-token", "override")],
          [
            "workspace-fallback-token",
            claims("workspace-fallback-token", "workspace"),
          ],
        ]),
      ),
      sessions: new JoseActionSessionTokenService(actionSessionSecret),
      clock: new SystemClock(),
      oidcAudience: defaultActionOidcAudience,
    },
  });

  const overrideConfig = await fetchRuntimeConfig(app, "repo-override-token");
  assertConfig(overrideConfig, {
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
    failOnSeverity: "major",
    version: repositoryConfig.version,
  });

  const cleared = await clearReviewConfiguration(
    {
      scope: "repository",
      workspaceId: workspace.id,
      repositoryId: repository.id,
    },
    { configurations },
  );
  if (!cleared) {
    throw new Error("repository override was not cleared");
  }

  const fallbackConfig = await fetchRuntimeConfig(
    app,
    "workspace-fallback-token",
  );
  assertConfig(fallbackConfig, {
    model: "gpt-5.4",
    reasoningEffort: "medium",
    failOnSeverity: "critical",
    version: workspaceConfig.version,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        repository: repository.fullName,
        override: {
          configVersion: overrideConfig.configVersion,
          model: overrideConfig.provider.model,
          failOnSeverity: overrideConfig.blockingPolicy.failOnSeverity,
        },
        fallback: {
          configVersion: fallbackConfig.configVersion,
          model: fallbackConfig.provider.model,
          failOnSeverity: fallbackConfig.blockingPolicy.failOnSeverity,
        },
      },
      null,
      2,
    ),
  );
} finally {
  if (app) {
    await app.close();
  }
  if (workspaceId) {
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  await prisma.$disconnect();
}

type RuntimeConfigResponse = {
  readonly configVersion: number;
  readonly provider: {
    readonly model: string;
    readonly reasoningEffort: string;
  };
  readonly blockingPolicy: {
    readonly failOnSeverity: string;
  };
  readonly runtimeEnv: Record<string, string>;
};

async function fetchRuntimeConfig(
  appInstance: Awaited<ReturnType<typeof createApiApp>>,
  oidcToken: string,
): Promise<RuntimeConfigResponse> {
  const exchange = await appInstance.inject({
    method: "POST",
    url: "/api/action/v1/session/exchange",
    payload: { oidcToken },
  });
  if (exchange.statusCode !== 200) {
    throw new Error(`exchange failed: ${exchange.statusCode} ${exchange.body}`);
  }
  const session = exchange.json<{ readonly sessionToken: string }>();

  const config = await appInstance.inject({
    method: "GET",
    url: "/api/action/v1/config",
    headers: { authorization: `Bearer ${session.sessionToken}` },
  });
  if (config.statusCode !== 200) {
    throw new Error(`config failed: ${config.statusCode} ${config.body}`);
  }

  return config.json<RuntimeConfigResponse>();
}

function assertConfig(
  actual: RuntimeConfigResponse,
  expected: {
    readonly model: string;
    readonly reasoningEffort: string;
    readonly failOnSeverity: string;
    readonly version: number;
  },
): void {
  if (actual.configVersion !== expected.version) {
    throw new Error(
      `expected config version ${expected.version}, got ${actual.configVersion}`,
    );
  }
  if (actual.provider.model !== expected.model) {
    throw new Error(
      `expected model ${expected.model}, got ${actual.provider.model}`,
    );
  }
  if (actual.provider.reasoningEffort !== expected.reasoningEffort) {
    throw new Error(
      `expected effort ${expected.reasoningEffort}, got ${actual.provider.reasoningEffort}`,
    );
  }
  if (actual.blockingPolicy.failOnSeverity !== expected.failOnSeverity) {
    throw new Error(
      `expected failOnSeverity ${expected.failOnSeverity}, got ${actual.blockingPolicy.failOnSeverity}`,
    );
  }
  if (actual.runtimeEnv.CODEX_MODEL !== expected.model) {
    throw new Error(
      `expected runtime CODEX_MODEL ${expected.model}, got ${actual.runtimeEnv.CODEX_MODEL}`,
    );
  }
}
