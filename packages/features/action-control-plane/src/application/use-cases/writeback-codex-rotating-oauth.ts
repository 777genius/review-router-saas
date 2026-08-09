import {
  computeEncryptedPayloadDigest,
  parseCodexRotatingEncryptedWritebackRequest,
} from "@reviewrouter/features-codex-oauth-rotating";
import type { Clock } from "@reviewrouter/shared";
import type {
  CodexRotatingGitHubSecretWriterPort,
  CodexRotatingOAuthRepositoryPort,
} from "../ports/codex-rotating-oauth-repository-port.js";
import { isCodexRotatingSecretPutPreDispatchError } from "../ports/codex-rotating-oauth-repository-port.js";

export type WritebackCodexRotatingOAuthDependencies = {
  readonly codexRotatingOAuth: CodexRotatingOAuthRepositoryPort;
  readonly codexRotatingSecretWriter: CodexRotatingGitHubSecretWriterPort;
  readonly codexRotatingWritebackHmacKey: string;
  readonly clock: Clock;
};

export async function writebackCodexRotatingOAuth(
  input: { readonly body: unknown },
  dependencies: WritebackCodexRotatingOAuthDependencies,
): Promise<{
  readonly protocolVersion: 1;
  readonly status:
    | "accepted"
    | "idempotent_replay"
    | "github_put_failed"
    | "writeback_recovery_required"
    | "writeback_idempotency_conflict";
}> {
  const request = parseCodexRotatingEncryptedWritebackRequest(input.body);
  const encryptedPayloadDigest = computeEncryptedPayloadDigest({
    encryptedValue: request.encryptedValue,
    hmacKey: dependencies.codexRotatingWritebackHmacKey,
  });
  const prepared =
    await dependencies.codexRotatingOAuth.prepareEncryptedWriteback({
      request,
      encryptedPayloadDigest,
      now: dependencies.clock.now(),
    });
  if (prepared.status !== "ready") {
    return { protocolVersion: 1, status: prepared.status };
  }

  const dispatched =
    await dependencies.codexRotatingOAuth.markEncryptedWritebackDispatched({
      intentId: prepared.intentId,
      now: dependencies.clock.now(),
    });
  if (!dispatched) {
    return { protocolVersion: 1, status: "writeback_recovery_required" };
  }

  try {
    await dependencies.codexRotatingSecretWriter.putEncryptedRepositorySecret({
      ...prepared.writeTarget,
      encryptedValue: request.encryptedValue,
      keyId: request.keyId,
    });
  } catch (error) {
    const failure = {
      intentId: prepared.intentId,
      safeErrorCode: isCodexRotatingSecretPutPreDispatchError(error)
        ? "github_put_pre_dispatch_failed"
        : "github_put_remote_outcome_unknown",
      now: dependencies.clock.now(),
    };
    if (isCodexRotatingSecretPutPreDispatchError(error)) {
      await dependencies.codexRotatingOAuth.markEncryptedWritebackFailed(
        failure,
      );
    } else {
      await dependencies.codexRotatingOAuth.markEncryptedWritebackRemoteOutcomeUnknown(
        failure,
      );
    }
    return { protocolVersion: 1, status: "writeback_recovery_required" };
  }

  let confirmation;
  try {
    confirmation =
      await dependencies.codexRotatingOAuth.confirmEncryptedWriteback({
        intentId: prepared.intentId,
        now: dependencies.clock.now(),
      });
  } catch {
    await dependencies.codexRotatingOAuth.markEncryptedWritebackRemoteOutcomeUnknown(
      {
        intentId: prepared.intentId,
        safeErrorCode: "writeback_confirmation_remote_outcome_unknown",
        now: dependencies.clock.now(),
      },
    );
    return { protocolVersion: 1, status: "writeback_recovery_required" };
  }
  if (confirmation.status === "recovery_required") {
    return { protocolVersion: 1, status: "writeback_recovery_required" };
  }
  return { protocolVersion: 1, status: "accepted" };
}
