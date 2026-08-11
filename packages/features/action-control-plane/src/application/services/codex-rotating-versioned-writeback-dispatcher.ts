import type {
  CodexRotatingGitHubSecretWriterPort,
  CodexRotatingVersionedWorkflowPublisherPort,
  CodexRotatingVersionedWritebackDispatcherPort,
  CodexRotatingVersionedWritebackLedgerPort,
} from "../ports/codex-rotating-oauth-repository-port.js";
import { isCodexRotatingSecretPutPreDispatchError } from "../ports/codex-rotating-oauth-repository-port.js";
import type { Clock } from "@reviewrouter/shared";
import { RuntimeVersionedDurableMarker } from "@reviewrouter/features-codex-oauth-rotating";

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
    private readonly clock: Clock,
  ) {}

  async dispatchOneShot(
    input: Parameters<
      CodexRotatingVersionedWritebackDispatcherPort["dispatchOneShot"]
    >[0],
  ) {
    const claim = await this.ledger.prepareVersionedWriteback({
      ...input,
      now: this.clock.now(),
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
          now: this.clock.now(),
        });
        return { status: "github_put_failed" as const };
      }
      await this.retire(
        claim,
        RuntimeVersionedDurableMarker.ProviderPutOutcomeUnknown,
        this.clock.now(),
      );
      return { status: "writeback_recovery_required" as const };
    }

    try {
      await this.ledger.confirmVersionedProviderWrite({
        intentId: claim.intentId,
        attemptId: claim.attemptId,
        executorOwner: claim.executorOwner,
        statusCode: response.statusCode,
        now: this.clock.now(),
      });
    } catch {
      await this.retire(
        claim,
        RuntimeVersionedDurableMarker.ProviderConfirmationOutcomeUnknown,
        this.clock.now(),
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
        now: this.clock.now(),
      });
      return { status: "accepted" as const, ...activated };
    } catch {
      await this.retire(
        claim,
        RuntimeVersionedDurableMarker.WorkflowOrActivationOutcomeUnknown,
        this.clock.now(),
      );
      return { status: "writeback_recovery_required" as const };
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
    now: Date,
  ): Promise<void> {
    await this.ledger.retireAmbiguousVersionedWriteback({
      intentId: claim.intentId,
      attemptId: claim.attemptId,
      executorOwner: claim.executorOwner,
      retirementIdentity: claim.retirementIdentity,
      safeErrorCode,
      now,
    });
  }
}
