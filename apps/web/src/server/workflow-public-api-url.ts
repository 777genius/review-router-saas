import { resolveReviewRouterPublicApiUrl } from "@reviewrouter/platform-config";

export function resolveWorkflowPublicApiUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveReviewRouterPublicApiUrl(env);
}
