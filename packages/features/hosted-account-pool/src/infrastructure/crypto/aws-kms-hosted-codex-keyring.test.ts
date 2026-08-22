import { DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialEnvelopeVault,
  type CredentialKeyringPort,
} from "./credential-envelope-vault.js";
import { AwsKmsHostedCodexKeyring } from "./aws-kms-hosted-codex-keyring.js";

describe("AWS KMS hosted credential keyring", () => {
  const keyArn =
    "arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555";

  it("binds wrapping to context, audits both operations, and restores", async () => {
    const dek = Buffer.alloc(32, 7);
    const encrypted = Buffer.from("opaque-kms-ciphertext");
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
      ciphertext: encrypted.toString("base64"),
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
