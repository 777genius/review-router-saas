import { execFileSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";
import {
  OctokitWorkflowSetupGateway,
  PrismaWorkflowProvisioningRepository,
  provisionReviewRouterWorkflow,
} from "../../../packages/features/workflow-provisioning/src/index.ts";
import { createGitHubApp, findInstallationForRepo } from "./github-app.js";
import { loadAppProfile, loadEnvFiles, requiredEnv } from "./config.js";

loadEnvFiles();

const targetRepo = requiredEnv("REVIEW_ROUTER_TARGET_REPO");
const [owner, repo] = targetRepo.split("/");
if (!owner || !repo)
  throw new Error("REVIEW_ROUTER_TARGET_REPO must be owner/repo");

const actionRef =
  process.env.REVIEW_ROUTER_ACTION_REF ?? "777genius/review-router@v1";
const apiUrl = process.env.REVIEW_ROUTER_API_URL ?? "http://localhost:4000";
const setupAuth =
  process.env.REVIEW_ROUTER_SETUP_AUTH === "gh-user" ? "gh-user" : "app";
const profile = loadAppProfile();
const app = createGitHubApp(profile);

function createUserOctokit(): Octokit {
  const token = execFileSync("gh", ["auth", "token"], {
    encoding: "utf8",
  }).trim();
  if (!token) throw new Error("gh auth token returned an empty token");
  return new Octokit({ auth: token });
}

const installationId = process.env.REVIEW_ROUTER_INSTALLATION_ID
  ? Number(process.env.REVIEW_ROUTER_INSTALLATION_ID)
  : await findInstallationForRepo(app, owner, repo);

if (!installationId) {
  throw new Error(`ReviewRouter App is not installed on ${targetRepo}`);
}

const octokit =
  setupAuth === "gh-user"
    ? createUserOctokit()
    : await app.getInstallationOctokit(installationId);
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
    },
  });

  if (!repository) {
    throw new Error(
      `Repository ${targetRepo} is not synced. Run spike:github:sync-repositories first.`,
    );
  }

  const pullRequest = await provisionReviewRouterWorkflow(
    {
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
      actionRef,
      apiUrl,
      runtimeConfigMode: "oidc",
    },
    {
      setupGateway: new OctokitWorkflowSetupGateway(octokit),
      provisioning: new PrismaWorkflowProvisioningRepository(prisma),
    },
  );

  console.log(
    JSON.stringify(
      { targetRepo, setupAuth, installationId, pullRequest },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
