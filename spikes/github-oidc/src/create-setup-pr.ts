import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { loadAppProfile, loadEnvFiles, requiredEnv } from "./config.js";
import { createGitHubApp, findInstallationForRepo } from "./github-app.js";
import { renderSpikeWorkflow } from "./workflow-template.js";

loadEnvFiles();

const targetRepo = requiredEnv("REVIEW_ROUTER_TARGET_REPO");
const [ownerPart, repoPart] = targetRepo.split("/");
if (!ownerPart || !repoPart)
  throw new Error("REVIEW_ROUTER_TARGET_REPO must be owner/repo");
const owner = ownerPart;
const repo = repoPart;

const profile = loadAppProfile();
const app = createGitHubApp(profile);
const requestedSetupAuth =
  process.env.REVIEW_ROUTER_SETUP_AUTH === "gh-user" ? "gh-user" : "app";
type SetupAuth = "app" | "gh-user";
type GitHubRequester = {
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ data: any }>;
};

function getErrorStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : 0;
}

function createUserOctokit(): GitHubRequester {
  const token = execFileSync("gh", ["auth", "token"], {
    encoding: "utf8",
  }).trim();
  if (!token) throw new Error("gh auth token returned an empty token");
  return new Octokit({ auth: token });
}

async function createSetupOctokit(
  setupAuth: SetupAuth,
): Promise<{ octokit: GitHubRequester; installationId: number | null }> {
  const installationId = process.env.REVIEW_ROUTER_INSTALLATION_ID
    ? Number(process.env.REVIEW_ROUTER_INSTALLATION_ID)
    : await findInstallationForRepo(app, owner, repo);

  if (!installationId) {
    throw new Error(
      `ReviewRouter App is not installed on ${targetRepo}. Install ${profile.APP_NAME || profile.APP_SLUG || "the app"} for this repository first.`,
    );
  }

  if (setupAuth === "gh-user") {
    return { octokit: createUserOctokit(), installationId };
  }

  return {
    octokit: await app.getInstallationOctokit(installationId),
    installationId,
  };
}

async function createOrUpdateSetupPr(setupAuth: SetupAuth): Promise<void> {
  const { octokit, installationId } = await createSetupOctokit(setupAuth);
  const { data: repository } = await octokit.request(
    "GET /repos/{owner}/{repo}",
    { owner, repo },
  );
  const defaultBranch = repository.default_branch;
  const branch =
    process.env.REVIEW_ROUTER_SETUP_BRANCH || "reviewrouter/saas-spike";
  const path = ".github/workflows/reviewrouter-saas-spike.yml";
  const audience =
    process.env.REVIEW_ROUTER_OIDC_AUDIENCE || "review-router-spike";
  const endpointUrl = process.env.REVIEW_ROUTER_SPIKE_PUBLIC_URL || "";

  const { data: ref } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    {
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    },
  );
  const sha = Array.isArray(ref.object) ? ref.object[0]?.sha : ref.object.sha;

  try {
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  } catch (error: unknown) {
    const status = getErrorStatus(error);
    if (status !== 422) throw error;
  }

  let existingSha: string | undefined;
  try {
    const { data: existing } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner,
        repo,
        path,
        ref: branch,
      },
    );
    if (!Array.isArray(existing) && existing.type === "file")
      existingSha = existing.sha;
  } catch (error: unknown) {
    const status = getErrorStatus(error);
    if (status !== 404) throw error;
  }

  await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
    owner,
    repo,
    path,
    branch,
    sha: existingSha,
    message: "test: add ReviewRouter SaaS OIDC spike workflow",
    content: Buffer.from(
      renderSpikeWorkflow({ audience, endpointUrl }),
    ).toString("base64"),
  });

  const existingPrs = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "open",
  });

  const pr =
    existingPrs.data[0] ??
    (
      await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        title: "test: add ReviewRouter SaaS OIDC spike workflow",
        head: branch,
        base: defaultBranch,
        body: "Temporary spike PR for validating ReviewRouter SaaS GitHub App workflow provisioning and GitHub Actions OIDC claims. No secrets are added.",
      })
    ).data;

  console.log(
    JSON.stringify(
      {
        targetRepo,
        setupAuth,
        installationId,
        defaultBranch,
        branch,
        workflowPath: path,
        pullRequestUrl: pr.html_url,
      },
      null,
      2,
    ),
  );
}

try {
  await createOrUpdateSetupPr(requestedSetupAuth);
} catch (error: unknown) {
  const status = getErrorStatus(error);
  if (requestedSetupAuth === "app" && status === 403) {
    console.warn(
      "GitHub App setup token lacks repository write/workflow permissions. Falling back to gh user token for setup PR.",
    );
    await createOrUpdateSetupPr("gh-user");
  } else {
    throw error;
  }
}
