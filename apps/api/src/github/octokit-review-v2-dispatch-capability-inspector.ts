import { App } from "@octokit/app";
import type { ReviewV2DispatchCapabilityInspectionPort } from "../review-action-v2-mutation-proof-facts.js";

type InstallationTokenResponse = {
  readonly token?: unknown;
  readonly expiresAt?: unknown;
  readonly permissions?: {
    readonly actions?: unknown;
  };
};

export class OctokitReviewV2DispatchCapabilityInspector implements ReviewV2DispatchCapabilityInspectionPort {
  private readonly app: App;

  constructor(options: {
    readonly appId: string;
    readonly privateKey: string;
  }) {
    this.app = new App(options);
  }

  async inspectReviewV2DispatchCapability(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
  }): Promise<{ readonly available: boolean }> {
    try {
      const result = (await this.app.octokit.auth({
        type: "installation",
        installationId: positiveSafeInteger(
          input.githubInstallationId,
          "review_v2_dispatch_installation_id_invalid",
        ),
        repositoryIds: [
          positiveSafeInteger(
            input.githubRepositoryId,
            "review_v2_dispatch_repository_id_invalid",
          ),
        ],
        permissions: { actions: "write" },
      })) as InstallationTokenResponse;

      if (result.permissions?.actions !== "write") {
        return { available: false };
      }
      if (
        typeof result.token !== "string" ||
        result.token.length === 0 ||
        typeof result.expiresAt !== "string" ||
        !Number.isFinite(new Date(result.expiresAt).getTime())
      ) {
        throw new Error("review_v2_dispatch_token_invalid_response");
      }
      return { available: true };
    } catch (error) {
      if (isUnavailablePermissionResponse(error)) {
        return { available: false };
      }
      throw error;
    }
  }
}

function positiveSafeInteger(value: string, code: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

function isUnavailablePermissionResponse(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return false;
  }
  const status = (error as { readonly status?: unknown }).status;
  return status === 403 || status === 404 || status === 422;
}
