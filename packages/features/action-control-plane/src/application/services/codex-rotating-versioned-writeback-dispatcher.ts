import type {
  CodexRotatingGitHubSecretWriterPort,
  CodexRotatingVersionedWorkflowPublisherPort,
  CodexRotatingVersionedWritebackDispatcherPort,
  CodexRotatingVersionedWritebackLedgerPort,
} from "../ports/codex-rotating-oauth-repository-port.js";
import { isCodexRotatingSecretPutPreDispatchError } from "../ports/codex-rotating-oauth-repository-port.js";
import { RuntimeVersionedDurableMarker } from "@reviewrouter/features-codex-oauth-rotating";
import type {
  ZeroLoginRolloverLedgerPort,
  ZeroLoginRolloverSetupPullRequestPort,
} from "../ports/codex-zero-login-rollover-port.js";

/**
 * Coordinates the irreversible edges. The ledger authorizes exactly one name
 * before the provider call; every non-definite outcome tombstones that name.
 * Workflow publication and activation happen only after a definite 201/204.
 */
export class CodexRotatingVersionedWritebackDispatcher implements CodexRotatingVersionedWritebackDispatcherPort {
  constructor(
    private readonly ledger: CodexRotatingVersionedWritebackLedgerPort,
    private readonly provider: CodexRotatingGitHubSecretWriterPort,
    private readonly workflows: CodexRotatingVersionedWorkflowPublisherPort,
    _legacyClock?: unknown,
    private readonly rollover?: Readonly<{
      enabled: boolean;
      ledger: ZeroLoginRolloverLedgerPort;
      setupPullRequests: ZeroLoginRolloverSetupPullRequestPort;
    }>,
  ) {
    void _legacyClock;
  }

  async dispatchOneShot(
    input: Parameters<
      CodexRotatingVersionedWritebackDispatcherPort["dispatchOneShot"]
    >[0],
  ) {
    if (this.rollover) {
      const result = await this.dispatchRollover(input);
      if (result !== null) return result;
    }
    const claim = await this.ledger.prepareVersionedWriteback({
      ...input,
    });
    if (claim.status === "unchanged_generation") {
      return {
        status: "accepted" as const,
        generation: claim.generation,
      };
    }
    if (claim.status !== "ready") return claim;

    let response: { readonly statusCode: 201 | 204 };
    try {
      response = await this.provider.putEncryptedRepositorySecret({
        ...claim.writeTarget,
        encryptedValue: input.request.encryptedValue,
        keyId: input.request.keyId,
      });
    } catch (error) {
      if (isCodexRotatingSecretPutPreDispatchError(error)) {
        await this.ledger.retirePreDispatchVersionedWriteback({
          intentId: claim.intentId,
          attemptId: claim.attemptId,
          executorOwner: claim.executorOwner,
          safeErrorCode:
            RuntimeVersionedDurableMarker.ProviderPreDispatchFailedV1,
        });
        return { status: "github_put_failed" as const };
      }
      await this.retire(
        claim,
        RuntimeVersionedDurableMarker.ProviderPutOutcomeUnknown,
      );
      return { status: "writeback_recovery_required" as const };
    }

    try {
      await this.ledger.confirmVersionedProviderWrite({
        intentId: claim.intentId,
        attemptId: claim.attemptId,
        executorOwner: claim.executorOwner,
        statusCode: response.statusCode,
      });
    } catch {
      await this.retire(
        claim,
        RuntimeVersionedDurableMarker.ProviderConfirmationOutcomeUnknown,
      );
      return { status: "writeback_recovery_required" as const };
    }

    try {
      const attestation =
        await this.workflows.publishAndVerifyVersionedWorkflow({
          repository: claim.repository,
          providerInstanceId: input.request.providerInstanceId,
          namespace: claim.namespace,
        });
      const activated = await this.ledger.activateVersionedWriteback({
        intentId: claim.intentId,
        attemptId: claim.attemptId,
        executorOwner: claim.executorOwner,
        attestation,
      });
      return { status: "accepted" as const, ...activated };
    } catch {
      await this.retire(
        claim,
        RuntimeVersionedDurableMarker.WorkflowOrActivationOutcomeUnknown,
      );
      return { status: "writeback_recovery_required" as const };
    }
  }

  private async dispatchRollover(
    input: Parameters<
      CodexRotatingVersionedWritebackDispatcherPort["dispatchOneShot"]
    >[0],
  ): Promise<
    | Awaited<
        ReturnType<CodexRotatingVersionedWritebackDispatcherPort["dispatchOneShot"]>
      >
    | null
  > {
    const rollover = this.rollover!;
    const claim = await rollover.ledger.claimWriteback(input);
    if (claim.status === "no_match") return null;
    if (
      claim.status === "idempotent_replay" ||
      claim.status === "in_progress" ||
      claim.status === "writeback_recovery_required"
    ) {
      return claim;
    }

    if (claim.status === "ready_put") {
      try {
        const response = await this.provider.putEncryptedRepositorySecret({
          ...claim.writeTarget,
          encryptedValue: input.request.encryptedValue,
          keyId: input.request.keyId,
        });
        await rollover.ledger.confirmProviderWrite({
          intentId: claim.intentId,
          executorOwner: claim.executorOwner,
          statusCode: response.statusCode,
        });
      } catch (error) {
        if (isCodexRotatingSecretPutPreDispatchError(error)) {
          await rollover.ledger.retirePreDispatch({
            intentId: claim.intentId,
            executorOwner: claim.executorOwner,
          });
          return { status: "github_put_failed" };
        }
        await rollover.ledger.retireAmbiguous({
          intentId: claim.intentId,
          executorOwner: claim.executorOwner,
        });
        return { status: "writeback_recovery_required" };
      }
    }

    try {
      const pullRequest =
        await rollover.setupPullRequests.createOrUpdateExactSetupPullRequest({
          repository: claim.repository,
          providerInstanceId: input.request.providerInstanceId,
          candidate: claim.candidate,
          targetActionRef: claim.targetActionRef,
          targetWorkflowSchemaVersion: claim.targetWorkflowSchemaVersion,
          sourceActionRef: claim.sourceActionRef,
          expectedBaseSha: claim.expectedBaseSha,
          sourceActiveNamespaceId: claim.sourceActiveNamespaceId,
        });
      const completed = await rollover.ledger.markSetupPullRequest({
        intentId: claim.intentId,
        executorOwner: claim.executorOwner,
        ...pullRequest,
      });
      return { status: "accepted", generation: completed.generation };
    } catch {
      // Provider write is definite. Keep the candidate non-active and allow a
      // bounded idempotent setup-PR retry; never fall through to normal V5.
      return { status: "writeback_recovery_required" };
    }
  }

  private async retire(
    claim: Readonly<{
      intentId: string;
      attemptId: string;
      executorOwner: string;
      retirementIdentity: import("@reviewrouter/features-codex-oauth-rotating").RuntimeVersionedWritebackIdentity;
    }>,
    safeErrorCode: string,
  ): Promise<void> {
    await this.ledger.retireAmbiguousVersionedWriteback({
      intentId: claim.intentId,
      attemptId: claim.attemptId,
      executorOwner: claim.executorOwner,
      retirementIdentity: claim.retirementIdentity,
      safeErrorCode,
    });
  }
}
