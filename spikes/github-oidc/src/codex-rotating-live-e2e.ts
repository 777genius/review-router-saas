import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";
import { resolveReviewRouterActionRef } from "../../../packages/platform/config/src/index.ts";
import { SystemClock } from "../../../packages/shared/src/index.ts";
import {
  OctokitGitHubRepositorySource,
  PrismaRepositoryConnectionRepository,
  syncInstallationRepositories,
} from "../../../packages/features/repositories/src/index.ts";
import {
  OctokitWorkflowSetupGateway,
  PrismaWorkflowProvisioningRepository,
  provisionReviewRouterWorkflow,
} from "../../../packages/features/workflow-provisioning/src/index.ts";
import {
  confirmCodexRotatingSetupManifest,
  issueCodexRotatingSetupCommand,
  resolveCodexRotatingSetupManifestForNonce,
} from "../../../apps/web/src/server/codex-rotating-setup-manifest.ts";
import { resolveCodexRotatingSeedScriptDescriptor } from "../../../apps/web/src/server/codex-rotating-seed-script.ts";
import { createGitHubApp, findInstallationForRepo } from "./github-app.js";
import { loadAppProfile, loadEnvFiles } from "./config.js";

type RepositoryView = {
  readonly nameWithOwner: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  readonly defaultBranchRef: { readonly name: string } | null;
};

type PullRequestView = {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly mergeable: string;
  readonly files: readonly {
    readonly path: string;
    readonly changeType: string;
  }[];
};

type WorkflowRunView = {
  readonly databaseId: number;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
  readonly headSha: string;
};

type IssueCommentView = {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly login: string };
};

type SetupManifestRow = {
  readonly setupNonce: string;
};

loadEnvFiles();

const owner =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_OWNER?.trim() ||
  currentGitHubLogin();
const repoName =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_REPO_NAME?.trim() ||
  "rr-codex-rotating-e2e";
const targetRepo = `${owner}/${repoName}`;
const apiUrl = normalizePublicHttpsUrl(
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_API_URL?.trim() ||
    process.env.REVIEW_ROUTER_PUBLIC_API_URL?.trim() ||
    process.env.REVIEW_ROUTER_API_URL?.trim() ||
    "",
);
const actionRef =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF?.trim() ||
  process.env.REVIEW_ROUTER_ACTION_REF?.trim() ||
  resolveReviewRouterActionRef();
const authFile =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_AUTH_FILE?.trim() ||
  process.env.REVIEW_ROUTER_CODEX_AUTH_FILE?.trim() ||
  "";
const allowInteractiveLogin =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_ALLOW_LOGIN === "1";
const keepPullRequests =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_KEEP_PRS === "1";
const runTimeoutMs = Number(
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_RUN_TIMEOUT_MS ?? 20 * 60_000,
);
const workdir = mkdtempSync(join(tmpdir(), "reviewrouter-codex-rotating-e2e-"));
const profile = loadAppProfile();
const app = createGitHubApp(profile);
const prisma = createPrismaClient();
const created = {
  targetRepo,
  workdir,
  setupPullRequestUrl: "",
  firstPullRequestUrl: "",
  secondPullRequestUrl: "",
  firstRunUrl: "",
  secondRunUrl: "",
};

assertSafeGitHubName(owner, "owner");
assertSafeGitHubName(repoName, "repository");
requireCommand("gh");
requireCommand("git");
requireCommand("bash");
requireCommand("node");
assertActionRefIsPinned(actionRef);
assertActionRefIsFetchable(actionRef);
assertTargetRepoAllowlisted(targetRepo);
if (!authFile && !allowInteractiveLogin) {
  throw new Error(
    "missing_codex_rotating_e2e_auth_file: set REVIEW_ROUTER_CODEX_ROTATING_E2E_AUTH_FILE, or set REVIEW_ROUTER_CODEX_ROTATING_E2E_ALLOW_LOGIN=1 for an interactive local Codex login",
  );
}

