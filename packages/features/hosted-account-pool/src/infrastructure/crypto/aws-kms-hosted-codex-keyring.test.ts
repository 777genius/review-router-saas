import { DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialEnvelopeVault,
  type CredentialKeyringPort,
} from "./credential-envelope-vault.js";
import {
  AwsKmsHostedCodexKeyring,
  boundedCredentialProvider,
  createProductionAwsKmsHostedCodexKeyring,
} from "./aws-kms-hosted-codex-keyring.js";

describe("AWS KMS hosted credential keyring", () => {
  const keyArn =
    "arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555";

  it("requires the selected immutable runtime role even with an injected KMS client", () => {
    const env = {
      REVIEW_ROUTER_HOSTED_CODEX_KMS_ROLE: "relay",
      REVIEW_ROUTER_HOSTED_CODEX_KMS_KEY_ARN: keyArn,
      AWS_REGION: "eu-west-1",
      REVIEW_ROUTER_HOSTED_CODEX_AWS_ROLE_ARN:
        "arn:aws:iam::123456789012:role/reviewrouter-hosted-relay",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/reviewrouter-hosted-relay",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/render-oidc/token",
    };
    expect(() =>
      createProductionAwsKmsHostedCodexKeyring({
        env,
        client: { send: vi.fn() },
      }),
    ).not.toThrow();
    expect(() =>
      createProductionAwsKmsHostedCodexKeyring({
        env: { ...env, REVIEW_ROUTER_HOSTED_CODEX_AWS_ROLE_ARN: "relay" },
        client: { send: vi.fn() },
      }),
    ).toThrow("hosted_codex_aws_role_arn_invalid");
    expect(() =>
      createProductionAwsKmsHostedCodexKeyring({
        env: {
          ...env,
          AWS_ROLE_ARN:
            "arn:aws:iam::123456789012:role/reviewrouter-hosted-other",
        },
        client: { send: vi.fn() },
      }),
    ).toThrow("hosted_codex_aws_workload_role_mismatch");
    expect(() =>
      createProductionAwsKmsHostedCodexKeyring({
        env: { ...env, AWS_WEB_IDENTITY_TOKEN_FILE: "relative/token" },
        client: { send: vi.fn() },
      }),
    ).toThrow("hosted_codex_aws_web_identity_token_file_invalid");
  });

  it("binds wrapping to context, audits both operations, and restores", async () => {
    const dek = Buffer.alloc(32, 7);
    const encrypted = Buffer.from("opaque-kms-ciphertext");
    const encryptedBase64 = encrypted.toString("base64");
    let kmsEncryptPlaintext: Uint8Array | undefined;
    let kmsDecryptPlaintext: Uint8Array | undefined;
    const send = vi.fn(async (command: EncryptCommand | DecryptCommand) => {
      if (command instanceof EncryptCommand) {
        expect(Buffer.from(command.input.Plaintext ?? [])).toEqual(dek);
        kmsEncryptPlaintext = command.input.Plaintext;
        expect(command.input.EncryptionContext).toMatchObject({
          purpose: "reviewrouter-hosted-codex-relay-dek-v1",
          database_resource_identity: "database-resource-test-1",
        });
        return { CiphertextBlob: encrypted, KeyId: keyArn };
      }
      expect(command.input.KeyId).toBe(keyArn);
      kmsDecryptPlaintext = Uint8Array.from(dek);
      return { Plaintext: kmsDecryptPlaintext, KeyId: keyArn };
    });
    const record = vi.fn();
    const keyring = new AwsKmsHostedCodexKeyring(
      { send } as never,
      keyArn,
      { record },
      () => new Date("2026-08-16T00:00:00.000Z"),
    );
    const wrapped = await keyring.wrapDataEncryptionKey({
      dataEncryptionKey: dek,
      associatedData: Buffer.from("tenant-bound-aad"),
      context: kmsContext,
    });
    expect(wrapped).toMatchObject({
      keyId: keyArn,
      ciphertext: encryptedBase64,
    });
    expect(
      Buffer.from(
        await keyring.unwrapDataEncryptionKey({
          wrappedKey: wrapped,
          associatedData: Buffer.from("tenant-bound-aad"),
          context: kmsContext,
        }),
      ),
    ).toEqual(dek);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "unwrap", outcome: "succeeded" }),
    );
    expect(kmsEncryptPlaintext).toEqual(new Uint8Array(32));
    expect(kmsDecryptPlaintext).toEqual(new Uint8Array(32));
  });

  it.each([
    "alias/hosted-codex",
    "arn:aws:kms:eu-west-1:123456789012:alias/hosted-codex",
    "11111111-2222-3333-4444-555555555555",
    "hosted-codex",
  ])("rejects mutable or shorthand KMS identity %s", (value) => {
    expect(
      () =>
        new AwsKmsHostedCodexKeyring({ send: vi.fn() } as never, value, {
          record: vi.fn(),
        }),
    ).toThrow("hosted_codex_aws_kms_key_id_invalid");
  });

  it("fails closed when an alias repoint or provider mismatch returns another key", async () => {
    const otherArn =
      "arn:aws:kms:eu-west-1:123456789012:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const keyring = new AwsKmsHostedCodexKeyring(
      {
        send: vi.fn().mockResolvedValue({
          CiphertextBlob: Buffer.from("ciphertext"),
          KeyId: otherArn,
        }),
      } as never,
      keyArn,
      { record: vi.fn() },
    );
    await expect(
      keyring.wrapDataEncryptionKey({
        dataEncryptionKey: Buffer.alloc(32),
        associatedData: Buffer.from("aad"),
        context: kmsContext,
      }),
    ).rejects.toThrow("hosted_codex_kms_wrap_failed");
  });

  it("settles a hung KMS wrap, aborts transport, and zeroes the command DEK", async () => {
    vi.useFakeTimers();
    let commandPlaintext: Uint8Array | undefined;
    let transportSignal: AbortSignal | undefined;
    const send = vi.fn(
      (command: EncryptCommand, options?: { abortSignal?: AbortSignal }) => {
        commandPlaintext = command.input.Plaintext;
        transportSignal = options?.abortSignal;
        return new Promise<never>(() => undefined);
      },
    );
    const keyring = new AwsKmsHostedCodexKeyring(
      { send } as never,
      keyArn,
      { record: vi.fn() },
      undefined,
      10,
    );
    try {
      const wrapping = keyring.wrapDataEncryptionKey({
        dataEncryptionKey: Buffer.alloc(32, 9),
        associatedData: Buffer.from("aad"),
        context: kmsContext,
      });
      const rejection = expect(wrapping).rejects.toThrow(
        "hosted_codex_kms_wrap_failed",
      );
      await vi.advanceTimersByTimeAsync(11);
      await rejection;
      expect(transportSignal?.aborted).toBe(true);
      expect(commandPlaintext).toEqual(new Uint8Array(32));
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds hung web-identity credential resolution", async () => {
    vi.useFakeTimers();
    const bounded = boundedCredentialProvider(
      (() => new Promise<never>(() => undefined)) as never,
      10,
    );
    try {
      const resolving = bounded();
      const rejection = expect(resolving).rejects.toThrow(
        "hosted_codex_custody_timeout",
      );
      await vi.advanceTimersByTimeAsync(11);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("zeroes a late KMS decrypt plaintext after the caller timed out", async () => {
    vi.useFakeTimers();
    let resolveSend!: (value: { Plaintext: Uint8Array; KeyId: string }) => void;
    const send = vi.fn(
      () =>
        new Promise<{ Plaintext: Uint8Array; KeyId: string }>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const keyring = new AwsKmsHostedCodexKeyring(
      { send } as never,
      keyArn,
      { record: vi.fn() },
      undefined,
      10,
    );
    const latePlaintext = Buffer.alloc(32, 17);
    try {
      const unwrapping = keyring.unwrapDataEncryptionKey({
        wrappedKey: {
          keyId: keyArn,
          nonce: "",
          ciphertext: Buffer.from("ciphertext").toString("base64"),
          authenticationTag: "",
        },
        associatedData: Buffer.from("aad"),
        context: kmsContext,
      });
      const rejection = expect(unwrapping).rejects.toThrow(
        "hosted_codex_kms_unwrap_failed",
      );
      await vi.advanceTimersByTimeAsync(11);
      await rejection;
      resolveSend({ Plaintext: latePlaintext, KeyId: keyArn });
      await Promise.resolve();
      expect(latePlaintext).toEqual(Buffer.alloc(32));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a mismatched immutable ARN returned by Decrypt", async () => {
    const otherArn =
      "arn:aws:kms:eu-west-1:123456789012:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const keyring = new AwsKmsHostedCodexKeyring(
      {
        send: vi.fn().mockResolvedValue({
          Plaintext: Buffer.alloc(32),
          KeyId: otherArn,
        }),
      } as never,
      keyArn,
      { record: vi.fn() },
    );
    await expect(
      keyring.unwrapDataEncryptionKey({
        wrappedKey: {
          keyId: keyArn,
          nonce: "",
          ciphertext: Buffer.from("ciphertext").toString("base64"),
          authenticationTag: "",
        },
        associatedData: Buffer.from("aad"),
        context: kmsContext,
      }),
    ).rejects.toThrow("hosted_codex_kms_unwrap_failed");
  });

  it("rewraps under a rotated KMS key without changing credential ciphertext", async () => {
    const plaintext = Buffer.from("api-only-provider-secret");
    const context = {
      workspaceId: "workspace",
      poolId: "pool",
      accountId: "account",
      generation: 1,
      databaseIncarnation: "incarnation",
      databaseResourceIdentity: "database-resource-test-1",
    };
    const old = mockKeyring("old-key", 11);
    const original = await new CredentialEnvelopeVault(old).encrypt(
      plaintext,
      context,
    );
    const rotated = await new CredentialEnvelopeVault(
      mockKeyring("new-key", 13, old),
    ).rewrap(original, context);
    expect(rotated.keyId).toBe("new-key");
    expect(rotated.ciphertext).toBe(original.ciphertext);
    expect(rotated.ciphertextHash).toBe(original.ciphertextHash);
    plaintext.fill(0);
  });
});

function mockKeyring(
  keyId: string,
  mask: number,
  fallback?: CredentialKeyringPort,
): CredentialKeyringPort {
  return {
    currentKeyId: keyId,
    async wrapDataEncryptionKey(
      input: Parameters<CredentialKeyringPort["wrapDataEncryptionKey"]>[0],
    ) {
      return {
        keyId,
        nonce: "",
        authenticationTag: "",
        ciphertext: Buffer.from(
          Buffer.from(input.dataEncryptionKey).map((value) => value ^ mask),
        ).toString("base64"),
      };
    },
    async unwrapDataEncryptionKey(
      input: Parameters<CredentialKeyringPort["unwrapDataEncryptionKey"]>[0],
    ) {
      if (input.wrappedKey.keyId !== keyId) {
        if (fallback) return fallback.unwrapDataEncryptionKey(input);
        throw new Error("unknown-key");
      }
      return Buffer.from(input.wrappedKey.ciphertext, "base64").map(
        (value) => value ^ mask,
      );
    },
  };
}

const kmsContext = {
  workspaceId: "workspace",
  poolId: "pool",
  accountId: "account",
  generation: 1,
  databaseIncarnation: "database-incarnation-test-1",
  databaseResourceIdentity: "database-resource-test-1",
  purpose: "relay" as const,
  schemaVersion: 1 as const,
};
