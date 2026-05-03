import { loadAppProfile, loadEnvFiles } from "./config.js";
import { createGitHubApp } from "./github-app.js";

loadEnvFiles();
const profile = loadAppProfile();
const app = createGitHubApp(profile);
const { data } = await app.octokit.request("GET /app/installations", {
  per_page: 100,
});

console.log(
  JSON.stringify(
    {
      appId: profile.APP_ID,
      appSlug: profile.APP_SLUG,
      installations: data.map((installation) => ({
        id: installation.id,
        account: installation.account?.login,
        accountType: installation.account?.type,
        repositorySelection: installation.repository_selection,
        permissions: installation.permissions,
      })),
    },
    null,
    2,
  ),
);
