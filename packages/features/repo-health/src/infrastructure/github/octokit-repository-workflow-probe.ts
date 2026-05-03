import { Buffer } from "node:buffer";
import type {
  RepositoryWorkflowCheck,
  RepositoryWorkflowProbeInput,
  RepositoryWorkflowProbePort,
} from "../../application/ports/repository-workflow-probe-port";

type GitHubRequester = {
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ readonly data: unknown }>;
};

export type OctokitRepositoryWorkflowProbeOptions = {
  readonly createRequester: (
    githubInstallationId: string,
  ) => Promise<GitHubRequester>;
};

export class OctokitRepositoryWorkflowProbe implements RepositoryWorkflowProbePort {
  constructor(
    private readonly options: OctokitRepositoryWorkflowProbeOptions,
  ) {}

  async probeWorkflow(
    input: RepositoryWorkflowProbeInput,
  ): Promise<RepositoryWorkflowCheck> {
    try {
      const requester = await this.options.createRequester(
        input.githubInstallationId,
      );
      const response = await requester.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: input.owner,
          repo: input.name,
          path: input.workflowPath,
          ref: input.defaultBranch,
        },
      );
      const yaml = decodeWorkflowFile(response.data);
      if (!yaml) {
        return { status: "unavailable", reason: "workflow_file_not_decodable" };
      }
      return {
        status: "present",
        expectedActionRefFound: workflowUsesActionRef(
          yaml,
          input.expectedActionRef,
        ),
      };
    } catch (error) {
      if (getErrorStatus(error) === 404) {
        return { status: "missing" };
      }
      return { status: "unavailable", reason: safeProbeErrorReason(error) };
    }
  }
}

function decodeWorkflowFile(data: unknown): string | null {
  if (Array.isArray(data) || typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as {
    readonly type?: unknown;
    readonly encoding?: unknown;
    readonly content?: unknown;
  };
  if (
    record.type !== "file" ||
    record.encoding !== "base64" ||
    typeof record.content !== "string"
  ) {
    return null;
  }
  return Buffer.from(record.content.replaceAll("\n", ""), "base64").toString(
    "utf8",
  );
}

function workflowUsesActionRef(
  yaml: string,
  expectedActionRef: string,
): boolean {
  return yaml.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return false;
    }
    const usesMatch = trimmed.match(/^-?\s*uses:\s*["']?([^"'\s#]+)["']?/);
    return usesMatch?.[1] === expectedActionRef;
  });
}

function getErrorStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { readonly status?: unknown }).status)
    : 0;
}

function safeProbeErrorReason(error: unknown): string {
  const status = getErrorStatus(error);
  if (status === 403) return "github_permission_denied";
  if (status === 429) return "github_rate_limited";
  if (status >= 500) return "github_unavailable";
  return "github_workflow_probe_failed";
}
