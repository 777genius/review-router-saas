import {
  canonicalHostedPoolProviderInstanceId,
  defaultCodexRotatingWorkflowPath,
  readCanonicalHostedPoolWorkflowMetadata,
} from "@reviewrouter/features-workflow-provisioning";

/** This preflight decides whether setup is needed; only the exact verifier may activate. */
export async function hasMatchingHostedPoolWorkflow(input: {
  readonly repository: {
    owner: string;
    name: string;
    defaultBranch: string;
    githubRepositoryId: string;
  };
  readonly octokit: {
    request(
      route: string,
      parameters?: Record<string, unknown>,
    ): Promise<{ data: unknown }>;
  };
  readonly binding: { bindingId: string; revision: number };
  readonly actionRef: string;
  readonly apiUrl: string;
}): Promise<boolean> {
  let data: unknown;
  try {
    ({ data } = await input.octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: input.repository.owner,
        repo: input.repository.name,
        path: defaultCodexRotatingWorkflowPath,
        ref: input.repository.defaultBranch,
      },
    ));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 404
    )
      return false;
    throw error;
  }
  if (
    typeof data !== "object" ||
    data === null ||
    !("content" in data) ||
    !("encoding" in data) ||
    data.encoding !== "base64" ||
    typeof data.content !== "string"
  )
    return false;
  let metadata: ReturnType<typeof readCanonicalHostedPoolWorkflowMetadata>;
  try {
    metadata = readCanonicalHostedPoolWorkflowMetadata(
      Buffer.from(data.content, "base64").toString("utf8"),
    );
  } catch {
    return false;
  }
  return (
    metadata.bindingId === input.binding.bindingId &&
    metadata.bindingRevision === input.binding.revision &&
    metadata.apiUrl === input.apiUrl &&
    metadata.actionRef === input.actionRef &&
    metadata.providerInstanceId ===
      canonicalHostedPoolProviderInstanceId(input.repository.githubRepositoryId)
  );
}
