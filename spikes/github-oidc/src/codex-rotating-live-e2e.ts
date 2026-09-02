import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";
import {
  isLoopbackHostname,
  requireReviewRouterDatabaseRecoveryWitness,
  resolveReviewRouterCodexRotatingActionRef,
} from "../../../packages/platform/config/src/index.ts";
import { SystemClock } from "../../../packages/shared/src/index.ts";
import {
  OctokitGitHubRepositorySource,
  PrismaRepositoryConnectionRepository,
  syncInstallationRepositories,
} from "../../../packages/features/repositories/src/index.ts";
import {
  CodexRotatingReviewActionV2Mode,
  CodexRotatingT0WorkflowSchemaVersion,
  WorkflowSourceTrust,
  assertSameVersionedProviderSecretNamespace,
  assertTrustedCanonicalVersionedWorkflow,
  createVersionedProviderSecretNamespace,
  createVersionedSecretWorkflowSourceAttestation,
  defaultCodexRotatingWorkflowPath,
  OctokitWorkflowSetupGateway,
  PrismaWorkflowProvisioningRepository,
  PrismaWorkflowProvisioningTarget,
  provisionRepositoryReviewRouterWorkflow,
  readCanonicalCodexRotatingT0WorkflowSourceMetadata,
  workflowDocumentSemanticSha256,
  type VersionedProviderSecretNamespace,
} from "../../../packages/features/workflow-provisioning/src/index.ts";
import { inspectCodexRotatingWorkflowNamespace } from "../../../packages/features/provider-setup/src/index.ts";
import { issueCodexRotatingSetupForRepository } from "../../../apps/web/src/server/codex-rotating-setup-command.ts";
import { PrismaCodexRotatingSetupPayloadClaim } from "../../../apps/web/src/server/prisma-codex-rotating-setup-payload-claim.ts";
import { PrismaCodexRotatingWorkflowNamespace } from "../../../apps/web/src/server/prisma-codex-rotating-workflow-namespace.ts";
import { createGitHubApp, findInstallationForRepo } from "./github-app.js";
import { loadAppProfile, loadEnvFiles } from "./config.js";
import {
  assertGitHubAppCommentAuthor,
  expectedGitHubAppBotLogin,
} from "./review-comment-identity.js";
import { assertDisposableRepositoryProvenance } from "./codex-rotating-live-e2e-provenance.js";

type RepositoryView = {
  readonly numericId: string;
  readonly nameWithOwner: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  readonly defaultBranchRef: { readonly name: string } | null;
};

type RepositoryVisibility = "public" | "private";

type ReviewMode = "clean" | "finding";

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
  readonly attempt: number;
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

type ReviewCommentView = {
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
  readonly user: { readonly login: string };
};

loadEnvFiles();

const owner =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_OWNER?.trim() ||
  currentGitHubLogin();
const repoName =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_REPO_NAME?.trim() ||
  "rr-codex-rotating-e2e";
const visibility = parseVisibility(
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_VISIBILITY ?? "private",
);
const targetRepo = `${owner}/${repoName}`;
const apiUrl = normalizePublicHttpsUrl(
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_API_URL?.trim() ||
    process.env.REVIEW_ROUTER_PUBLIC_API_URL?.trim() ||
    process.env.REVIEW_ROUTER_API_URL?.trim() ||
    "",
);
const actionRef =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_ACTION_REF?.trim() ||
  resolveReviewRouterCodexRotatingActionRef();
const authFile =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_AUTH_FILE?.trim() ||
  process.env.REVIEW_ROUTER_CODEX_AUTH_FILE?.trim() ||
  "";
