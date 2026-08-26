import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialEnvelopeVault,
  EnvCredentialKeyring,
  stableAccountFingerprint,
  type CredentialKeyringPort,
} from "../infrastructure/crypto/credential-envelope-vault";

const context = {
  workspaceId: "workspace-1",
  poolId: "pool-1",
  accountId: "account-1",
  generation: 1,
  databaseIncarnation: "database-2026-08-15",
  databaseResourceIdentity: "database-resource-test-2026-08-15",
};

describe("CredentialEnvelopeVault", () => {
  it("uses a random per-version DEK and binds every authority field as AAD", async () => {
    const key = randomBytes(32).toString("base64");
    const vault = new CredentialEnvelopeVault(
      new EnvCredentialKeyring({
        REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID: "kek-1",
        REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON: JSON.stringify({
          "kek-1": key,
        }),
      }),
    );
    const plaintext = Buffer.from('{"tokens":{"access_token":"secret"}}');
    const first = await vault.encrypt(plaintext, context);
    const second = await vault.encrypt(plaintext, context);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.wrappedDataEncryptionKey.ciphertext).not.toBe(
      second.wrappedDataEncryptionKey.ciphertext,
    );
    await expect(vault.decrypt(first, context)).resolves.toEqual(plaintext);
    await expect(
      vault.decrypt(first, { ...context, generation: 2 }),
    ).rejects.toThrow("credential_envelope_context_mismatch");
    for (const swapped of [
      { ...context, workspaceId: "workspace-2" },
      { ...context, accountId: "account-2" },
      { ...context, databaseIncarnation: "database-2026-08-16" },
      {
        ...context,
        databaseResourceIdentity: "database-resource-test-2026-08-16",
      },
    ]) {
      await expect(vault.decrypt(first, swapped)).rejects.toThrow(
        "credential_envelope_context_mismatch",
      );
    }
  });

  it("fails closed without a configured current KEK", () => {
    expect(() => new EnvCredentialKeyring({})).toThrow(
      "hosted_codex_keyring_not_configured",
    );
  });

  it("wraps the DEK before synchronous local bearer capture", async () => {
    const keyring = new EnvCredentialKeyring({
      REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID: "kek-1",
      REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON: JSON.stringify({
        "kek-1": randomBytes(32).toString("base64"),
      }),
    });
    const vault = new CredentialEnvelopeVault(keyring);
    const prepared = await vault.prepareEncrypt(context);
    const plaintext = Buffer.from("known-provider-bearer");
    const envelope = prepared.capture(plaintext);
    prepared.destroy();

    await expect(vault.decrypt(envelope, context)).resolves.toEqual(plaintext);
    expect(() => prepared.capture(plaintext)).toThrow(
      "credential_capture_destroyed",
    );
  });

  it.each(["success", "authentication failure"] as const)(
    "zeroes vault-owned decode and original unwrap buffers on %s",
    async (outcome) => {
      const delegate = new EnvCredentialKeyring({
        REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID: "kek-1",
        REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON: JSON.stringify({
          "kek-1": randomBytes(32).toString("base64"),
        }),
      });
      const retained: Uint8Array[] = [];
      const keyring: CredentialKeyringPort = {
        currentKeyId: delegate.currentKeyId,
        wrapDataEncryptionKey: (input) => delegate.wrapDataEncryptionKey(input),
        async unwrapDataEncryptionKey(input) {
          retained.push(input.associatedData);
          const key = await delegate.unwrapDataEncryptionKey(input);
          retained.push(key);
          return key;
        },
      };
      const vault = new CredentialEnvelopeVault(keyring);
      const plaintext = Buffer.from("retained-secret-buffer");
      const encrypted = await vault.encrypt(plaintext, context);
      const envelope =
        outcome === "success"
          ? encrypted
          : {
              ...encrypted,
              authenticationTag: randomBytes(16).toString("base64"),
            };
      const decodedInputs = new Set([
        envelope.ciphertext,
        envelope.nonce,
        envelope.authenticationTag,
      ]);
      const fromSpy = vi.spyOn(Buffer, "from");

      try {
        if (outcome === "success") {
          const opened = await vault.decrypt(envelope, context);
          expect(opened).toEqual(plaintext);
          opened.fill(0);
        } else {
          await expect(vault.decrypt(envelope, context)).rejects.toThrow(
            "credential_envelope_authentication_failed",
          );
        }
        const decodedBuffers = fromSpy.mock.calls.flatMap((call, index) => {
          const result = fromSpy.mock.results[index];
          return typeof call[0] === "string" &&
            (call as readonly unknown[])[1] === "base64" &&
            decodedInputs.has(call[0]) &&
            result?.type === "return" &&
            Buffer.isBuffer(result.value)
            ? [result.value]
            : [];
        });
        expect(decodedBuffers).toHaveLength(3);
        for (const value of decodedBuffers)
          expect(Array.from(value)).toEqual(Array(value.byteLength).fill(0));
      } finally {
        fromSpy.mockRestore();
      }
      expect(retained).toHaveLength(2);
      for (const value of retained)
        expect(Array.from(value)).toEqual(Array(value.byteLength).fill(0));
      plaintext.fill(0);
    },
  );

  it("zeroes a decoded buffer when base64 canonicalization fails", async () => {
    const vault = new CredentialEnvelopeVault(
      new EnvCredentialKeyring({
        REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID: "kek-1",
        REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON: JSON.stringify({
          "kek-1": randomBytes(32).toString("base64"),
        }),
      }),
    );
    const plaintext = Buffer.from("malformed-envelope-secret");
    const encrypted = await vault.encrypt(plaintext, context);
    const malformedCiphertext = "AQID=";
    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      await expect(
        vault.decrypt(
          { ...encrypted, ciphertext: malformedCiphertext },
          context,
        ),
      ).rejects.toThrow("credential_envelope_base64_invalid");
      const index = fromSpy.mock.calls.findIndex(
        (call) =>
          call[0] === malformedCiphertext &&
          (call as readonly unknown[])[1] === "base64",
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const result = fromSpy.mock.results[index];
      expect(result?.type).toBe("return");
      expect(Array.from(result?.value as Buffer)).toEqual([0, 0, 0]);
    } finally {
      fromSpy.mockRestore();
      plaintext.fill(0);
    }
  });

  it("creates a stable peppered fingerprint without exposing the subject", () => {
    const pepper = randomBytes(32);
    const first = stableAccountFingerprint({
      canonicalSubject: "User@Example.COM",
      pepper,
    });
    const second = stableAccountFingerprint({
      canonicalSubject: "user@example.com",
      pepper,
    });
    expect(first).toBe(second);
    expect(first).not.toContain("example");
  });
});
