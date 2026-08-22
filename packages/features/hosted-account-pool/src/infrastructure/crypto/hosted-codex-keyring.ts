import {
  EnvCredentialKeyring,
  type CredentialKeyringPort,
} from "./credential-envelope-vault.js";
import {
  createProductionAwsKmsHostedCodexKeyring,
  type AwsKmsClientPort,
  type HostedCodexKmsAuditPort,
  requireKeyArn,
} from "./aws-kms-hosted-codex-keyring.js";

/** Production must receive a provider-backed keyring from the process host. */
export function resolveHostedCodexKeyring(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly externalKeyring?: CredentialKeyringPort;
  readonly kmsClient?: AwsKmsClientPort;
  readonly kmsAudit?: HostedCodexKmsAuditPort;
  readonly purpose?: "relay" | "enrollment" | "recovery";
}): CredentialKeyringPort {
  const mode = input.env.REVIEW_ROUTER_HOSTED_CODEX_KEYRING_MODE?.trim();
  if (input.env.NODE_ENV === "production") {
    if (mode !== "external_kms") {
      throw new Error("hosted_codex_external_kms_required");
    }
    if (
      input.externalKeyring &&
      input.externalKeyring.custodyMode !== "aws_kms"
    ) {
      throw new Error("hosted_codex_external_kms_required");
    }
    if (input.externalKeyring)
      requireKeyArn(input.externalKeyring.currentKeyId);
    return (
      input.externalKeyring ??
      createProductionAwsKmsHostedCodexKeyring({
        env: input.env,
        purpose: input.purpose ?? "relay",
        ...(input.kmsClient ? { client: input.kmsClient } : {}),
        ...(input.kmsAudit ? { audit: input.kmsAudit } : {}),
      })
    );
  }
  if (mode && mode !== "local_env") {
    throw new Error("hosted_codex_keyring_mode_invalid");
  }
  return input.externalKeyring ?? new EnvCredentialKeyring(input.env);
}
