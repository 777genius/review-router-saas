import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHostedCodexRestorePermit } from "./hosted-codex-restore-permit";

const now = new Date("2026-08-22T10:00:00.000Z");
const inventoryHash = "a".repeat(64);
const databaseResourceIdentity = "provider-resource-immutable-0001";
const targetIncarnation = "target-incarnation-immutable-0002";
const authorityKeyId = "restore-authority-2026-08";
const keyArn = (suffix: string) =>
  `arn:aws:kms:us-east-1:123456789012:key/${suffix}`;
const claims = {
  v: 2 as const,
  inventory_hash: inventoryHash,
  database_resource_identity: databaseResourceIdentity,
  source_incarnation: "source-incarnation-immutable-0001",
  target_incarnation: targetIncarnation,
  source_kms_key_arn: keyArn("11111111-1111-4111-8111-111111111111"),
  target_kms_key_arn: keyArn("22222222-2222-4222-8222-222222222222"),
  authority_key_id: authorityKeyId,
  actor_id: "operator-42",
  nonce: "n".repeat(48),
  expires_at: "2026-08-22T10:30:00.000Z",
};

describe("hosted Codex restore permit", () => {
  it("accepts only the exact Ed25519-witnessed inventory and clone scope", () => {
    const fixture = signed(claims);
    expect(verify(fixture.token, fixture.publicKeyPem)).toMatchObject({
      inventoryHash,
      databaseResourceIdentity,
      targetIncarnation,
      sourceKmsKeyArn: claims.source_kms_key_arn,
      targetKmsKeyArn: claims.target_kms_key_arn,
    });
  });

  it.each([
    ["wrong inventory", { expectedInventoryHash: "b".repeat(64) }],
    [
      "wrong clone",
      { expectedDatabaseResourceIdentity: `${databaseResourceIdentity}-clone` },
    ],
    [
      "wrong incarnation",
      { expectedTargetIncarnation: `${targetIncarnation}-other` },
    ],
    ["wrong authority", { expectedAuthorityKeyId: `${authorityKeyId}-other` }],
  ])("rejects %s", (_label, override) => {
    const fixture = signed(claims);
    expect(() => verify(fixture.token, fixture.publicKeyPem, override)).toThrow(
      "hosted_codex_restore_permit_scope_invalid",
    );
  });

  it("rejects expiry, alteration, a wrong signing key, and unsigned extra claims", () => {
    const fixture = signed(claims);
    expect(() =>
      verify(fixture.token, fixture.publicKeyPem, {
        now: new Date(claims.expires_at),
      }),
    ).toThrow("hosted_codex_restore_permit_scope_invalid");
    expect(() =>
      verify(`${fixture.token.slice(0, -1)}x`, fixture.publicKeyPem),
    ).toThrow("hosted_codex_restore_permit_invalid");
    const other = signed(claims);
    expect(() => verify(fixture.token, other.publicKeyPem)).toThrow(
      "hosted_codex_restore_permit_invalid",
    );
    const extra = signed({ ...claims, unapproved_scope: "no" });
    expect(() => verify(extra.token, extra.publicKeyPem)).toThrow(
      "hosted_codex_restore_permit_invalid",
    );
  });

  it("rejects a witnessed alias in either KMS scope", () => {
    for (const field of ["source_kms_key_arn", "target_kms_key_arn"] as const) {
      const fixture = signed({ ...claims, [field]: "alias/hosted-codex" });
      expect(() => verify(fixture.token, fixture.publicKeyPem)).toThrow(
        "hosted_codex_aws_kms_key_id_invalid",
      );
    }
  });
});

function signed(value: Record<string, unknown>) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64url",
  );
  const prefix = `rr-restore-v2.${payload}`;
  const signature = sign(
    null,
    Buffer.from(prefix, "utf8"),
    privateKey,
  ).toString("base64url");
  return {
    token: `${prefix}.${signature}`,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function verify(
  token: string,
  authorityPublicKeyPem: string,
  override: Partial<Parameters<typeof verifyHostedCodexRestorePermit>[0]> = {},
) {
  return verifyHostedCodexRestorePermit({
    token,
    authorityPublicKeyPem,
    expectedAuthorityKeyId: authorityKeyId,
    expectedDatabaseResourceIdentity: databaseResourceIdentity,
    expectedTargetIncarnation: targetIncarnation,
    expectedInventoryHash: inventoryHash,
    now,
    ...override,
  });
}