const allowInteractiveLogin =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_ALLOW_LOGIN === "1";
const keepPullRequests =
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_KEEP_PRS === "1";
const reviewMode = parseReviewMode(
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_REVIEW_MODE ?? "clean",
);
const runTimeoutMs = Number(
  process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_RUN_TIMEOUT_MS ?? 20 * 60_000,
);
const workdir = mkdtempSync(join(tmpdir(), "reviewrouter-codex-rotating-e2e-"));
const profile = loadAppProfile();
const expectedCommentAuthor = expectedGitHubAppBotLogin(profile.APP_SLUG);
const app = createGitHubApp(profile);
let prisma = createPrismaClient();
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
assertLiveE2EMutationAuthorized();
assertTargetRepoAllowlisted(targetRepo);
if (!authFile && !allowInteractiveLogin) {
  throw new Error(
    "missing_codex_rotating_e2e_auth_file: set REVIEW_ROUTER_CODEX_ROTATING_E2E_AUTH_FILE, or set REVIEW_ROUTER_CODEX_ROTATING_E2E_ALLOW_LOGIN=1 for an interactive local Codex login",
  );
}
try {
  trace("ensure-repository");
  const repositoryView = ensureRepository();
  trace("check-retired-stable-secret-absent");
  assertRetiredStableSecretAbsent();
  trace("wait-for-installation");
  const installationId = await waitForRepositoryInstallation(targetRepo);
  trace("sync-installation");
  await syncInstallation(installationId);

  trace("find-synced-repository");
  const repository = await findSyncedRepository(targetRepo);
  if (!repository.githubRepositoryId) {
    throw new Error("synced repository is missing GitHub id");
  }
  if (repository.githubRepositoryId.toString() !== repositoryView.numericId) {
    throw new Error("codex_rotating_e2e_synced_repository_id_mismatch");
  }
  trace("seed-rotating-codex-auth");
  const setup = await seedRotatingCodexAuth({
    workspaceId: repository.workspaceId,
    repositoryId: repository.id,
    provider: repository.provider,
    repositoryFullName: repository.fullName,
    githubRepositoryId: repository.githubRepositoryId.toString(),
    selected: repository.selected,
    archived: repository.archived,
    installation: repository.installation,
  });

  trace("check-workflow-current");
  const workflowCurrent = await isRotatingWorkflowCurrentOnDefaultBranch(
    repository.defaultBranch,
    setup.providerInstanceId,
    repository.githubRepositoryId.toString(),
    setup.workflowNamespace,
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
        workflowNamespace: setup.workflowNamespace,
      });
  if (setupPullRequest) {
    trace("merge-setup-pr");
    created.setupPullRequestUrl = setupPullRequest.url;
    await assertSetupPullRequest(setupPullRequest);
    mergePullRequest(
      setupPullRequest.number,
      "chore: install ReviewRouter Codex OAuth beta",
    );
    await waitForRotatingWorkflowOnDefaultBranch(
      repository.defaultBranch,
      setup.providerInstanceId,
      repository.githubRepositoryId.toString(),
      setup.workflowNamespace,
    );
  }
  trace("activate-versioned-setup-namespace");
  await activateVersionedSetupNamespace({
    installationId,
    repositoryId: repository.id,
    githubRepositoryId: repository.githubRepositoryId.toString(),
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.defaultBranch,
    providerInstanceId: setup.providerInstanceId,
    workflowNamespace: setup.workflowNamespace,
    claimId: setup.claimId,
    attemptId: setup.attemptId,
  });
  await assertActiveWorkflowNamespace({
    workspaceId: repository.workspaceId,
    repositoryId: repository.id,
    githubRepositoryId: repository.githubRepositoryId.toString(),
    providerInstanceId: setup.providerInstanceId,
    expectedNamespace: setup.workflowNamespace,
  });
  assertRetiredStableSecretAbsent();

  trace("read-provider-before-runs");
  const providerBeforeRuns = await readProviderState(setup.providerInstanceId);
  trace("run-first-review-pr");
  const first = await runReviewPullRequest({
    label: "first",
    defaultBranch:
      repositoryView.defaultBranchRef?.name || repository.defaultBranch,
    providerInstanceId: setup.providerInstanceId,
    previousProviderState: providerBeforeRuns,
    githubRepositoryId: repository.githubRepositoryId.toString(),
  });
  created.firstPullRequestUrl = first.pullRequestUrl;
  created.firstRunUrl = first.runUrl;

  trace("read-provider-after-first");
  const afterFirst = await readProviderState(setup.providerInstanceId);
  trace("run-second-review-pr");
  const second = await runReviewPullRequest({
    label: "second",
    defaultBranch:
      repositoryView.defaultBranchRef?.name || repository.defaultBranch,
    providerInstanceId: setup.providerInstanceId,
    previousProviderState: afterFirst,
    githubRepositoryId: repository.githubRepositoryId.toString(),
  });
  created.secondPullRequestUrl = second.pullRequestUrl;
  created.secondRunUrl = second.runUrl;

  console.log(
    JSON.stringify(
      {
        ok: true,
        targetRepo,
        visibility,
        reviewMode,
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
        stack:
          process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_TRACE === "1" &&
          error instanceof Error
            ? error.stack
            : undefined,
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

function ensureRepository(): RepositoryView {
  const existing = readRepositoryView(targetRepo);
  if (existing) {
    assertDisposableRepositoryProvenance({
      repositoryId: existing.numericId,
      repositoryFullName: targetRepo,
      ...(process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_DISPOSABLE_REPOSITORY_ID
        ? {
            expectedExistingRepositoryId:
              process.env
                .REVIEW_ROUTER_CODEX_ROTATING_E2E_DISPOSABLE_REPOSITORY_ID,
          }
        : {}),
    });
    if (existing.isPrivate !== (visibility === "private")) {
      throw new Error(
        `codex_rotating_e2e_repo_visibility_mismatch:${targetRepo}:expected_${visibility}`,
      );
    }
    if (existing.isArchived) {
      throw new Error(`codex_rotating_e2e_repo_is_archived:${targetRepo}`);
    }
    return existing;
  }
  throw new Error(`codex_rotating_e2e_repository_missing:${targetRepo}`);
}

function readRepositoryView(repository: string): RepositoryView | null {
  const metadataResult = spawnSync(
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
  const identityResult = spawnSync(
    "gh",
    ["api", `repos/${repository}`, "--jq", ".id"],
    { encoding: "utf8" },
  );
  if (metadataResult.status !== 0 || identityResult.status !== 0) {
    const diagnostic = `${metadataResult.stdout ?? ""}\n${metadataResult.stderr ?? ""}\n${identityResult.stdout ?? ""}\n${identityResult.stderr ?? ""}`;
    if (/\bHTTP 404\b|\bNot Found\b/iu.test(diagnostic)) return null;
    throw new Error(
      `codex_rotating_e2e_repository_identity_unavailable:${repository}`,
    );
  }
  const numericId = identityResult.stdout.trim();
  if (!/^[1-9][0-9]*$/u.test(numericId)) {
    throw new Error(
      `codex_rotating_e2e_repository_numeric_id_invalid:${repository}`,
    );
  }
  const metadata = JSON.parse(metadataResult.stdout) as Omit<
    RepositoryView,
    "numericId"
  >;
  if (metadata.nameWithOwner.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(
      `codex_rotating_e2e_repository_name_mismatch:${repository}`,
    );
  }
  return { ...metadata, numericId };
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
  await withPrismaConnectionRetry("sync-installation", () =>
    syncInstallationRepositories(String(installationId), {
      github: new OctokitGitHubRepositorySource({
        appId: profile.APP_ID,
        privateKey: profile.privateKey,
      }),
      repositories: new PrismaRepositoryConnectionRepository(prisma),
      clock: new SystemClock(),
    }),
  );
}

async function findSyncedRepository(repositoryFullName: string) {
  const repository = await withPrismaConnectionRetry(
    "find-synced-repository",
    () =>
      prisma.repositoryConnection.findFirst({
        where: { fullName: repositoryFullName, selected: true },
        select: {
          id: true,
          workspaceId: true,
          provider: true,
          githubRepositoryId: true,
          owner: true,
          name: true,
          fullName: true,
          defaultBranch: true,
          visibility: true,
          selected: true,
          archived: true,
          installation: { select: { status: true } },
        },
      }),
  );
  if (!repository) {
    throw new Error(
      `Repository ${repositoryFullName} was not synced into ReviewRouter DB`,
    );
  }
  if (repository.visibility !== visibility) {
    throw new Error(
      `codex_rotating_e2e_synced_repo_visibility_mismatch:expected_${visibility}:got_${repository.visibility}`,
    );
  }
  return repository;
}

async function seedRotatingCodexAuth(input: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly provider: string;
  readonly repositoryFullName: string;
  readonly githubRepositoryId: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly installation: { readonly status: string } | null;
}): Promise<{
  readonly providerInstanceId: string;
  readonly workflowNamespace: VersionedProviderSecretNamespace;
  readonly claimId: string;
  readonly attemptId: string;
}> {
  const codexHome = join(workdir, "codex-home");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (authFile) {
    const stagedAuthFile = join(codexHome, "auth.json");
    copyFileSync(authFile, stagedAuthFile);
    chmodSync(stagedAuthFile, 0o600);
  }

  const setup = await issueCodexRotatingSetupForRepository({
    prisma,
    repository: {
      id: input.repositoryId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      githubRepositoryId: BigInt(input.githubRepositoryId),
      fullName: input.repositoryFullName,
      selected: input.selected,
      archived: input.archived,
      installation: input.installation,
    },
    ...(authFile
      ? {
          installerArguments: [
            "--reuse-existing-auth-i-know-it-is-current" as const,
          ],
        }
      : {}),
  });
  await runSensitiveInstallerCommand(setup.command, {
    ...process.env,
    REVIEW_ROUTER_CODEX_HOME: codexHome,
  });

  const inspection = await inspectCodexRotatingWorkflowNamespace(
    {
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      githubRepositoryId: input.githubRepositoryId,
      providerInstanceId: setup.providerInstanceId,
    },
    {
      workflowNamespace: new PrismaCodexRotatingWorkflowNamespace(
        prisma,
        requireReviewRouterDatabaseRecoveryWitness(),
      ),
    },
  );
  if (inspection.source !== "confirmed_setup_candidate") {
    throw new Error("codex_rotating_e2e_fresh_setup_candidate_required");
  }
  return {
    providerInstanceId: setup.providerInstanceId,
    workflowNamespace: inspection.namespace,
    claimId: inspection.claimId,
    attemptId: inspection.attemptId,
  };
}

async function provisionRotatingWorkflow(input: {
  readonly installationId: number;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly providerInstanceId: string;
  readonly workflowNamespace: VersionedProviderSecretNamespace;
}): Promise<{
  readonly url: string;
  readonly number: number;
  readonly branch: string;
}> {
  const octokit = await app.getInstallationOctokit(input.installationId);
  return provisionRepositoryReviewRouterWorkflow(
    {
      repositoryId: input.repositoryId,
      actionRef,
      apiUrl,
      runtimeConfigMode: "oidc",
      codexRotatingProviderInstanceId: input.providerInstanceId,
      codexRotatingWorkflowSecretNamespace: input.workflowNamespace,
      codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      codexRotatingWorkflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5,
      forkAgenticSandboxEnabled: false,
    },
    {
      targets: new PrismaWorkflowProvisioningTarget(prisma),
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
  githubRepositoryId: string,
  workflowNamespace: VersionedProviderSecretNamespace,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (
      await isRotatingWorkflowCurrentOnDefaultBranch(
        defaultBranch,
        providerInstanceId,
        githubRepositoryId,
        workflowNamespace,
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
  githubRepositoryId: string,
  workflowNamespace: VersionedProviderSecretNamespace,
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
  try {
    assertTrustedCanonicalVersionedWorkflow({
      metadata: readCanonicalCodexRotatingT0WorkflowSourceMetadata(workflow),
      observedRepositoryId: githubRepositoryId,
      observedRepositoryFullName: targetRepo,
      expectedRepositoryId: githubRepositoryId,
      expectedRepositoryFullName: targetRepo,
      trustedActionRefs: [actionRef],
      expectedApiUrl: apiUrl,
      expectedProviderInstanceId: providerInstanceId,
      expectedSecretNamespace: workflowNamespace,
      expectedWorkflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5,
    });
    return true;
  } catch {
    return false;
  }
}

async function activateVersionedSetupNamespace(input: {
  readonly installationId: number;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly providerInstanceId: string;
  readonly workflowNamespace: VersionedProviderSecretNamespace;
  readonly claimId: string;
  readonly attemptId: string;
}): Promise<void> {
  const octokit = await app.getInstallationOctokit(input.installationId);
  const repositoryResponse = await octokit.request(
    "GET /repos/{owner}/{repo}",
    {
      owner: input.owner,
      repo: input.name,
    },
  );
  const observedRepository = readGitHubRepositoryIdentity(
    repositoryResponse.data,
  );
  if (
    observedRepository.id !== input.githubRepositoryId ||
    observedRepository.fullName !== targetRepo ||
    observedRepository.defaultBranch !== input.defaultBranch
  ) {
    throw new Error("codex_rotating_e2e_workflow_repository_mismatch");
  }

  const refResponse = await octokit.request(
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    {
      owner: input.owner,
      repo: input.name,
      ref: `heads/${input.defaultBranch}`,
    },
  );
  const workflowSourceCommitSha = readGitHubCommitSha(refResponse.data);
  const contentResponse = await octokit.request(
    "GET /repos/{owner}/{repo}/contents/{path}",
    {
      owner: input.owner,
      repo: input.name,
      path: defaultCodexRotatingWorkflowPath,
      ref: workflowSourceCommitSha,
    },
  );
  const { source, blobSha } = readGitHubWorkflowBlob(contentResponse.data);
  const metadata = readCanonicalCodexRotatingT0WorkflowSourceMetadata(source);
  assertTrustedCanonicalVersionedWorkflow({
    metadata,
    observedRepositoryId: observedRepository.id,
    observedRepositoryFullName: observedRepository.fullName,
    expectedRepositoryId: input.githubRepositoryId,
    expectedRepositoryFullName: targetRepo,
    trustedActionRefs: [actionRef],
    expectedApiUrl: apiUrl,
    expectedProviderInstanceId: input.providerInstanceId,
    expectedSecretNamespace: input.workflowNamespace,
    expectedWorkflowSchemaVersion:
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5,
  });
  const attestation = createVersionedSecretWorkflowSourceAttestation({
    repositoryId: input.githubRepositoryId,
    workflowPath: defaultCodexRotatingWorkflowPath,
    workflowSourceCommitSha,
    workflowSourceBlobSha: blobSha,
    workflowSourceSha256: createHash("sha256").update(source).digest("hex"),
    workflowSemanticSha256: workflowDocumentSemanticSha256(source),
    workflowSchemaVersion: metadata.workflowSchemaVersion,
    sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
    secretNamespace: input.workflowNamespace,
  });
  const finalRefResponse = await octokit.request(
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    {
      owner: input.owner,
      repo: input.name,
      ref: `heads/${input.defaultBranch}`,
    },
  );
  if (readGitHubCommitSha(finalRefResponse.data) !== workflowSourceCommitSha) {
    throw new Error("codex_rotating_e2e_workflow_default_head_changed");
  }

  const claims = new PrismaCodexRotatingSetupPayloadClaim(
    prisma,
    requireReviewRouterDatabaseRecoveryWitness(),
    undefined,
    process.env,
  );
  await claims.activate({
    claimId: input.claimId,
    attemptId: input.attemptId,
    namespaceId: input.workflowNamespace.namespaceId,
    namespaceEpoch: input.workflowNamespace.epoch.toString(),
    secretName: input.workflowNamespace.name,
    repositoryId: attestation.repositoryId,
    workflowPath:
      attestation.workflowPath as ".github/workflows/reviewrouter-codex.yml",
    workflowSourceCommitSha: attestation.workflowSourceCommitSha,
    workflowSourceBlobSha: attestation.workflowSourceBlobSha,
    workflowSourceSha256: attestation.workflowSourceSha256,
    workflowSemanticSha256: attestation.workflowSemanticSha256,
    sourceTrust: "trusted_default_branch_revision",
    workflowSchemaVersion: attestation.workflowSchemaVersion,
  });
}

async function assertActiveWorkflowNamespace(input: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
  readonly providerInstanceId: string;
  readonly expectedNamespace: VersionedProviderSecretNamespace;
}): Promise<void> {
  const inspection = await inspectCodexRotatingWorkflowNamespace(
    {
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      githubRepositoryId: input.githubRepositoryId,
      providerInstanceId: input.providerInstanceId,
    },
    {
      workflowNamespace: new PrismaCodexRotatingWorkflowNamespace(
        prisma,
        requireReviewRouterDatabaseRecoveryWitness(),
      ),
    },
  );
  if (inspection.source !== "active") {
    throw new Error("codex_rotating_e2e_namespace_not_active");
  }
  assertSameVersionedProviderSecretNamespace({
    expected: input.expectedNamespace,
    actual: inspection.namespace,
  });
}

function readGitHubRepositoryIdentity(data: unknown): {
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
} {
  const repository = data as {
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
  } | null;
  if (
    typeof repository?.id !== "number" ||
    !Number.isSafeInteger(repository.id) ||
    repository.id <= 0 ||
    typeof repository.full_name !== "string" ||
    typeof repository.default_branch !== "string"
  ) {
    throw new Error("codex_rotating_e2e_repository_response_invalid");
  }
  return {
    id: String(repository.id),
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
  };
}

function readGitHubCommitSha(data: unknown): string {
  const sha = (data as { object?: { sha?: unknown } } | null)?.object?.sha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error("codex_rotating_e2e_commit_response_invalid");
  }
  return sha.toLowerCase();
}

function readGitHubWorkflowBlob(data: unknown): {
  readonly source: string;
  readonly blobSha: string;
} {
  const blob = data as {
    type?: unknown;
    encoding?: unknown;
    content?: unknown;
    sha?: unknown;
  } | null;
  if (
    blob?.type !== "file" ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string" ||
    typeof blob.sha !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(blob.sha)
  ) {
    throw new Error("codex_rotating_e2e_workflow_response_invalid");
  }
  const source = Buffer.from(
    blob.content.replace(/\s+/g, ""),
    "base64",
  ).toString("utf8");
  const blobSha = blob.sha.toLowerCase();
  const computedBlobSha = createHash(blobSha.length === 40 ? "sha1" : "sha256")
    .update(`blob ${Buffer.byteLength(source, "utf8")}\0`, "utf8")
    .update(source, "utf8")
    .digest("hex");
  if (computedBlobSha !== blobSha) {
    throw new Error("codex_rotating_e2e_workflow_blob_mismatch");
  }
  return { source, blobSha };
}

async function runReviewPullRequest(input: {
  readonly label: string;
  readonly defaultBranch: string;
  readonly providerInstanceId: string;
  readonly previousProviderState: Readonly<{
    latestGeneration: number;
    latestGenerationHash: string;
    completedWritebacks: number;
    activeNamespace: VersionedProviderSecretNamespace;
  }>;
  readonly githubRepositoryId: string;
}): Promise<{
  readonly pullRequestUrl: string;
  readonly runUrl: string;
  readonly runConclusion: string;
  readonly completedWritebacks: number;
  readonly latestGeneration: number;
  readonly advisoryCommentId: number | null;
  readonly inlineCommentCount: number;
}> {
  const repoWorkdir = join(workdir, `repo-${input.label}`);
  run("gh", ["repo", "clone", targetRepo, repoWorkdir, "--", "--depth=1"]);
  run("git", ["checkout", "-q", input.defaultBranch], { cwd: repoWorkdir });
  const branch = `rr-codex-rotating-e2e-${input.label}-${Date.now()}`;
  run("git", ["checkout", "-q", "-b", branch], { cwd: repoWorkdir });
  const fixture = writeReviewFixture(repoWorkdir, input.label);
  run("git", ["add", ...fixture.paths], { cwd: repoWorkdir });
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
  const authoredHeadSha = run("git", ["rev-parse", "HEAD"], {
    cwd: repoWorkdir,
  })
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(authoredHeadSha)) {
    throw new Error("codex_rotating_e2e_authored_commit_invalid");
  }
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
  if (runView.headSha.toLowerCase() !== authoredHeadSha) {
    throw new Error("codex_rotating_e2e_workflow_run_head_mismatch");
  }
  const completedRun = await waitForRunCompletion(runView);
  const logs = run("gh", [
    "run",
    "view",
    String(runView.databaseId),
    "--repo",
    targetRepo,
    "--attempt",
    String(runView.attempt),
    "--log",
  ]);
  assertNoForbiddenLogFields(logs);
  await assertNoArtifacts(runView.databaseId);
  const expectedConclusion = reviewMode === "finding" ? "failure" : "success";
  if (completedRun.conclusion !== expectedConclusion) {
    throw new Error(
      `Codex rotating workflow conclusion mismatch: expected=${expectedConclusion} conclusion=${completedRun.conclusion} run=${completedRun.url}`,
    );
  }

  const advisoryComment =
    reviewMode === "clean" ? await waitForReviewRouterComment(prNumber) : null;
  const inlineComments =
    reviewMode === "finding"
      ? await waitForReviewRouterInlineComments(prNumber)
      : [];
  const provider = await readProviderState(input.providerInstanceId);
  const completedWritebacks = provider.completedWritebacks;
  if (
    provider.latestGeneration !==
    input.previousProviderState.latestGeneration + 1
  ) {
    throw new Error(
      `provider generation did not advance exactly once: expected ${input.previousProviderState.latestGeneration + 1}, got ${provider.latestGeneration}`,
    );
  }
  if (
    completedWritebacks !==
    input.previousProviderState.completedWritebacks + 1
  ) {
    throw new Error(
      `completed writebacks did not advance exactly once: expected ${input.previousProviderState.completedWritebacks + 1}, got ${completedWritebacks}`,
    );
  }
  if (
    provider.latestGenerationHash ===
    input.previousProviderState.latestGenerationHash
  ) {
    throw new Error("codex_rotating_e2e_generation_hash_did_not_change");
  }
  if (
    !Number.isSafeInteger(completedRun.attempt) ||
    completedRun.attempt <= 0
  ) {
    throw new Error("codex_rotating_e2e_workflow_run_attempt_invalid");
  }
  await assertCompletedVersionedWritebackForRun({
    providerInstanceId: input.providerInstanceId,
    githubRepositoryId: input.githubRepositoryId,
    githubRunId: String(completedRun.databaseId),
    githubRunAttempt: String(completedRun.attempt),
    expectedGeneration: provider.latestGeneration,
    expectedGenerationHash: provider.latestGenerationHash,
    previousGenerationHash: input.previousProviderState.latestGenerationHash,
    previousActiveNamespace: input.previousProviderState.activeNamespace,
    activeNamespace: provider.activeNamespace,
  });
  if (
    !(await isRotatingWorkflowCurrentOnDefaultBranch(
      input.defaultBranch,
      input.providerInstanceId,
      input.githubRepositoryId,
      provider.activeNamespace,
    ))
  ) {
    throw new Error("codex_rotating_e2e_runtime_workflow_not_current_v4");
  }
  assertRetiredStableSecretAbsent();
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
    advisoryCommentId: advisoryComment?.id ?? null,
    inlineCommentCount: inlineComments.length,
  };
}

function writeReviewFixture(
  repoWorkdir: string,
  label: string,
): { readonly paths: readonly string[] } {
  if (reviewMode === "finding") {
    writeFileSync(
      join(repoWorkdir, "db.js"),
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
      join(repoWorkdir, "auth.js"),
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
        `export const e2eRunLabel = ${JSON.stringify(label)};`,
        "",
      ].join("\n"),
    );
    return { paths: ["db.js", "auth.js"] };
  }

  const fixturePath = `codex-rotating-e2e-${label}.md`;
  writeFileSync(
    join(repoWorkdir, fixturePath),
    [
      `# Codex rotating OAuth E2E ${label}`,
      "",
      "This file intentionally changes between E2E runs so GitHub Actions starts a same-repository pull request workflow.",
      `Run label: ${label}`,
      `Timestamp: ${new Date().toISOString()}`,
      "",
    ].join("\n"),
  );
  return { paths: [fixturePath] };
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
        "attempt,databaseId,status,conclusion,url,headSha",
      ]),
    ) as WorkflowRunView[];
    if (runs[0]) return runs[0];
    await sleep(3_000);
  }
  throw new Error(
    `ReviewRouter Codex rotating run did not start for branch ${branch}`,
  );
}

