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
      const expectedContentMarkersFound =
        workflowContainsExpectedMarkerGroup(
          yaml,
          input.expectedContentMarkerGroups,
        ) &&
        workflowPassesExpectedContentValidator(
          yaml,
          input.expectedContentValidator,
        );
      return {
        status: "present",
        expectedActionRefFound: workflowUsesActionRef(
          yaml,
          input.expectedActionRef,
        ),
        ...(input.expectedContentMarkerGroups !== undefined ||
        input.expectedContentValidator !== undefined
          ? { expectedContentMarkersFound }
          : {}),
      };
    } catch (error) {
      if (getErrorStatus(error) === 404) {
        return { status: "missing" };
      }
      return { status: "unavailable", reason: safeProbeErrorReason(error) };
    }
  }
}

function workflowPassesExpectedContentValidator(
  yaml: string,
  validator?: (workflow: string) => boolean,
): boolean {
  if (!validator) return true;

  try {
    return validator(yaml);
  } catch {
    return false;
  }
}

function workflowContainsExpectedMarkerGroup(
  yaml: string,
  markerGroups?: readonly (readonly string[])[],
): boolean {
  if (!markerGroups || markerGroups.length === 0) {
    return true;
  }
  return markerGroups.some((markers) =>
    markers.every((marker) => yaml.includes(marker)),
  );
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
  const acceptedRefs = new Set([
    expectedActionRef,
    ...expectedReusableWorkflowRefs(expectedActionRef),
  ]);
  return yaml.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return false;
    }
    const usesMatch = trimmed.match(/^-?\s*uses:\s*["']?([^"'\s#]+)["']?/);
    return usesMatch?.[1] ? acceptedRefs.has(usesMatch[1]) : false;
  });
}

function expectedReusableWorkflowRefs(actionRef: string): readonly string[] {
  const match = /^777genius\/review-router@(.+)$/.exec(actionRef);
  if (!match) {
    return [];
  }
  const runtimeRef = match[1] ?? "";
  if (!/^(main|v1|v1\.[0-9]+\.[0-9]+|[a-fA-F0-9]{40})$/.test(runtimeRef)) {
    return [];
  }
  return [
    `777genius/review-router/.github/workflows/reviewrouter-reusable.yml@${runtimeRef}`,
    `777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@${runtimeRef}`,
  ];
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