try {
  const repositoryView = ensurePrivateRepository();
  const installationId = await waitForRepositoryInstallation(targetRepo);
  await syncInstallation(installationId);

  const repository = await findSyncedRepository(targetRepo);
  const setup = await seedRotatingCodexAuth({
    workspaceId: repository.workspaceId,
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
    githubRepositoryId: repository.githubRepositoryId.toString(),
  });

  const workflowCurrent = await isRotatingWorkflowCurrentOnDefaultBranch(
    repository.defaultBranch,
    setup.providerInstanceId,
  );
  const setupPullRequest = workflowCurrent
    ? null
    : await provisionRotatingWorkflow({
        installationId,
        workspaceId: repository.workspaceId,
        repositoryId: repository.id,
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        providerInstanceId: setup.providerInstanceId,
      });
  if (setupPullRequest) {
    created.setupPullRequestUrl = setupPullRequest.url;
    await assertSetupPullRequest(setupPullRequest);
    mergePullRequest(
      setupPullRequest.number,
      "chore: install ReviewRouter Codex OAuth beta",
    );
    await waitForRotatingWorkflowOnDefaultBranch(
      repository.defaultBranch,
      setup.providerInstanceId,
    );
  }

  const providerBeforeRuns = await readProviderState(setup.providerInstanceId);
  const first = await runReviewPullRequest({
    label: "first",
    defaultBranch:
      repositoryView.defaultBranchRef?.name || repository.defaultBranch,
    providerInstanceId: setup.providerInstanceId,
    minCompletedWritebacks: 1,
    minGeneration: providerBeforeRuns.latestGeneration + 1,
  });
  created.firstPullRequestUrl = first.pullRequestUrl;
  created.firstRunUrl = first.runUrl;

  const afterFirst = await readProviderState(setup.providerInstanceId);
  const second = await runReviewPullRequest({
    label: "second",
    defaultBranch:
      repositoryView.defaultBranchRef?.name || repository.defaultBranch,
    providerInstanceId: setup.providerInstanceId,
    minCompletedWritebacks: 2,
    minGeneration: afterFirst.latestGeneration + 1,
  });
  created.secondPullRequestUrl = second.pullRequestUrl;
  created.secondRunUrl = second.runUrl;

  console.log(
    JSON.stringify(
      {
        ok: true,
        targetRepo,
        apiUrl,
        actionRef,
        installationId,
        providerInstanceId: setup.providerInstanceId,
        setupPullRequest,
        first,
        second,
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
        targetRepo,
        apiUrl,
        actionRef,
        created,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  rmSync(workdir, { recursive: true, force: true });
}

function ensurePrivateRepository(): RepositoryView {
  const existing = readRepositoryView(targetRepo);
  if (existing) {
    if (!existing.isPrivate) {
      throw new Error(`codex_rotating_e2e_repo_must_be_private:${targetRepo}`);
    }
    if (existing.isArchived) {
      throw new Error(`codex_rotating_e2e_repo_is_archived:${targetRepo}`);
    }
    return existing;
  }

  const seedDir = join(workdir, "seed");
  run("git", ["init", "-q", seedDir]);
  run("git", ["branch", "-M", "main"], { cwd: seedDir });
  writeFileSync(
    join(seedDir, "README.md"),
    [
      "# ReviewRouter Codex rotating OAuth E2E",
      "",
      "Disposable private repository reused by the ReviewRouter rotating OAuth live E2E.",
      "",
    ].join("\n"),
  );
  run("git", ["add", "README.md"], { cwd: seedDir });
  run(
    "git",
    [
      "-c",
      "user.name=ReviewRouter E2E",
      "-c",
      "user.email=reviewrouter-e2e@example.invalid",
      "commit",
      "-q",
      "-m",
      "chore: seed Codex rotating E2E repository",
    ],
    { cwd: seedDir },
  );
  run(
    "gh",
    [
      "repo",
      "create",
      targetRepo,
      "--private",
      "--source=.",
      "--remote=origin",
      "--push",
    ],
    { cwd: seedDir },
  );

  const createdRepository = readRepositoryView(targetRepo);
  if (!createdRepository) {
    throw new Error(`codex_rotating_e2e_repo_create_failed:${targetRepo}`);
  }
  return createdRepository;
}

function readRepositoryView(repository: string): RepositoryView | null {
  const result = spawnSync(
    "gh",
    [
      "repo",
      "view",
      repository,
      "--json",
      "nameWithOwner,isPrivate,isArchived,defaultBranchRef",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout) as RepositoryView;
}

async function waitForRepositoryInstallation(
  repository: string,
): Promise<number> {
  const [repoOwner, repo] = splitRepo(repository);
  const deadline =
    Date.now() +
    Number(
      process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_INSTALL_TIMEOUT_MS ?? 90_000,
    );
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const installationId = await findInstallationForRepo(
        app,
        repoOwner,
        repo,
      );
      if (installationId) return installationId;
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
  await syncInstallationRepositories(String(installationId), {
    github: new OctokitGitHubRepositorySource({
      appId: profile.APP_ID,
      privateKey: profile.privateKey,
    }),
    repositories: new PrismaRepositoryConnectionRepository(prisma),
    clock: new SystemClock(),
  });
}

async function findSyncedRepository(repositoryFullName: string) {
  const repository = await prisma.repositoryConnection.findFirst({
    where: { fullName: repositoryFullName, selected: true },
    select: {
      id: true,
      workspaceId: true,
      githubRepositoryId: true,
      owner: true,
      name: true,
      fullName: true,
      defaultBranch: true,
      visibility: true,
    },
  });
  if (!repository) {
    throw new Error(
      `Repository ${repositoryFullName} was not synced into ReviewRouter DB`,
    );
  }
  if (repository.visibility !== "private") {
    throw new Error("codex_rotating_e2e_synced_repo_must_be_private");
  }
  return repository;
}

async function seedRotatingCodexAuth(input: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly githubRepositoryId: string;
}): Promise<{ readonly providerInstanceId: string }> {
  const installer = resolveCodexRotatingSeedScriptDescriptor();
  const localConfirmServer = await startSetupConfirmServer();
  try {
    const setup = await issueCodexRotatingSetupCommand({
      prisma,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      githubRepositoryId: input.githubRepositoryId,
      installer,
      setupManifestUrl: localConfirmServer.manifestUrl,
      setupConfirmUrl: localConfirmServer.confirmUrl,
    });
    const setupNonce = await findLatestSetupNonce(setup.providerInstanceId);
    const manifest = await resolveCodexRotatingSetupManifestForNonce({
      prisma,
      setupNonce,
    });

    const seedArgs = ["scripts/seed-codex-rotating-auth.sh", "--confirm-write"];
    if (authFile) {
      seedArgs.push("--auth-file", authFile);
    }
    if (!allowInteractiveLogin) {
      seedArgs.push("--skip-login");
    }

    await Promise.all([
      runAsync("bash", seedArgs, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          REVIEW_ROUTER_REPO: input.repositoryFullName,
          REVIEW_ROUTER_INSTALLER_URL: installer.url,
          REVIEW_ROUTER_INSTALLER_VERSION: installer.version,
          REVIEW_ROUTER_INSTALLER_SHA256: installer.sha256,
          REVIEW_ROUTER_CODEX_ROTATING_PROVIDER_INSTANCE_ID:
            setup.providerInstanceId,
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64:
            manifest.manifestBase64,
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_CONFIRM_URL:
            localConfirmServer.confirmUrl,
        },
        timeoutMs: Number(
          process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_SETUP_TIMEOUT_MS ??
            90_000,
        ),
      }),
      localConfirmServer.waitForConfirmation(),
    ]);
    return { providerInstanceId: setup.providerInstanceId };
  } finally {
    await localConfirmServer.close();
  }
}

async function startSetupConfirmServer(): Promise<{
  readonly manifestUrl: string;
  readonly confirmUrl: string;
  readonly waitForConfirmation: () => Promise<void>;
  readonly close: () => Promise<void>;
}> {
  let confirmed = false;
  let failure: Error | null = null;
  let resolveConfirmed: (() => void) | null = null;
  const confirmedPromise = new Promise<void>((resolve) => {
    resolveConfirmed = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/confirm") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    try {
      const payload = JSON.parse(await readRequestBody(request));
      await confirmCodexRotatingSetupManifest({ prisma, payload });
      confirmed = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "accepted" }));
      resolveConfirmed?.();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: failure.message }));
      resolveConfirmed?.();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("codex_rotating_e2e_confirm_server_failed");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    manifestUrl: `${baseUrl}/manifest`,
    confirmUrl: `${baseUrl}/confirm`,
    waitForConfirmation: async () => {
      await Promise.race([
        confirmedPromise,
        sleep(
          Number(
            process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_SETUP_TIMEOUT_MS ??
              90_000,
          ),
        ),
      ]);
      if (failure) throw failure;
      if (!confirmed) {
        throw new Error("codex_rotating_setup_confirmation_timeout");
      }
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 64 * 1024) {
      throw new Error("setup_confirmation_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function findLatestSetupNonce(
  providerInstanceId: string,
): Promise<string> {
  const rows = await prisma.$queryRaw<SetupManifestRow[]>`
    SELECT "setupNonce"
    FROM "CodexOAuthSetupManifest"
    WHERE "providerInstanceId" = ${providerInstanceId}
    ORDER BY "createdAt" DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    throw new Error("codex_rotating_setup_manifest_not_created");
  }
  return row.setupNonce;
}

async function provisionRotatingWorkflow(input: {
  readonly installationId: number;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly providerInstanceId: string;
}): Promise<{
  readonly url: string;
  readonly number: number;
  readonly branch: string;
}> {
  const octokit = await app.getInstallationOctokit(input.installationId);
  return provisionReviewRouterWorkflow(
    {
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      owner: input.owner,
      name: input.name,
      defaultBranch: input.defaultBranch,
      actionRef,
      apiUrl,
      runtimeConfigMode: "oidc",
      codexRotatingProviderInstanceId: input.providerInstanceId,
    },
    {
      setupGateway: new OctokitWorkflowSetupGateway(octokit),
      provisioning: new PrismaWorkflowProvisioningRepository(prisma),
    },
  );
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
    (file) => file.path === ".github/workflows/reviewrouter-codex.yml",
  );
  if (
    !workflowFile ||
    !["ADDED", "MODIFIED"].includes(workflowFile.changeType)
  ) {
    throw new Error(
      "setup PR did not add or update .github/workflows/reviewrouter-codex.yml",
    );
  }
}

async function waitForPullRequestMergeability(
  number: number,
): Promise<PullRequestView> {
  const deadline = Date.now() + 90_000;
  let latest = readPullRequest(number);
  while (Date.now() < deadline) {
    latest = readPullRequest(number);
    if (latest.mergeable !== "UNKNOWN") return latest;
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
    "ReviewRouter Codex rotating OAuth live E2E.",
  ]);
}

async function waitForRotatingWorkflowOnDefaultBranch(
  defaultBranch: string,
  providerInstanceId: string,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (
      await isRotatingWorkflowCurrentOnDefaultBranch(
        defaultBranch,
        providerInstanceId,
      )
    ) {
      return;
    }
    await sleep(3_000);
  }
  throw new Error(
    "rotating workflow did not become current on the default branch",
  );
}

async function isRotatingWorkflowCurrentOnDefaultBranch(
  defaultBranch: string,
  providerInstanceId: string,
): Promise<boolean> {
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${targetRepo}/contents/.github/workflows/reviewrouter-codex.yml?ref=${encodeURIComponent(defaultBranch)}`,
      "--jq",
      ".content",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    return false;
  }
  const workflow = Buffer.from(result.stdout.trim(), "base64").toString("utf8");
  return workflow.includes(actionRef) && workflow.includes(providerInstanceId);
}

