import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AesGcmInvestigationPrivateMaterialCipher } from "../infrastructure/crypto/aes-gcm-investigation-private-material-cipher";

describe("AesGcmInvestigationPrivateMaterialCipher", () => {
  it("round-trips without exposing plaintext and supports key rotation", async () => {
    const oldKey = Buffer.alloc(32, 3);
    const currentKey = Buffer.alloc(32, 7);
    const original = new AesGcmInvestigationPrivateMaterialCipher(
      "key-old",
      new Map([["key-old", oldKey]]),
    );
    const plaintext = '{"query":"private symbol lookup","version":1}';
    const associatedData =
      '{"investigationId":"investigation-1","obligationId":"obligation-1"}';
    const material = await original.encrypt({
      privateMaterialId: "private-material-1",
      investigationId: "investigation-1",
      obligationId: "obligation-1",
      plaintextCanonicalJson: plaintext,
      associatedDataCanonicalJson: associatedData,
      createdAt: "2026-08-02T10:00:00.000Z",
      expiresAt: "2026-08-02T10:05:00.000Z",
    });
    const rotated = new AesGcmInvestigationPrivateMaterialCipher(
      "key-current",
      new Map([
        ["key-old", oldKey],
        ["key-current", currentKey],
      ]),
    );

    await expect(
      rotated.decrypt({ material, associatedDataCanonicalJson: associatedData }),
    ).resolves.toBe(plaintext);
    expect(JSON.stringify(material)).not.toContain("private symbol lookup");
    expect(material.keyId).toBe("key-old");
    expect(material.plaintextHash).not.toBe(
      createHash("sha256").update(plaintext).digest("hex"),
    );

    const repeated = await original.encrypt({
      privateMaterialId: "private-material-2",
      investigationId: "investigation-1",
      obligationId: "obligation-1",
      plaintextCanonicalJson: plaintext,
      associatedDataCanonicalJson: associatedData,
      createdAt: "2026-08-02T10:00:00.000Z",
      expiresAt: "2026-08-02T10:05:00.000Z",
    });
    expect(repeated.plaintextHash).toBe(material.plaintextHash);
    expect(repeated.ciphertextBase64Url).not.toBe(material.ciphertextBase64Url);
  });

  it("rejects modified ciphertext and associated data", async () => {
    const cipher = new AesGcmInvestigationPrivateMaterialCipher(
      "key-1",
      new Map([["key-1", Buffer.alloc(32, 11)]]),
    );
    const material = await cipher.encrypt({
      privateMaterialId: "private-material-1",
      investigationId: "investigation-1",
      obligationId: null,
      plaintextCanonicalJson: '{"query":"private"}',
      associatedDataCanonicalJson: '{"investigationId":"investigation-1"}',
      createdAt: "2026-08-02T10:00:00.000Z",
      expiresAt: "2026-08-02T10:05:00.000Z",
    });

    await expect(
      cipher.decrypt({
        material,
        associatedDataCanonicalJson: '{"investigationId":"investigation-2"}',
      }),
    ).rejects.toThrow("investigation_private_material_associated_data_mismatch");

    const tampered = Buffer.from(material.ciphertextBase64Url, "base64url");
    tampered[0] = tampered[0]! ^ 1;
    await expect(
      cipher.decrypt({
        material: {
          ...material,
          ciphertextBase64Url: tampered.toString("base64url"),
        },
        associatedDataCanonicalJson: '{"investigationId":"investigation-1"}',
      }),
    ).rejects.toThrow();
  });
});
