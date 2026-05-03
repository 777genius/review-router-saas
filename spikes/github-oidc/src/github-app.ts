import { App } from "@octokit/app";
import type { AppProfile } from "./config.js";

export function createGitHubApp(profile: AppProfile): App {
  return new App({
    appId: profile.APP_ID,
    privateKey: profile.privateKey,
  });
}

export async function findInstallationForRepo(
  app: App,
  owner: string,
  repo: string,
): Promise<number | null> {
  const appOctokit = app.octokit;
  const { data: installations } = await appOctokit.request(
    "GET /app/installations",
    {
      per_page: 100,
    },
  );

  for (const installation of installations) {
    const installationOctokit = await app.getInstallationOctokit(
      installation.id,
    );
    try {
      await installationOctokit.request("GET /repos/{owner}/{repo}", {
        owner,
        repo,
      });
      return installation.id;
    } catch (error: unknown) {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? Number(error.status)
          : 0;
      if (status !== 404 && status !== 403) throw error;
    }
  }

  return null;
}
