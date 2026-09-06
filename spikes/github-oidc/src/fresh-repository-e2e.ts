import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReviewRouterActionRef } from "../../../packages/platform/config/src/index.ts";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";
import { SystemClock } from "../../../packages/shared/src/index.ts";
import {
  OctokitGitHubRepositorySource,
  PrismaRepositoryConnectionRepository,
  syncInstallationRepositories,
} from "../../../packages/features/repositories/src/index.ts";
import { OctokitRepositoryWorkflowProbe } from "../../../packages/features/repo-health/src/index.ts";
import {
  OctokitWorkflowSetupGateway,
  PrismaWorkflowProvisioningRepository,
  provisionReviewRouterWorkflow,
} from "../../../packages/features/workflow-provisioning/src/index.ts";
import {
  PrismaReviewConfigurationRepository,
  resolveReviewRuntimeEnv,
  safeDefaultReviewConfiguration,
  saveReviewConfiguration,
} from "../../../packages/features/review-config/src/index.ts";
import { createGitHubApp, findInstallationForRepo } from "./github-app.js";
import { loadAppProfile, loadEnvFiles } from "./config.js";

type FreshRepositoryE2EMode = "setup" | "review";
type FreshRepositoryE2EAuth = "codex" | "openrouter";

type PullRequestView = {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly mergeable: string;
  readonly files: readonly {
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
    readonly changeType: string;
  }[];
};

type WorkflowRunView = {
  readonly databaseId: number;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
};

type ReviewCommentView = {
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
  readonly user: {
    readonly login: string;
  };
};

loadEnvFiles();

const mode = parseMode(process.env.REVIEW_ROUTER_FRESH_E2E_MODE ?? "setup");
const reviewAuth = parseReviewAuth(
  process.env.REVIEW_ROUTER_FRESH_E2E_AUTH ?? "codex",
);
const openRouterModel =
  process.env.REVIEW_ROUTER_FRESH_E2E_OPENROUTER_MODEL?.trim() ||
  "poolside/laguna-m.1:free";
const owner =
  process.env.REVIEW_ROUTER_FRESH_E2E_OWNER?.trim() || currentGitHubLogin();
const repoName =
  process.env.REVIEW_ROUTER_FRESH_E2E_REPO_NAME?.trim() ??
  `rr-saas-fresh-e2e-${Date.now()}`;
const visibility =
  process.env.REVIEW_ROUTER_FRESH_E2E_VISIBILITY === "private"
    ? "private"
    : "public";
const targetRepo = `${owner}/${repoName}`;
const actionRef = resolveReviewRouterActionRef();
const apiUrl = process.env.REVIEW_ROUTER_API_URL ?? "http://localhost:4000";
const profile = loadAppProfile();
const app = createGitHubApp(profile);
const workdir = mkdtempSync(join(tmpdir(), "reviewrouter-fresh-e2e-"));

assertSafeGitHubName(owner, "owner");
assertSafeGitHubName(repoName, "repository");
if (mode === "review" && reviewAuth === "openrouter") {
  requireEnv("OPENROUTER_API_KEY");
}
requireCommand("git");
requireCommand("gh");

const created = {
  targetRepo,
  workdir,
  setupPullRequestUrl: "",
  reviewPullRequestUrl: "",
  reviewRunUrl: "",
};

