import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AesGcmContextReplayMaterialCipher } from "../infrastructure/crypto/aes-gcm-context-replay-material-cipher";

describe("AesGcmContextReplayMaterialCipher", () => {
  it("round-trips replay material and supports historical key rotation", async () => {
    const oldKey = Buffer.alloc(32, 1);
    const currentKey = Buffer.alloc(32, 2);
    const original = new AesGcmContextReplayMaterialCipher(
      "key-old",
      new Map([["key-old", oldKey]]),
    );
    const plaintext = '{"entries":[{"query":"private search"}],"version":1}';
    const associatedData = '{"sessionId":"session-1","transcriptHash":"abc"}';
    const encrypted = await original.encrypt({
      sessionId: "session-1",
      plaintextCanonicalJson: plaintext,
      associatedDataCanonicalJson: associatedData,
      expiresAtMs: 10_000,
    });
    const rotated = new AesGcmContextReplayMaterialCipher(
      "key-current",
      new Map([
        ["key-old", oldKey],
        ["key-current", currentKey],
      ]),
    );

    await expect(
      rotated.decrypt({
        material: encrypted,
        associatedDataCanonicalJson: associatedData,
      }),
    ).resolves.toBe(plaintext);
    expect(JSON.stringify(encrypted)).not.toContain("private search");
    expect(encrypted.keyId).toBe("key-old");
    expect(encrypted.plaintextHash).not.toBe(
      createHash("sha256").update(plaintext).digest("hex"),
    );
    const repeated = await original.encrypt({
      sessionId: "session-1",
      plaintextCanonicalJson: plaintext,
      associatedDataCanonicalJson: associatedData,
      expiresAtMs: 10_000,
    });
    expect(repeated.plaintextHash).toBe(encrypted.plaintextHash);
    expect(repeated.ciphertextBase64Url).not.toBe(
      encrypted.ciphertextBase64Url,
    );
  });

  it("rejects modified ciphertext and associated data", async () => {
    const cipher = new AesGcmContextReplayMaterialCipher(
      "key-1",
      new Map([["key-1", Buffer.alloc(32, 7)]]),
    );
    const material = await cipher.encrypt({
      sessionId: "session-1",
      plaintextCanonicalJson: '{"entries":[]}',
      associatedDataCanonicalJson: '{"sessionId":"session-1"}',
      expiresAtMs: 10_000,
    });

    await expect(
      cipher.decrypt({
        material,
        associatedDataCanonicalJson: '{"sessionId":"session-2"}',
      }),
    ).rejects.toThrow("context_replay_associated_data_mismatch");
    const tamperedCiphertext = Buffer.from(
      material.ciphertextBase64Url,
      "base64url",
    );
    tamperedCiphertext[0] = tamperedCiphertext[0]! ^ 1;
    await expect(
      cipher.decrypt({
        material: {
          ...material,
          ciphertextBase64Url: tamperedCiphertext.toString("base64url"),
        },
        associatedDataCanonicalJson: '{"sessionId":"session-1"}',
      }),
    ).rejects.toThrow();
  });
});
