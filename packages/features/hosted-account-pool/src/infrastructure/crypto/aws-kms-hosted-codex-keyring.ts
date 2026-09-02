import { createHash } from "node:crypto";
import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
  type DecryptCommandOutput,
  type EncryptCommandOutput,
} from "@aws-sdk/client-kms";
import { fromTokenFile } from "@aws-sdk/credential-providers";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type {
  CredentialKeyringPort,
  WrappedDataEncryptionKey,
} from "./credential-envelope-vault.js";
import {
  createCustodyDeadline,
  defaultCustodyOperationTimeoutMs,
} from "../../application/custody-operation-deadline.js";

const wrappingAlgorithm = "SYMMETRIC_DEFAULT" as const;

export type HostedCodexKmsAuditEvent = {
  readonly operation: "wrap" | "unwrap";
  readonly keyId: string;
  readonly associatedDataHash: string;
  readonly purpose: "relay" | "recovery";
  readonly databaseResourceIdentityHash: string;
  readonly outcome: "succeeded" | "failed";
  readonly occurredAt: string;
};

export interface HostedCodexKmsAuditPort {
  record(event: HostedCodexKmsAuditEvent): void | Promise<void>;
}

export interface AwsKmsClientPort {
  send(
    command: EncryptCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<EncryptCommandOutput>;
  send(
    command: DecryptCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<DecryptCommandOutput>;
}

/** AWS KMS envelope-key adapter. Provider plaintext is never sent to KMS. */
export class AwsKmsHostedCodexKeyring implements CredentialKeyringPort {
  readonly custodyMode = "aws_kms" as const;
  readonly currentKeyId: string;

  constructor(
    private readonly client: AwsKmsClientPort,
    keyId: string,
    private readonly audit: HostedCodexKmsAuditPort,
    private readonly now: () => Date = () => new Date(),
    private readonly operationTimeoutMs = defaultCustodyOperationTimeoutMs,
  ) {
    this.currentKeyId = requireKeyId(keyId);
  }

  async wrapDataEncryptionKey(input: {
    readonly dataEncryptionKey: Uint8Array;
    readonly associatedData: Uint8Array;
    readonly context: Parameters<
      CredentialKeyringPort["wrapDataEncryptionKey"]
    >[0]["context"];
    readonly signal?: AbortSignal;
  }): Promise<WrappedDataEncryptionKey> {
    if (input.dataEncryptionKey.byteLength !== 32) {
      throw new Error("credential_data_key_invalid");
    }
    const associatedDataHash = sha256(input.associatedData);
    const kmsPlaintext = Uint8Array.from(input.dataEncryptionKey);
    let kmsCiphertext: Uint8Array | undefined;
    const deadline = createCustodyDeadline(
      input.signal,
      this.operationTimeoutMs,
    );
    try {
      deadline.signal.throwIfAborted();
      const result = await deadline.run(
        this.client.send(
          new EncryptCommand({
            KeyId: this.currentKeyId,
            Plaintext: kmsPlaintext,
            EncryptionAlgorithm: wrappingAlgorithm,
            EncryptionContext: encryptionContext(
              input.context,
              associatedDataHash,
            ),
          }),
          { abortSignal: deadline.signal },
        ),
        zeroEncryptOutput,
      );
      kmsCiphertext = result.CiphertextBlob;
      if (!result.CiphertextBlob?.byteLength) {
        throw new Error("hosted_codex_kms_encrypt_response_invalid");
      }
      const canonicalKeyArn = requireKeyArn(result.KeyId ?? "");
      if (canonicalKeyArn !== this.currentKeyId) {
        throw new Error("hosted_codex_kms_encrypt_key_mismatch");
      }
      await deadline.run(
        Promise.resolve().then(() =>
          this.record(
            "wrap",
            this.currentKeyId,
            associatedDataHash,
            input.context,
            "succeeded",
          ),
        ),
      );
      const wrappedCiphertext = Buffer.from(result.CiphertextBlob);
      try {
        return {
          // Persist the canonical identity returned by KMS, never the request
          // spelling. This prevents an alias repoint from silently changing the
          // wrapping authority represented by an envelope.
          keyId: canonicalKeyArn,
          nonce: "",
          ciphertext: wrappedCiphertext.toString("base64"),
          authenticationTag: "",
        };
      } finally {
        wrappedCiphertext.fill(0);
      }
    } catch (error) {
      await deadline
        .run(
          Promise.resolve().then(() =>
            this.record(
              "wrap",
              this.currentKeyId,
              associatedDataHash,
              input.context,
              "failed",
            ),
          ),
        )
        .catch(() => undefined);
      throw new Error("hosted_codex_kms_wrap_failed", { cause: error });
    } finally {
      deadline.dispose();
      kmsCiphertext?.fill(0);
      kmsPlaintext.fill(0);
    }
  }

  async unwrapDataEncryptionKey(input: {
    readonly wrappedKey: WrappedDataEncryptionKey;
    readonly associatedData: Uint8Array;
    readonly context: Parameters<
      CredentialKeyringPort["unwrapDataEncryptionKey"]
    >[0]["context"];
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array> {
    const keyId = requireKeyId(input.wrappedKey.keyId);
    const associatedDataHash = sha256(input.associatedData);
    const deadline = createCustodyDeadline(
      input.signal,
      this.operationTimeoutMs,
    );
    let ciphertext: Buffer;
    let kmsPlaintext: Uint8Array | undefined;
    try {
      ciphertext = decodeBase64(input.wrappedKey.ciphertext);
    } catch (error) {
      await deadline
        .run(
          Promise.resolve().then(() =>
            this.record(
              "unwrap",
              keyId,
              associatedDataHash,
              input.context,
              "failed",
            ),
          ),
        )
        .catch(() => undefined);
      deadline.dispose();
      throw new Error("hosted_codex_kms_ciphertext_invalid", { cause: error });
    }
    try {
      deadline.signal.throwIfAborted();
      const result = await deadline.run(
        this.client.send(
          new DecryptCommand({
            KeyId: keyId,
            CiphertextBlob: ciphertext,
            EncryptionAlgorithm: wrappingAlgorithm,
            EncryptionContext: encryptionContext(
              input.context,
              associatedDataHash,
            ),
          }),
          { abortSignal: deadline.signal },
        ),
        zeroDecryptOutput,
      );
      kmsPlaintext = result.Plaintext;
      const canonicalKeyArn = requireKeyArn(result.KeyId ?? "");
      if (canonicalKeyArn !== keyId) {
        kmsPlaintext?.fill(0);
        throw new Error("hosted_codex_kms_decrypt_key_mismatch");
      }
      if (kmsPlaintext?.byteLength !== 32) {
        kmsPlaintext?.fill(0);
        throw new Error("hosted_codex_kms_decrypt_response_invalid");
      }
      try {
        await deadline.run(
          Promise.resolve().then(() =>
            this.record(
              "unwrap",
              keyId,
              associatedDataHash,
              input.context,
              "succeeded",
            ),
          ),
        );
        return Uint8Array.from(kmsPlaintext);
      } finally {
        kmsPlaintext.fill(0);
      }
    } catch (error) {
      await deadline
        .run(
          Promise.resolve().then(() =>
            this.record(
              "unwrap",
              keyId,
              associatedDataHash,
              input.context,
              "failed",
            ),
          ),
        )
        .catch(() => undefined);
      throw new Error("hosted_codex_kms_unwrap_failed", { cause: error });
    } finally {
      deadline.dispose();
      kmsPlaintext?.fill(0);
      ciphertext.fill(0);
    }
  }

  private record(
    operation: HostedCodexKmsAuditEvent["operation"],
    keyId: string,
    associatedDataHash: string,
    context: Parameters<
      CredentialKeyringPort["wrapDataEncryptionKey"]
    >[0]["context"],
    outcome: HostedCodexKmsAuditEvent["outcome"],
  ) {
    return this.audit.record({
      operation,
      keyId,
      associatedDataHash,
      purpose: context.purpose,
      databaseResourceIdentityHash: sha256(
        Buffer.from(context.databaseResourceIdentity, "utf8"),
      ),
      outcome,
      occurredAt: this.now().toISOString(),
    });
  }
}

export function createProductionAwsKmsHostedCodexKeyring(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly client?: AwsKmsClientPort;
  readonly audit?: HostedCodexKmsAuditPort;
  readonly purpose?: "relay" | "enrollment" | "recovery";
  readonly operationTimeoutMs?: number;
}): AwsKmsHostedCodexKeyring {
  const purpose = input.purpose ?? "relay";
  const configuredRole = input.env.REVIEW_ROUTER_HOSTED_CODEX_KMS_ROLE?.trim();
  if (configuredRole !== purpose) {
    throw new Error("hosted_codex_kms_role_mismatch");
  }
  const keyId = input.env.REVIEW_ROUTER_HOSTED_CODEX_KMS_KEY_ARN?.trim();
  const region = input.env.AWS_REGION?.trim();
  const roleArn = input.env.REVIEW_ROUTER_HOSTED_CODEX_AWS_ROLE_ARN?.trim();
  const workloadRoleArn = input.env.AWS_ROLE_ARN?.trim();
  const webIdentityTokenFile = input.env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim();
  if (!keyId) throw new Error("hosted_codex_aws_kms_key_id_missing");
  if (!region) throw new Error("hosted_codex_aws_kms_region_missing");
  if (
    !roleArn ||
    !/^arn:(?:aws|aws-us-gov|aws-cn):iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u.test(
      roleArn,
    )
  ) {
    throw new Error("hosted_codex_aws_role_arn_invalid");
  }
  if (workloadRoleArn !== roleArn) {
    throw new Error("hosted_codex_aws_workload_role_mismatch");
  }
  if (
    !webIdentityTokenFile ||
    !webIdentityTokenFile.startsWith("/") ||
    webIdentityTokenFile.includes("\0")
  ) {
    throw new Error("hosted_codex_aws_web_identity_token_file_invalid");
  }
  const client =
    input.client ??
    new KMSClient({
      region,
      requestHandler: boundedAwsHttpHandler(input.operationTimeoutMs),
      maxAttempts: 2,
      retryMode: "standard",
      credentials: boundedCredentialProvider(
        fromTokenFile({
          clientConfig: {
            region,
            requestHandler: boundedAwsHttpHandler(input.operationTimeoutMs),
            maxAttempts: 2,
            retryMode: "standard",
          },
          roleArn,
          roleSessionName: `reviewrouter-hosted-codex-${purpose}`,
          webIdentityTokenFile,
        }),
        input.operationTimeoutMs,
      ),
    });
  return new AwsKmsHostedCodexKeyring(
    client,
    keyId,
    input.audit ?? {
      record(event) {
        process.stdout.write(
          `${JSON.stringify({ event: "hosted_codex_kms", ...event })}\n`,
        );
      },
    },
    undefined,
    input.operationTimeoutMs,
  );
}

export function boundedCredentialProvider(
  provider: ReturnType<typeof fromTokenFile>,
  timeoutMs = defaultCustodyOperationTimeoutMs,
): ReturnType<typeof fromTokenFile> {
  return async () => {
    const deadline = createCustodyDeadline(undefined, timeoutMs);
    try {
      return await deadline.run(provider());
    } finally {
      deadline.dispose();
    }
  };
}

function boundedAwsHttpHandler(timeoutMs = defaultCustodyOperationTimeoutMs) {
  const bounded = Math.max(1, Math.floor(timeoutMs));
  return new NodeHttpHandler({
    connectionTimeout: Math.min(3_000, bounded),
    requestTimeout: bounded,
    socketTimeout: bounded,
  });
}

function zeroEncryptOutput(output: EncryptCommandOutput): void {
  output.CiphertextBlob?.fill(0);
}

function zeroDecryptOutput(output: DecryptCommandOutput): void {
  output.Plaintext?.fill(0);
}

function encryptionContext(
  context: Parameters<
    CredentialKeyringPort["wrapDataEncryptionKey"]
  >[0]["context"],
  associatedDataHash: string,
) {
  return {
    purpose: `reviewrouter-hosted-codex-${context.purpose}-dek-v1`,
    associated_data_sha256: associatedDataHash,
    workspace_id: context.workspaceId,
    pool_id: context.poolId,
    account_id: context.accountId,
    generation: String(context.generation),
    database_resource_identity: context.databaseResourceIdentity,
    database_incarnation: context.databaseIncarnation,
    envelope_schema_version: String(context.schemaVersion),
  };
}

function requireKeyId(value: string): string {
  return requireKeyArn(value);
}

/** Accept only an immutable AWS KMS key ARN, never aliases or shorthand IDs. */
export function requireKeyArn(value: string): string {
  const keyId = value.trim();
  if (
    keyId.length > 2048 ||
    !/^arn:(?:aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:\d{12}:key\/(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/iu.test(
      keyId,
    )
  ) {
    throw new Error("hosted_codex_aws_kms_key_id_invalid");
  }
  return keyId;
}

function decodeBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (!value || decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new Error("hosted_codex_kms_ciphertext_invalid");
  }
  return decoded;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