async function waitForRunCompletion(
  expected: WorkflowRunView,
): Promise<WorkflowRunView> {
  assertWorkflowRunIdentity(expected, expected);
  const deadline = Date.now() + runTimeoutMs;
  while (Date.now() < deadline) {
    const observed = await getRun(expected.databaseId, expected.attempt);
    assertWorkflowRunIdentity(expected, observed);
    if (observed.status === "completed") return observed;
    await sleep(3_000);
  }
  throw new Error(
    `ReviewRouter Codex rotating run did not complete: run=${expected.databaseId} attempt=${expected.attempt}`,
  );
}

function assertWorkflowRunIdentity(
  expected: WorkflowRunView,
  observed: WorkflowRunView,
): void {
  if (
    !Number.isSafeInteger(expected.databaseId) ||
    expected.databaseId <= 0 ||
    !Number.isSafeInteger(expected.attempt) ||
    expected.attempt <= 0 ||
    !/^[a-f0-9]{40}$/i.test(expected.headSha) ||
    observed.databaseId !== expected.databaseId ||
    observed.attempt !== expected.attempt ||
    observed.headSha.toLowerCase() !== expected.headSha.toLowerCase()
  ) {
    throw new Error("codex_rotating_e2e_workflow_run_identity_changed");
  }
}

