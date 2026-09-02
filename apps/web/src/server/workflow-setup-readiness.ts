import type { RepositoryWorkflowProbePort } from "@reviewrouter/features-repo-health";
import type { ProviderKind } from "@reviewrouter/features-review-providers";
import {
  assertSameVersionedProviderSecretNamespace,
  type CodexRotatingReviewActionV2Mode,
  type CodexRotatingT0WorkflowSchemaVersion,
  type VersionedProviderSecretNamespace,
  defaultCodexRotatingWorkflowPath,
  defaultWorkflowPath,
  getCodexRotatingWorkflowSetupContentMarkerGroups,
  getWorkflowSetupContentMarkerGroups,
  isVersionedSecretNamespaceCodexWorkflowSchemaVersion,
  readCanonicalCodexRotatingT0WorkflowSourceMetadata,
  scanCodexRotatingAdvisoryWorkflow,
  type ReviewRouterDiscussionMode,
} from "@reviewrouter/features-workflow-provisioning";

export type WorkflowSetupReadinessInput = {
  readonly githubInstallationId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly actionRef: string;
  readonly providerKind?: ProviderKind;
  readonly discussionMode?: ReviewRouterDiscussionMode;
  readonly conflictReviewFallbackEnabled?: boolean;
  readonly forkAgenticSandboxEnabled?: boolean;
  readonly codexRotatingProviderInstanceId?: string;
  readonly codexRotatingClaudeCodeOAuthTokenSecret?: boolean;
  readonly codexRotatingOpenRouterApiKeySecret?: boolean;
  readonly codexRotatingReviewActionV2Mode?: CodexRotatingReviewActionV2Mode;
  readonly codexRotatingWorkflowSchemaVersion?: CodexRotatingT0WorkflowSchemaVersion;
  readonly codexRotatingWorkflowSecretNamespace?: VersionedProviderSecretNamespace;
};

export async function isWorkflowSetupAlreadyCurrent(
  input: WorkflowSetupReadinessInput,
  dependencies: {
    readonly workflowProbe: RepositoryWorkflowProbePort;
  },
): Promise<boolean> {
  if (input.discussionMode === "suggest") {
    return false;
  }

  const workflowCheck = await dependencies.workflowProbe.probeWorkflow({
    githubInstallationId: input.githubInstallationId,
    owner: input.owner,
    name: input.name,
    defaultBranch: input.defaultBranch,
    workflowPath: input.codexRotatingProviderInstanceId
      ? defaultCodexRotatingWorkflowPath
      : defaultWorkflowPath,
    expectedActionRef: input.actionRef,
    ...(input.codexRotatingProviderInstanceId
      ? {
          expectedContentMarkerGroups:
            getCodexRotatingWorkflowSetupContentMarkerGroups({
              providerInstanceId: input.codexRotatingProviderInstanceId,
              claudeCodeOAuthTokenSecret:
                input.codexRotatingClaudeCodeOAuthTokenSecret === true,
              openRouterApiKeySecret:
                input.codexRotatingOpenRouterApiKeySecret === true,
              forkAgenticSandboxEnabled:
                input.forkAgenticSandboxEnabled === true,
              reviewActionV2Mode: input.codexRotatingReviewActionV2Mode,
              workflowSchemaVersion: input.codexRotatingWorkflowSchemaVersion,
              ...(input.codexRotatingWorkflowSecretNamespace
                ? {
                    activeSecretNamespace:
                      input.codexRotatingWorkflowSecretNamespace,
                  }
                : {}),
            }),
          ...(isVersionedSecretNamespaceCodexWorkflowSchemaVersion(
            input.codexRotatingWorkflowSchemaVersion,
          ) && input.codexRotatingWorkflowSecretNamespace
            ? {
                expectedContentValidator: (workflow: string) =>
                  isCanonicalVersionedCodexWorkflowReady({
                    workflow,
                    expectedActionRef: input.actionRef,
                    expectedProviderInstanceId:
                      input.codexRotatingProviderInstanceId!,
                    expectedWorkflowSchemaVersion:
                      input.codexRotatingWorkflowSchemaVersion!,
                    expectedSecretNamespace:
                      input.codexRotatingWorkflowSecretNamespace!,
                  }),
              }
            : {}),
        }
      : input.providerKind || input.conflictReviewFallbackEnabled === true
        ? {
            expectedContentMarkerGroups: getWorkflowSetupContentMarkerGroups({
              providerKind: input.providerKind,
              conflictReviewFallbackEnabled:
                input.conflictReviewFallbackEnabled === true,
            }),
          }
        : {}),
  });

  return (
    workflowCheck.status === "present" &&
    workflowCheck.expectedActionRefFound &&
    (workflowCheck.expectedContentMarkersFound ?? true)
  );
}

function isCanonicalVersionedCodexWorkflowReady(input: {
  readonly workflow: string;
  readonly expectedActionRef: string;
  readonly expectedProviderInstanceId: string;
  readonly expectedWorkflowSchemaVersion: CodexRotatingT0WorkflowSchemaVersion;
  readonly expectedSecretNamespace: VersionedProviderSecretNamespace;
}): boolean {
  try {
    if (!scanCodexRotatingAdvisoryWorkflow(input.workflow).valid) {
      return false;
    }
    const metadata = readCanonicalCodexRotatingT0WorkflowSourceMetadata(
      input.workflow,
    );
    if (
      metadata.actionRef !== input.expectedActionRef ||
      metadata.providerInstanceId !== input.expectedProviderInstanceId ||
      metadata.workflowSchemaVersion !== input.expectedWorkflowSchemaVersion ||
      !metadata.secretNamespace
    ) {
      return false;
    }
    assertSameVersionedProviderSecretNamespace({
      expected: input.expectedSecretNamespace,
      actual: metadata.secretNamespace,
    });
    return true;
  } catch {
    return false;
  }
}