async function runReviewPullRequest(input: {
  readonly label: string;
  readonly defaultBranch: string;
  readonly providerInstanceId: string;
  readonly minCompletedWritebacks: number;
  readonly minGeneration: number;
}): Promise<{
  readonly pullRequestUrl: string;
  readonly runUrl: string;
  readonly runConclusion: string;
  readonly completedWritebacks: number;
  readonly latestGeneration: number;
  readonly commentId: number;
}> {
  const repoWorkdir = join(workdir, `repo-${input.label}`);
  run("gh", ["repo", "clone", targetRepo, repoWorkdir, "--", "--depth=1"]);
  run("git", ["checkout", "-q", input.defaultBranch], { cwd: repoWorkdir });
  const branch = `rr-codex-rotating-e2e-${input.label}-${Date.now()}`;
  run("git", ["checkout", "-q", "-b", branch], { cwd: repoWorkdir });
  const fixturePath = `codex-rotating-e2e-${input.label}.md`;
  writeFileSync(
    join(repoWorkdir, fixturePath),
    [
      `# Codex rotating OAuth E2E ${input.label}`,
      "",
      "This file intentionally changes between E2E runs so GitHub Actions starts a same-repository pull request workflow.",
      `Run label: ${input.label}`,
      `Timestamp: ${new Date().toISOString()}`,
      "",
    ].join("\n"),
  );
  run("git", ["add", fixturePath], { cwd: repoWorkdir });
  run(
    "git",
    [
      "-c",
      "user.name=ReviewRouter E2E",
      "-c",
      "user.email=reviewrouter-e2e@example.invalid",
      "commit",
      "-q",
      "-m",
      `test: exercise Codex rotating OAuth ${input.label}`,
    ],
    { cwd: repoWorkdir },
  );
  run("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd: repoWorkdir });
  const pullRequestUrl = run("gh", [
    "pr",
    "create",
    "--repo",
    targetRepo,
    "--title",
    `test: Codex rotating OAuth ${input.label}`,
    "--body",
    "Disposable ReviewRouter Codex rotating OAuth live E2E pull request.",
    "--base",
    input.defaultBranch,
    "--head",
    branch,
  ]).trim();
  const prNumber = Number(pullRequestUrl.split("/").at(-1));
  if (!Number.isInteger(prNumber)) {
    throw new Error(`could not parse PR number from ${pullRequestUrl}`);
  }

  const runView = await waitForReviewRun(branch);
  const watch = runAllowFailure("gh", [
    "run",
    "watch",
    String(runView.databaseId),
    "--repo",
    targetRepo,
    "--exit-status",
  ]);
  const completedRun = await getRun(runView.databaseId);
  const logs = run("gh", [
    "run",
    "view",
    String(runView.databaseId),
    "--repo",
    targetRepo,
    "--log",
  ]);
  assertNoForbiddenLogFields(logs);
  await assertNoArtifacts(runView.databaseId);
  if (watch.status !== 0 || completedRun.conclusion !== "success") {
    throw new Error(
      `Codex rotating workflow did not succeed: watch=${watch.status} conclusion=${completedRun.conclusion} run=${completedRun.url}`,
    );
  }

  const comment = await waitForReviewRouterComment(prNumber);
  const provider = await readProviderState(input.providerInstanceId);
  const completedWritebacks = await prisma.codexOAuthWritebackIntent.count({
    where: {
      providerInstanceId: input.providerInstanceId,
      status: "completed",
    },
  });
  if (provider.latestGeneration < input.minGeneration) {
    throw new Error(
      `provider generation did not advance: expected at least ${input.minGeneration}, got ${provider.latestGeneration}`,
    );
  }
  if (completedWritebacks < input.minCompletedWritebacks) {
    throw new Error(
      `completed writebacks did not advance: expected at least ${input.minCompletedWritebacks}, got ${completedWritebacks}`,
    );
  }
  if (!keepPullRequests) {
    runAllowFailure("gh", [
      "pr",
      "close",
      String(prNumber),
      "--repo",
      targetRepo,
      "--delete-branch",
    ]);
  }
  return {
    pullRequestUrl,
    runUrl: completedRun.url,
    runConclusion: completedRun.conclusion,
    completedWritebacks,
    latestGeneration: provider.latestGeneration,
    commentId: comment.id,
  };
}

async function waitForReviewRun(branch: string): Promise<WorkflowRunView> {
  const deadline = Date.now() + runTimeoutMs;
  while (Date.now() < deadline) {
    const runs = JSON.parse(
      run("gh", [
        "run",
        "list",
        "--repo",
        targetRepo,
        "--workflow",
        "ReviewRouter Codex OAuth",
        "--branch",
        branch,
        "--limit",
        "1",
        "--json",
        "databaseId,status,conclusion,url,headSha",
      ]),
    ) as WorkflowRunView[];
    if (runs[0]) return runs[0];
    await sleep(3_000);
  }
  throw new Error(
    `ReviewRouter Codex rotating run did not start for branch ${branch}`,
  );
}

async function getRun(databaseId: number): Promise<WorkflowRunView> {
  return JSON.parse(
    run("gh", [
      "run",
      "view",
      String(databaseId),
      "--repo",
      targetRepo,
      "--json",
      "databaseId,status,conclusion,url,headSha",
    ]),
  ) as WorkflowRunView;
}

async function waitForReviewRouterComment(
  prNumber: number,
): Promise<IssueCommentView> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const comments = JSON.parse(
      run("gh", ["api", `repos/${targetRepo}/issues/${prNumber}/comments`]),
    ) as IssueCommentView[];
    const comment = comments.find((candidate) =>
      candidate.body.includes("<!-- reviewrouter:codex-oauth-rotating"),
    );
    if (comment) return comment;
    await sleep(3_000);
  }
  throw new Error("ReviewRouter rotating advisory comment was not posted");
}

