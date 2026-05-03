import { OctokitRepositoryWorkflowProbe } from "../../../packages/features/repo-health/src/index.ts";
import { createGitHubApp, findInstallationForRepo } from "./github-app.js";
import { loadAppProfile, loadEnvFiles, requiredEnv } from "./config.js";

loadEnvFiles();

const targetRepo = requiredEnv("REVIEW_ROUTER_TARGET_REPO");
const [owner, repo] = targetRepo.split("/");
if (!owner || !repo) {
  throw new Error("REVIEW_ROUTER_TARGET_REPO must be owner/repo");
}

const expectedActionRef =
  process.env.REVIEW_ROUTER_ACTION_REF ?? "777genius/review-router@v1";
const workflowPath =
  process.env.REVIEW_ROUTER_WORKFLOW_PATH ??
  ".github/workflows/reviewrouter.yml";
const defaultBranch = process.env.REVIEW_ROUTER_TARGET_BRANCH ?? "main";
const profile = loadAppProfile();
const app = createGitHubApp(profile);
const installationId = process.env.REVIEW_ROUTER_INSTALLATION_ID
  ? Number(process.env.REVIEW_ROUTER_INSTALLATION_ID)
  : await findInstallationForRepo(app, owner, repo);

if (!installationId) {
  throw new Error(`ReviewRouter App is not installed on ${targetRepo}`);
}

const probe = new OctokitRepositoryWorkflowProbe({
  createRequester: async (githubInstallationId) =>
    app.getInstallationOctokit(Number(githubInstallationId)),
});

const check = await probe.probeWorkflow({
  githubInstallationId: String(installationId),
  owner,
  name: repo,
  defaultBranch,
  workflowPath,
  expectedActionRef,
});

console.log(
  JSON.stringify(
    {
      ok: true,
      targetRepo,
      installationId,
      defaultBranch,
      workflowPath,
      expectedActionRef,
      check,
    },
    null,
    2,
  ),
);
