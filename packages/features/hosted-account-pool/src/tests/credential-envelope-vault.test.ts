import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CredentialEnvelopeVault,
  EnvCredentialKeyring,
  stableAccountFingerprint,
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