async function getRun(
  databaseId: number,
  attempt: number,
): Promise<WorkflowRunView> {
  return JSON.parse(
    run("gh", [
      "run",
      "view",
      String(databaseId),
      "--repo",
      targetRepo,
      "--attempt",
      String(attempt),
      "--json",
      "attempt,databaseId,status,conclusion,url,headSha",
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
    if (comment) {
      assertGitHubAppCommentAuthor({
        actualLogin: comment.user.login,
        expectedLogin: expectedCommentAuthor,
        surface: "advisory",
      });
      return comment;
    }
    await sleep(3_000);
  }
  throw new Error("ReviewRouter rotating advisory comment was not posted");
}

async function waitForReviewRouterInlineComments(
  prNumber: number,
): Promise<ReviewCommentView[]> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const comments = JSON.parse(
      run("gh", ["api", `repos/${targetRepo}/pulls/${prNumber}/comments`]),
    ) as ReviewCommentView[];
    const markerComments = comments.filter((comment) =>
      comment.body.includes("<!-- review-router-inline:"),
    );
    for (const comment of markerComments) {
      assertGitHubAppCommentAuthor({
        actualLogin: comment.user.login,
        expectedLogin: expectedCommentAuthor,
        surface: "inline",
      });
    }
    const reviewRouterComments = markerComments.filter(
      isExpectedReviewRouterFinding,
    );
    if (reviewRouterComments.length > 0) return reviewRouterComments;
    await sleep(3_000);
  }
  throw new Error("ReviewRouter rotating inline finding was not posted");
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

async function readProviderState(providerInstanceId: string): Promise<{
  readonly latestGeneration: number;
  readonly latestGenerationHash: string;
  readonly state: string;
  readonly completedWritebacks: number;
  readonly activeNamespace: VersionedProviderSecretNamespace;
}> {
  const provider = await withPrismaConnectionRetry("read-provider-state", () =>
    prisma.codexOAuthProviderInstance.findUnique({
      where: { providerInstanceId },
      select: {
        latestGeneration: true,
        latestGenerationHash: true,
        state: true,
        activeSecretNamespaceId: true,
        activeSecretNamespaceEpoch: true,
        activeSecretNamespaceName: true,
        activeSecretNamespace: {
          select: {
            id: true,
            githubRepositoryId: true,
            namespaceEpoch: true,
            secretName: true,
            status: true,
            permanentlyRetired: true,
          },
        },
      },
    }),
  );
  if (!provider) {
    throw new Error("codex_rotating_provider_missing_after_setup");
  }
  if (provider.state !== "active") {
    throw new Error(`codex_rotating_provider_not_active:${provider.state}`);
  }
  if (!provider.latestGenerationHash) {
    throw new Error("codex_rotating_e2e_generation_hash_missing");
  }
  const namespace = provider.activeSecretNamespace;
  if (
    !namespace ||
    namespace.status !== "active" ||
    namespace.permanentlyRetired ||
    provider.activeSecretNamespaceId !== namespace.id ||
    provider.activeSecretNamespaceEpoch !== namespace.namespaceEpoch ||
    provider.activeSecretNamespaceName !== namespace.secretName
  ) {
    throw new Error("codex_rotating_e2e_active_namespace_mismatch");
  }
  const completedWritebacks = await withPrismaConnectionRetry(
    "count-completed-writebacks",
    () =>
      prisma.codexOAuthWritebackIntent.count({
        where: { providerInstanceId, status: "completed" },
      }),
  );
  return {
    latestGeneration: provider.latestGeneration,
    latestGenerationHash: provider.latestGenerationHash,
    state: provider.state,
    completedWritebacks,
    activeNamespace: createVersionedProviderSecretNamespace({
      scope: {
        repositoryId: namespace.githubRepositoryId,
        providerInstanceId,
      },
      namespaceId: namespace.id,
      epoch: namespace.namespaceEpoch,
      name: namespace.secretName,
    }),
  };
}

async function assertCompletedVersionedWritebackForRun(input: {
  readonly providerInstanceId: string;
  readonly githubRepositoryId: string;
  readonly githubRunId: string;
  readonly githubRunAttempt: string;
  readonly expectedGeneration: number;
  readonly expectedGenerationHash: string;
  readonly previousGenerationHash: string;
  readonly previousActiveNamespace: VersionedProviderSecretNamespace;
  readonly activeNamespace: VersionedProviderSecretNamespace;
}): Promise<void> {
  if (
    input.activeNamespace.namespaceId ===
      input.previousActiveNamespace.namespaceId ||
    input.activeNamespace.name === input.previousActiveNamespace.name ||
    input.activeNamespace.epoch <= input.previousActiveNamespace.epoch
  ) {
    throw new Error("codex_rotating_e2e_namespace_did_not_advance");
  }
  const intents = await withPrismaConnectionRetry(
    "read-run-completed-versioned-writeback",
    () =>
      prisma.codexOAuthWritebackIntent.findMany({
        where: {
          providerInstanceId: input.providerInstanceId,
          status: "completed",
          lease: {
            githubRunId: input.githubRunId,
            githubRunAttempt: input.githubRunAttempt,
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 2,
        select: {
          leaseId: true,
          generation: true,
          latestGenerationHash: true,
          mutationEpoch: true,
          dispatchAttemptId: true,
          secretNamespaceId: true,
          dispatchAuthorizedAt: true,
          providerResponseCode: true,
          providerConfirmedAt: true,
          completedAt: true,
          databaseIncarnation: true,
          databaseRecoveryWitness: true,
          lease: {
            select: {
              id: true,
              githubRunId: true,
              githubRunAttempt: true,
              status: true,
              restoredGenerationHash: true,
              nextGeneration: true,
              completedAt: true,
              mutationEpoch: true,
              secretNamespaceId: true,
              secretNamespaceEpoch: true,
            },
          },
          secretNamespace: {
            select: {
              id: true,
              githubRepositoryId: true,
              namespaceEpoch: true,
              secretName: true,
              status: true,
              permanentlyRetired: true,
              workflowPath: true,
              workflowSourceCommitSha: true,
              workflowSourceBlobSha: true,
              workflowSourceSha256: true,
              workflowSemanticSha256: true,
              workflowSourceTrust: true,
              attestedRepositoryId: true,
            },
          },
        },
      }),
  );
  const intent = intents.length === 1 ? intents[0]! : null;
  if (
    !intent ||
    intent.generation !== input.expectedGeneration ||
    intent.latestGenerationHash !== input.expectedGenerationHash ||
    intent.latestGenerationHash === input.previousGenerationHash ||
    !intent.dispatchAttemptId ||
    !intent.secretNamespaceId ||
    !intent.dispatchAuthorizedAt ||
    ![201, 204].includes(intent.providerResponseCode ?? 0) ||
    !intent.providerConfirmedAt ||
    !intent.completedAt ||
    !intent.databaseIncarnation ||
    !intent.databaseRecoveryWitness ||
    intent.dispatchAuthorizedAt > intent.providerConfirmedAt ||
    intent.providerConfirmedAt > intent.completedAt
  ) {
    throw new Error("codex_rotating_e2e_writeback_proof_incomplete");
  }
  if (
    intent.leaseId !== intent.lease.id ||
    intent.lease.githubRunId !== input.githubRunId ||
    intent.lease.githubRunAttempt !== input.githubRunAttempt ||
    intent.lease.status !== "completed" ||
    intent.lease.restoredGenerationHash !== input.previousGenerationHash ||
    intent.lease.nextGeneration !== input.expectedGeneration ||
    intent.mutationEpoch === null ||
    intent.lease.mutationEpoch !== intent.mutationEpoch ||
    !intent.lease.completedAt ||
    intent.lease.completedAt.getTime() !== intent.completedAt.getTime() ||
    intent.lease.secretNamespaceId !== input.activeNamespace.namespaceId ||
    intent.lease.secretNamespaceEpoch !== input.activeNamespace.epoch
  ) {
    throw new Error("codex_rotating_e2e_writeback_lease_proof_incomplete");
  }
  const namespace = intent.secretNamespace;
  if (
    !namespace ||
    intent.secretNamespaceId !== namespace.id ||
    namespace.githubRepositoryId !== input.githubRepositoryId ||
    namespace.status !== "active" ||
    namespace.permanentlyRetired ||
    namespace.workflowPath !== defaultCodexRotatingWorkflowPath ||
    !namespace.workflowSourceCommitSha ||
    !namespace.workflowSourceBlobSha ||
    !namespace.workflowSourceSha256 ||
    !namespace.workflowSemanticSha256 ||
    namespace.workflowSourceTrust !==
      WorkflowSourceTrust.TrustedDefaultBranchRevision ||
    namespace.attestedRepositoryId !== input.githubRepositoryId
  ) {
    throw new Error("codex_rotating_e2e_writeback_namespace_proof_incomplete");
  }
  assertSameVersionedProviderSecretNamespace({
    expected: input.activeNamespace,
    actual: createVersionedProviderSecretNamespace({
      scope: {
        repositoryId: namespace.githubRepositoryId,
        providerInstanceId: input.providerInstanceId,
      },
      namespaceId: namespace.id,
      epoch: namespace.namespaceEpoch,
      name: namespace.secretName,
    }),
  });
  const previousNamespace = await withPrismaConnectionRetry(
    "read-retired-prior-versioned-namespace",
    () =>
      prisma.codexOAuthSecretNamespace.findUnique({
        where: { id: input.previousActiveNamespace.namespaceId },
        select: {
          id: true,
          githubRepositoryId: true,
          namespaceEpoch: true,
          secretName: true,
          status: true,
          permanentlyRetired: true,
          retiredAt: true,
          providerInstance: { select: { providerInstanceId: true } },
        },
      }),
  );
  if (
    !previousNamespace ||
    previousNamespace.id !== input.previousActiveNamespace.namespaceId ||
    previousNamespace.githubRepositoryId !== input.githubRepositoryId ||
    previousNamespace.namespaceEpoch !== input.previousActiveNamespace.epoch ||
    previousNamespace.secretName !== input.previousActiveNamespace.name ||
    previousNamespace.providerInstance.providerInstanceId !==
      input.providerInstanceId ||
    previousNamespace.status !== "retired_superseded" ||
    !previousNamespace.permanentlyRetired ||
    !previousNamespace.retiredAt
  ) {
    throw new Error("codex_rotating_e2e_prior_namespace_not_retired");
  }
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
    /codex_claim_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/i,
  ];
  const match = forbidden.find((pattern) => pattern.test(logs));
  if (match) {
    throw new Error(
      `Codex rotating E2E logs contain forbidden auth material pattern: ${match.source}`,
    );
  }
}

function assertRetiredStableSecretAbsent(): void {
  const secrets = JSON.parse(
    run("gh", ["secret", "list", "--repo", targetRepo, "--json", "name"]),
  ) as Array<{ readonly name?: string }>;
  if (
    secrets.some((secret) => secret.name === "REVIEWROUTER_CODEX_AUTH_JSON")
  ) {
    throw new Error("codex_rotating_e2e_retired_stable_secret_present");
  }
}

function assertLiveE2EMutationAuthorized(): void {
  if (process.env.REVIEW_ROUTER_RUN_SUBSCRIPTION_RUNTIME_LIVE_E2E !== "1") {
    throw new Error(
      "codex_rotating_e2e_mutation_opt_in_required: set REVIEW_ROUTER_RUN_SUBSCRIPTION_RUNTIME_LIVE_E2E=1",
    );
  }
  if (!/(^rr-|reviewrouter|e2e|smoke|test|disposable)/i.test(repoName)) {
    throw new Error(
      `codex_rotating_e2e_disposable_repository_required:${targetRepo}`,
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
    allowlist.length !== 1 ||
    !allowlist.includes(repositoryFullName.toLowerCase())
  ) {
    throw new Error(
      [
        `codex_rotating_e2e_repo_not_enabled:${repositoryFullName}`,
        "Set REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH=1 for both the E2E process and the deployed API handling the GitHub runner, and put exactly this one disposable target in REVIEW_ROUTER_CODEX_ROTATING_OAUTH_REPOSITORIES.",
      ].join(" "),
    );
  }
}

function parseVisibility(input: string): RepositoryVisibility {
  if (input === "public" || input === "private") {
    return input;
  }
  throw new Error(
    "REVIEW_ROUTER_CODEX_ROTATING_E2E_VISIBILITY must be public or private",
  );
}

function parseReviewMode(input: string): ReviewMode {
  if (input === "clean" || input === "finding") {
    return input;
  }
  throw new Error(
    "REVIEW_ROUTER_CODEX_ROTATING_E2E_REVIEW_MODE must be clean or finding",
  );
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
  if (isLoopbackHostname(parsed.hostname)) {
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

function runSensitiveInstallerCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "inherit", "inherit"],
    });
    const timeout = setTimeout(
      () => {
        child.kill("SIGTERM");
        reject(new Error("codex_rotating_e2e_installer_timeout"));
      },
      Number(
        process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_SETUP_TIMEOUT_MS ?? 90_000,
      ),
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error("codex_rotating_e2e_installer_failed", { cause: error }),
      );
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      if (status === 0) resolve();
      else
        reject(
          new Error(
            `codex_rotating_e2e_installer_failed:status=${status ?? "unknown"}`,
          ),
        );
    });
    child.stdin.end(command);
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

function trace(stage: string): void {
  if (process.env.REVIEW_ROUTER_CODEX_ROTATING_E2E_TRACE !== "1") return;
  console.log(`[codex-rotating-live-e2e] ${stage}`);
}

async function withPrismaConnectionRetry<T>(
  operation: string,
  runOperation: () => Promise<T>,
): Promise<T> {
  try {
    return await runOperation();
  } catch (error) {
    if (!isRetriablePrismaConnectionError(error)) throw error;
    trace(`db-reconnect:${operation}`);
    await prisma.$disconnect().catch(() => undefined);
    prisma = createPrismaClient();
    return await runOperation();
  }
}

function isRetriablePrismaConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Connection terminated unexpectedly") ||
    message.includes("Can't reach database server")
  );
}
