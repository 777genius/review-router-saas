import {
  renderCanonicalCodexRotatingT0WorkflowV5,
  readCanonicalCodexRotatingT0WorkflowSourceMetadata,
} from "@reviewrouter/features-codex-oauth-rotating";
import type { ZeroLoginRolloverSetupPullRequestPort } from "@reviewrouter/features-action-control-plane";
import {
  defaultCodexRotatingWorkflowPath,
  type WorkflowSetupGatewayPort,
} from "@reviewrouter/features-workflow-provisioning";

export interface ZeroLoginDefaultBranchHeadPort {
  readDefaultBranch(input: {
    repository: Parameters<
      ZeroLoginRolloverSetupPullRequestPort["createOrUpdateExactSetupPullRequest"]
    >[0]["repository"];
  }): Promise<{ name: string; headSha: string; workflowSource: string }>;
  verifySetupPullRequest(input: {
    repository: Parameters<
      ZeroLoginRolloverSetupPullRequestPort["createOrUpdateExactSetupPullRequest"]
    >[0]["repository"];
    number: number;
    expectedBaseBranch: string;
    expectedBaseSha: string;
    expectedWorkflowPath: string;
    expectedWorkflowSource: string;
  }): Promise<{ headSha: string }>;
}

export class CodexZeroLoginRolloverSetupPullRequestPublisher
  implements ZeroLoginRolloverSetupPullRequestPort
{
  constructor(
    private readonly setupGateway: (
      repository: Parameters<
        ZeroLoginRolloverSetupPullRequestPort["createOrUpdateExactSetupPullRequest"]
      >[0]["repository"],
    ) => Promise<WorkflowSetupGatewayPort>,
    private readonly defaultBranch: ZeroLoginDefaultBranchHeadPort,
    private readonly apiUrl: string,
  ) {}

  async createOrUpdateExactSetupPullRequest(
    input: Parameters<
      ZeroLoginRolloverSetupPullRequestPort["createOrUpdateExactSetupPullRequest"]
    >[0],
  ) {
    if (input.targetWorkflowSchemaVersion !== 5) {
      throw new Error("zero_login_rollover_target_schema_invalid");
    }
    const current = await this.defaultBranch.readDefaultBranch({
      repository: input.repository,
    });
    if (current.headSha !== input.expectedBaseSha) {
      throw new Error("zero_login_rollover_prepared_base_moved");
    }
    const currentMetadata =
      readCanonicalCodexRotatingT0WorkflowSourceMetadata(current.workflowSource);
    if (
      currentMetadata.providerInstanceId !== input.providerInstanceId ||
      currentMetadata.actionRef !== input.sourceActionRef ||
      (input.sourceActiveNamespaceId !== undefined &&
        currentMetadata.secretNamespace?.namespaceId !==
          input.sourceActiveNamespaceId)
    ) {
      throw new Error("zero_login_rollover_current_source_mismatch");
    }
    const actionCommitSha = input.targetActionRef.split("@")[1];
    if (!actionCommitSha || !/^[a-f0-9]{40}$/u.test(actionCommitSha)) {
      throw new Error("zero_login_rollover_target_action_not_pinned");
    }
    const source = renderCanonicalCodexRotatingT0WorkflowV5({
      actionRef: input.targetActionRef,
      apiUrl: this.apiUrl,
      providerInstanceId: input.providerInstanceId,
      activeSecretNamespace: input.candidate,
      refreshScheduleCron: readRefreshScheduleCron(current.workflowSource),
    });
    const metadata = readCanonicalCodexRotatingT0WorkflowSourceMetadata(source);
    if (
      metadata.workflowSchemaVersion !== 5 ||
      metadata.actionRef !== input.targetActionRef ||
      metadata.secretNamespace?.namespaceId !== input.candidate.namespaceId
    ) {
      throw new Error("zero_login_rollover_setup_pr_render_invalid");
    }
    const pullRequest = await (
      await this.setupGateway(input.repository)
    ).createOrUpdateSetupPullRequest({
      owner: input.repository.owner,
      repo: input.repository.fullName.split("/")[1]!,
      baseBranch: current.name,
      setupBranch: `reviewrouter/zero-login-rollover-${input.candidate.epoch}`,
      expectedBaseSha: input.expectedBaseSha,
      resetSetupBranch: true,
      workflowFiles: [
        { path: defaultCodexRotatingWorkflowPath, content: source },
      ],
    });
    const verified = await this.defaultBranch.verifySetupPullRequest({
      repository: input.repository,
      number: pullRequest.number,
      expectedBaseBranch: current.name,
      expectedBaseSha: current.headSha,
      expectedWorkflowPath: defaultCodexRotatingWorkflowPath,
      expectedWorkflowSource: source,
    });
    return {
      url: pullRequest.url,
      number: pullRequest.number,
      headSha: verified.headSha,
      baseBranch: pullRequest.baseBranch ?? current.name,
    };
  }
}

function readRefreshScheduleCron(source: string): string | null {
  const match = source.match(/^\s{4}- cron: ("(?:[^"\\]|\\.)*")$/mu);
  if (!match) return null;
  const value = JSON.parse(match[1]!) as unknown;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("zero_login_rollover_refresh_cron_invalid");
  }
  return value;
}
