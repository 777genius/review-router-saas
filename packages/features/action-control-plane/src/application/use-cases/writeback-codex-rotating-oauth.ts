import {
  computeEncryptedPayloadDigest,
  parseCodexRotatingEncryptedWritebackRequest,
} from "@reviewrouter/features-codex-oauth-rotating";
import type { Clock } from "@reviewrouter/shared";
import type { CodexRotatingVersionedWritebackDispatcherPort } from "../ports/codex-rotating-oauth-repository-port.js";

export type WritebackCodexRotatingOAuthDependencies = {
  readonly codexRotatingVersionedWriteback: CodexRotatingVersionedWritebackDispatcherPort;
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
    | "in_progress"
    | "github_put_failed"
    | "writeback_recovery_required"
    | "writeback_idempotency_conflict";
}> {
  const request = parseCodexRotatingEncryptedWritebackRequest(input.body);
  const encryptedPayloadDigest = computeEncryptedPayloadDigest({
    encryptedValue: request.encryptedValue,
    hmacKey: dependencies.codexRotatingWritebackHmacKey,
  });
  const result =
    await dependencies.codexRotatingVersionedWriteback.dispatchOneShot({
      request,
      encryptedPayloadDigest,
    });
  return { protocolVersion: 1, status: result.status };
}