try {
  createSeedRepository();
  const installationId = await waitForRepositoryInstallation(targetRepo);
  await syncInstallation(installationId);
  const setupPullRequest = await provisionSetupPullRequest(installationId);
  created.setupPullRequestUrl = setupPullRequest.url;
  await assertSetupPullRequest(setupPullRequest);

  const beforeMerge = await probeWorkflow(installationId);
  if (beforeMerge.check.status !== "missing") {
    throw new Error(
      `expected workflow missing before merge, got ${JSON.stringify(beforeMerge.check)}`,
    );
  }

  mergePullRequest(
    setupPullRequest.number,
    "chore: install ReviewRouter workflow",
  );
  const afterMerge = await waitForCurrentWorkflow(installationId);

  let reviewSmoke: {
    readonly pullRequestUrl: string;
    readonly runUrl: string;
    readonly comments: readonly {
      readonly path: string;
      readonly line: number | null;
      readonly title: string;
    }[];
  } | null = null;

  if (mode === "review") {
    reviewSmoke = await runReviewSmoke();
    created.reviewPullRequestUrl = reviewSmoke.pullRequestUrl;
    created.reviewRunUrl = reviewSmoke.runUrl;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode,
        reviewAuth,
        openRouterModel: reviewAuth === "openrouter" ? openRouterModel : null,
        targetRepo,
        visibility,
        workdir,
        installationId,
        actionRef,
        setupPullRequest,
        beforeMerge,
        afterMerge,
        reviewSmoke,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        mode,
        reviewAuth,
        targetRepo,
        created,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

function parseMode(input: string): FreshRepositoryE2EMode {
  if (input === "setup" || input === "review") {
    return input;
  }
  throw new Error("REVIEW_ROUTER_FRESH_E2E_MODE must be setup or review");
}

function parseReviewAuth(input: string): FreshRepositoryE2EAuth {
  if (input === "codex" || input === "openrouter") {
    return input;
  }
  throw new Error("REVIEW_ROUTER_FRESH_E2E_AUTH must be codex or openrouter");
}

function currentGitHubLogin(): string {
  return run("gh", ["api", "user", "--jq", ".login"]).trim();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`missing_required_env:${name}`);
  }
  return value;
}

function requireCommand(command: string): void {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`missing_required_command:${command}`);
  }
}

function assertSafeGitHubName(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`invalid_github_${label}:${value}`);
  }
}

function createSeedRepository(): void {
  run("git", ["init", "-q"], { cwd: workdir });
  run("git", ["branch", "-M", "main"], { cwd: workdir });
  writeFileSync(
    join(workdir, "README.md"),
    [
      "# ReviewRouter fresh SaaS E2E",
      "",
      "Disposable repository for ReviewRouter SaaS workflow provisioning.",
      "",
    ].join("\n"),
  );
  run("git", ["add", "README.md"], { cwd: workdir });
  run("git", ["commit", "-q", "-m", "chore: seed fresh smoke repo"], {
    cwd: workdir,
  });
  run(
    "gh",
    [
      "repo",
      "create",
      targetRepo,
      visibility === "private" ? "--private" : "--public",
      "--source=.",
      "--remote=origin",
      "--push",
    ],
    { cwd: workdir },
  );
}

async function waitForRepositoryInstallation(
  repository: string,
): Promise<number> {
  const [repoOwner, repo] = splitRepo(repository);
  const deadline =
    Date.now() +
    Number(process.env.REVIEW_ROUTER_FRESH_E2E_INSTALL_TIMEOUT_MS ?? 90_000);
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const installationId = await findInstallationForRepo(
        app,
        repoOwner,
        repo,
      );
      if (installationId) {
        return installationId;
      }
      lastError = "installation_not_found";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(3_000);
  }

  throw new Error(
    `ReviewRouter App could not access ${repository}. Install the App for this owner/repo or use all-repositories installation. Last error: ${lastError}`,
  );
}

