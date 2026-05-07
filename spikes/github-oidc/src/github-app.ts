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
  try {
    const response = await app.octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner, repo },
    );
    return response.data.id;
  } catch (error: unknown) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : 0;
    if (status === 404) return null;
    throw error;
  }
}
