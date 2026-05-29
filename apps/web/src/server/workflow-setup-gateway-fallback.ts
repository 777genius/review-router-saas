import type {
  WorkflowSetupGatewayInput,
  WorkflowSetupGatewayPort,
  WorkflowSetupPullRequest,
} from "@reviewrouter/features-workflow-provisioning";

export type AppFirstWorkflowSetupGatewayOptions = {
  readonly primary: WorkflowSetupGatewayPort;
  readonly fallback?: (() => Promise<WorkflowSetupGatewayPort>) | undefined;
  readonly onFallback?:
    | ((input: {
        readonly reason: string;
        readonly error: unknown;
      }) => Promise<void>)
    | undefined;
};

export class AppFirstWorkflowSetupGateway implements WorkflowSetupGatewayPort {
  private fallbackGateway: Promise<WorkflowSetupGatewayPort> | null = null;

  constructor(private readonly options: AppFirstWorkflowSetupGatewayOptions) {}

  async createOrUpdateSetupPullRequest(
    input: WorkflowSetupGatewayInput,
  ): Promise<WorkflowSetupPullRequest> {
    try {
      return await this.options.primary.createOrUpdateSetupPullRequest(input);
    } catch (error: unknown) {
      if (!this.options.fallback || !isRecoverableAppSetupWriteFailure(error)) {
        throw error;
      }

      const reason = safeWorkflowSetupFallbackReason(error);
      await this.options.onFallback?.({ reason, error });
      return (await this.getFallbackGateway()).createOrUpdateSetupPullRequest(
        input,
      );
    }
  }

  private getFallbackGateway(): Promise<WorkflowSetupGatewayPort> {
    this.fallbackGateway ??= this.options.fallback!();
    return this.fallbackGateway;
  }
}

export function isRecoverableAppSetupWriteFailure(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== 403 && status !== 404) {
    return false;
  }
  return !isGitHubRateLimitError(error);
}

export function safeWorkflowSetupFallbackReason(error: unknown): string {
  const status = getErrorStatus(error);
  return status === 404
    ? "github_app_repo_not_accessible"
    : "github_app_write_forbidden";
}

function getErrorStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { readonly status?: unknown }).status)
    : 0;
}

function isGitHubRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /rate limit|secondary rate|abuse/i.test(message);
}