async function readProviderState(providerInstanceId: string): Promise<{
  readonly latestGeneration: number;
  readonly state: string;
}> {
  const provider = await prisma.codexOAuthProviderInstance.findUnique({
    where: { providerInstanceId },
    select: { latestGeneration: true, state: true },
  });
  if (!provider) {
    throw new Error("codex_rotating_provider_missing_after_setup");
  }
  if (provider.state !== "active") {
    throw new Error(`codex_rotating_provider_not_active:${provider.state}`);
  }
  return provider;
}

async function assertNoArtifacts(runId: number): Promise<void> {
  const data = JSON.parse(
    run("gh", ["api", `repos/${targetRepo}/actions/runs/${runId}/artifacts`]),
  ) as { readonly artifacts?: readonly unknown[] };
  if ((data.artifacts?.length ?? 0) > 0) {
    throw new Error(
      `Codex rotating E2E run produced artifacts: ${data.artifacts?.length}`,
    );
  }
}

function assertNoForbiddenLogFields(logs: string): void {
  const forbidden = [
    /refresh_token["'\s:=]+[A-Za-z0-9._~+/=-]{12,}/i,
    /access_token["'\s:=]+[A-Za-z0-9._~+/=-]{12,}/i,
    /id_token["'\s:=]+[A-Za-z0-9._~+/=-]{12,}/i,
    /REVIEWROUTER_CODEX_AUTH_JSON\s*[:=]\s*\{/i,
    /encryptedValue["'\s:=]+[A-Za-z0-9+/=_-]{80,}/i,
    /encrypted_payload_digest["'\s:=]+[A-Za-z0-9+/=_-]{32,}/i,
  ];
  const match = forbidden.find((pattern) => pattern.test(logs));
  if (match) {
    throw new Error(
      `Codex rotating E2E logs contain forbidden auth material pattern: ${match.source}`,
    );
  }
}

function assertTargetRepoAllowlisted(repositoryFullName: string): void {
  const enabled = process.env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH === "1";
  const allowlist = (
    process.env.REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES ?? ""
  )
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (
    !enabled ||
    (allowlist.length > 0 &&
      !allowlist.includes(repositoryFullName.toLowerCase()))
  ) {
    throw new Error(
      [
        `codex_rotating_e2e_repo_not_enabled:${repositoryFullName}`,
        "Set REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH=1 for both the E2E process and the deployed API handling the GitHub runner. REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES can optionally restrict the live E2E to selected repositories.",
      ].join(" "),
    );
  }
}

function assertActionRefIsPinned(ref: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/i.test(ref)) {
    throw new Error(
      `codex_rotating_e2e_action_ref_must_be_full_sha:${ref}. Set REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF=owner/repo@40-char-sha after committing and pushing the rotating action.`,
    );
  }
}

function assertActionRefIsFetchable(ref: string): void {
  const [repository, sha] = ref.split("@") as [string, string];
  const requiredPaths = [
    "action.yml",
    "action-dist/index.cjs",
    "action-dist/codex/linux-x64/codex-linux-x64.tgz",
    "action-dist/codex/linux-x64/manifest.json",
  ];
  for (const path of requiredPaths) {
    const result = spawnSync(
      "gh",
      [
        "api",
        `repos/${repository}/contents/${path}?ref=${sha}`,
        "--jq",
        ".size",
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(
        `codex_rotating_e2e_action_artifact_not_fetchable:${repository}@${sha}:${path}`,
      );
    }
  }
}

function normalizePublicHttpsUrl(value: string): string {
  if (!value) {
    throw new Error("missing_codex_rotating_e2e_api_url");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid_codex_rotating_e2e_api_url:${value}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("codex_rotating_e2e_api_url_must_be_https");
  }
  if (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname.endsWith(".localhost")
  ) {
    throw new Error(
      "codex_rotating_e2e_api_url_must_be_reachable_from_github_hosted_runner",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function currentGitHubLogin(): string {
  return run("gh", ["api", "user", "--jq", ".login"]).trim();
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
  try {
    return execFileSync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : "unknown";
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr)
        : "";
    throw new Error(
      `command_failed:${command} ${args.join(" ")} status=${status} ${stderr.trim()}`,
      { cause: error },
    );
  }
}

function runAsync(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
            reject(
              new Error(
                `command_timeout:${command} ${args.join(" ")} timeoutMs=${options.timeoutMs}`,
              ),
            );
          }, options.timeoutMs)
        : undefined;

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      if (timeout) clearTimeout(timeout);
      if (status === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new Error(
          `command_failed:${command} ${args.join(" ")} status=${status ?? "unknown"} ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
  });
}

function runAllowFailure(command: string, args: readonly string[]) {
  return spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