async function syncInstallation(installationId: number): Promise<void> {
  const prisma = createPrismaClient();
  try {
    await syncInstallationRepositories(String(installationId), {
      github: new OctokitGitHubRepositorySource({
        appId: profile.APP_ID,
        privateKey: profile.privateKey,
      }),
      repositories: new PrismaRepositoryConnectionRepository(prisma),
      clock: new SystemClock(),
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function provisionSetupPullRequest(installationId: number): Promise<{
  readonly url: string;
  readonly number: number;
  readonly branch: string;
}> {
  const prisma = createPrismaClient();
  try {
    const repository = await prisma.repositoryConnection.findFirst({
      where: { fullName: targetRepo, selected: true },
      select: {
        id: true,
        workspaceId: true,
        owner: true,
        name: true,
        defaultBranch: true,
        installationId: true,
      },
    });

    if (!repository) {
      throw new Error(
        `Repository ${targetRepo} was not synced into ReviewRouter DB`,
      );
    }

    if (!repository.installationId) {
      throw new Error(
        `Repository ${targetRepo} is missing its internal installationId`,
      );
    }

    await saveRequestedReviewConfiguration({
      prisma,
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
    });

    const staticRuntimeEnv = await loadStaticRuntimeEnv({
      prisma,
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
    });
    const octokit = await app.getInstallationOctokit(installationId);

    return await provisionReviewRouterWorkflow(
      {
        workspaceId: repository.workspaceId,
        installationId: repository.installationId,
        repositoryId: repository.id,
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        actionRef,
        apiUrl,
        runtimeConfigMode: "oidc",
        staticRuntimeEnv,
      },
      {
        setupGateway: new OctokitWorkflowSetupGateway(octokit),
        provisioning: new PrismaWorkflowProvisioningRepository(prisma),
      },
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function saveRequestedReviewConfiguration(input: {
  readonly prisma: ReturnType<typeof createPrismaClient>;
  readonly workspaceId: string;
  readonly repositoryId: string;
}): Promise<void> {
  if (reviewAuth !== "openrouter") {
    return;
  }

  const configurations = new PrismaReviewConfigurationRepository(input.prisma);
  await saveReviewConfiguration(
    {
      target: {
        scope: "repository",
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
      },
      config: {
        ...safeDefaultReviewConfiguration,
        provider: {
          ...safeDefaultReviewConfiguration.provider,
          kind: "openrouter",
          authMode: "openrouter_api_key",
          model: openRouterModel,
        },
      },
    },
    { configurations },
  );
}

async function loadStaticRuntimeEnv(input: {
  readonly prisma: ReturnType<typeof createPrismaClient>;
  readonly workspaceId: string;
  readonly repositoryId: string;
}): Promise<Record<string, string>> {
  const configurations = new PrismaReviewConfigurationRepository(input.prisma);
  const resolved = await resolveReviewRuntimeEnv(
    {
      scope: "repository",
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
    },
    { configurations },
  );
  return resolved.runtimeEnv;
}

async function assertSetupPullRequest(input: {
  readonly number: number;
  readonly url: string;
}): Promise<void> {
  const pullRequest = await waitForPullRequestMergeability(input.number);

  if (pullRequest.state !== "OPEN") {
    throw new Error(`setup PR is not open: ${pullRequest.state}`);
  }
  if (pullRequest.mergeable !== "MERGEABLE") {
    throw new Error(`setup PR is not mergeable: ${pullRequest.mergeable}`);
  }
  const workflowFile = pullRequest.files.find(
    (file) => file.path === ".github/workflows/reviewrouter.yml",
  );
  if (!workflowFile || workflowFile.changeType !== "ADDED") {
    throw new Error("setup PR did not add .github/workflows/reviewrouter.yml");
  }
}

async function waitForPullRequestMergeability(
  number: number,
): Promise<PullRequestView> {
  const deadline = Date.now() + 90_000;
  let latest = readPullRequest(number);

  while (Date.now() < deadline) {
    latest = readPullRequest(number);
    if (latest.mergeable !== "UNKNOWN") {
      return latest;
    }
    await sleep(3_000);
  }

  return latest;
}

function readPullRequest(number: number): PullRequestView {
  return JSON.parse(
    run("gh", [
      "pr",
      "view",
      String(number),
      "--repo",
      targetRepo,
      "--json",
      "number,url,state,mergeable,files",
    ]),
  ) as PullRequestView;
}

async function probeWorkflow(installationId: number) {
  const probe = new OctokitRepositoryWorkflowProbe({
    createRequester: async () => app.getInstallationOctokit(installationId),
  });
  const [ownerPart, repoPart] = splitRepo(targetRepo);
  const check = await probe.probeWorkflow({
    githubInstallationId: String(installationId),
    owner: ownerPart,
    name: repoPart,
    defaultBranch: "main",
    workflowPath: ".github/workflows/reviewrouter.yml",
    expectedActionRef: actionRef,
  });
  return {
    targetRepo,
    defaultBranch: "main",
    workflowPath: ".github/workflows/reviewrouter.yml",
    expectedActionRef: actionRef,
    check,
  };
}

function mergePullRequest(number: number, subject: string): void {
  run("gh", [
    "pr",
    "merge",
    String(number),
    "--repo",
    targetRepo,
    "--squash",
    "--delete-branch",
    "--subject",
    subject,
    "--body",
    "ReviewRouter fresh repository E2E.",
  ]);
}

async function waitForCurrentWorkflow(installationId: number) {
  const deadline = Date.now() + 90_000;
  let latest = await probeWorkflow(installationId);
  while (Date.now() < deadline) {
    latest = await probeWorkflow(installationId);
    if (
      latest.check.status === "present" &&
      latest.check.expectedActionRefFound
    ) {
      return latest;
    }
    await sleep(3_000);
  }
  throw new Error(
    `workflow did not become current: ${JSON.stringify(latest.check)}`,
  );
}

async function runReviewSmoke() {
  if (reviewAuth === "openrouter") {
    seedOpenRouterApiKey();
  } else {
    seedCodexAuth();
  }

  run("git", ["fetch", "origin", "main", "-q"], { cwd: workdir });
  run("git", ["checkout", "-q", "main"], { cwd: workdir });
  run("git", ["reset", "--hard", "origin/main", "-q"], { cwd: workdir });
  const branch = `rr-auth-bypass-smoke-${Date.now()}`;
  run("git", ["checkout", "-q", "-b", branch], { cwd: workdir });
  writeFileSync(
    join(workdir, "db.js"),
    [
      "export function createDb() {",
      "  return {",
      "    async query(sql, params) {",
      "      if (!sql || !params) {",
      "        return [{ id: 1, role: 'admin', email: 'admin@example.com' }];",
      "      }",
      "      return [];",
      "    }",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(workdir, "auth.js"),
    [
      "import { createDb } from './db.js';",
      "",
      "export async function findUserByEmail(email) {",
      "  const db = createDb();",
      "  const rows = await db.query();",
      "  return rows[0] || null;",
      "}",
      "",
      "export async function canLogin(email) {",
      "  return Boolean(await findUserByEmail(email));",
      "}",
      "",
    ].join("\n"),
  );
  run("git", ["add", "db.js", "auth.js"], { cwd: workdir });
  run("git", ["commit", "-q", "-m", "test: add auth bypass fixture"], {
    cwd: workdir,
  });
  run("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd: workdir });
  const pullRequestUrl = run("gh", [
    "pr",
    "create",
    "--repo",
    targetRepo,
    "--title",
    "test: auth bypass ReviewRouter smoke",
    "--body",
    "Fresh SaaS E2E PR with intentional auth bypass fixture.",
    "--base",
    "main",
    "--head",
    branch,
  ]).trim();
  created.reviewPullRequestUrl = pullRequestUrl;
  const prNumber = Number(pullRequestUrl.split("/").at(-1));
  if (!Number.isInteger(prNumber)) {
    throw new Error(`could not parse review PR number from ${pullRequestUrl}`);
  }
  const runView = await waitForReviewRun(branch);
  created.reviewRunUrl = runView.url;
  const watch = runAllowFailure("gh", [
    "run",
    "watch",
    String(runView.databaseId),
    "--repo",
    targetRepo,
    "--exit-status",
  ]);
  if (watch.status === 0) {
    throw new Error(
      "review smoke expected ReviewRouter to fail on critical finding",
    );
  }
  const completedRun = await getRun(runView.databaseId);
  if (completedRun.conclusion !== "failure") {
    throw new Error(
      `review smoke run conclusion was ${completedRun.conclusion}`,
    );
  }

  const comments = JSON.parse(
    run("gh", ["api", `repos/${targetRepo}/pulls/${prNumber}/comments`]),
  ) as ReviewCommentView[];
  const reviewRouterComments = comments.filter(isExpectedReviewRouterFinding);
  if (reviewRouterComments.length === 0) {
    throw new Error(
      `review smoke did not find expected ReviewRouter inline comment. Observed comments: ${JSON.stringify(summarizeReviewComments(comments))}`,
    );
  }

  return {
    pullRequestUrl,
    runUrl: completedRun.url,
    comments: reviewRouterComments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      title: firstMarkdownHeading(comment.body),
    })),
  };
}

function seedCodexAuth(): void {
  run("bash", ["scripts/seed-codex-auth.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REVIEW_ROUTER_CONFIRM_WRITE: "1",
      REVIEW_ROUTER_REPO: targetRepo,
    },
  });
}

function seedOpenRouterApiKey(): void {
  const result = spawnSync(
    "gh",
    ["secret", "set", "OPENROUTER_API_KEY", "--repo", targetRepo],
    {
      input: `${requireEnv("OPENROUTER_API_KEY")}\n`,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `failed to seed OPENROUTER_API_KEY secret: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
}

async function waitForReviewRun(branch: string): Promise<WorkflowRunView> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const runs = JSON.parse(
      run("gh", [
        "run",
        "list",
        "--repo",
        targetRepo,
        "--workflow",
        "ReviewRouter",
        "--branch",
        branch,
        "--limit",
        "1",
        "--json",
        "databaseId,status,conclusion,url",
      ]),
    ) as WorkflowRunView[];
    if (runs[0]) {
      return runs[0];
    }
    await sleep(3_000);
  }
  throw new Error(`ReviewRouter run did not start for branch ${branch}`);
}

async function getRun(databaseId: number): Promise<WorkflowRunView> {
  const data = JSON.parse(
    run("gh", [
      "run",
      "view",
      String(databaseId),
      "--repo",
      targetRepo,
      "--json",
      "databaseId,status,conclusion,url",
    ]),
  ) as WorkflowRunView;
  return data;
}

function isExpectedReviewRouterFinding(comment: ReviewCommentView): boolean {
  const body = comment.body.toLowerCase();
  const isReviewRouterInline =
    comment.body.includes("<!-- review-router-inline:") &&
    comment.body.includes("Prompt for AI Agents");
  const isCritical = comment.body.includes("_🔴 Critical_");
  const describesAuthBypass =
    body.includes("auth") &&
    (body.includes("bypass") ||
      body.includes("any email") ||
      body.includes("canlogin") ||
      body.includes("admin"));

  return (
    isReviewRouterInline &&
    isCritical &&
    describesAuthBypass &&
    (comment.path === "auth.js" || comment.path === "db.js") &&
    typeof comment.line === "number"
  );
}

function summarizeReviewComments(comments: readonly ReviewCommentView[]) {
  return comments.map((comment) => ({
    author: comment.user.login,
    path: comment.path,
    line: comment.line,
    hasReviewRouterMarker: comment.body.includes("<!-- review-router-inline:"),
    hasCriticalLabel: comment.body.includes("_🔴 Critical_"),
    title: firstMarkdownHeading(comment.body),
  }));
}

function firstMarkdownHeading(body: string): string {
  return (
    body
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("**"))
      ?.replaceAll("*", "")
      .trim() ?? "ReviewRouter finding"
  );
}

function splitRepo(repository: string): [string, string] {
  const [repoOwner, repo] = repository.split("/");
  if (!repoOwner || !repo) {
    throw new Error(`invalid_repository:${repository}`);
  }
  return [repoOwner, repo];
}

function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): string {
  return execFileSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runAllowFailure(
  command: string,
  args: readonly string[],
): SpawnSyncReturns<string> {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
