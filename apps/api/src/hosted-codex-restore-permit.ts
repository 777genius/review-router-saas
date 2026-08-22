import { createPublicKey, verify } from "node:crypto";
import {
  requireKeyArn,
  type HostedCodexRestorePermit,
} from "@reviewrouter/features-hosted-account-pool";

type RestorePermitClaims = {
  readonly v: 2;
  readonly inventory_hash: string;
  readonly database_resource_identity: string;
  readonly source_incarnation: string;
  readonly target_incarnation: string;
  readonly source_kms_key_arn: string;
  readonly target_kms_key_arn: string;
  readonly authority_key_id: string;
  readonly actor_id: string;
  readonly nonce: string;
  readonly expires_at: string;
};

/** Verifies a recovery-control-plane witness with a public Ed25519 key only. */
export function verifyHostedCodexRestorePermit(input: {
  readonly token: string;
  readonly authorityPublicKeyPem: string;
  readonly expectedAuthorityKeyId: string;
  readonly expectedDatabaseResourceIdentity: string;
  readonly expectedTargetIncarnation: string;
  readonly expectedInventoryHash: string;
  readonly now?: Date;
}): HostedCodexRestorePermit {
  const parts = input.token.split(".");
  if (parts.length !== 3 || parts[0] !== "rr-restore-v2") {
    throw new Error("hosted_codex_restore_permit_invalid");
  }
  const payload = parts[1]!;
  const signature = decodeBase64Url(parts[2]!);
  let verified = false;
  try {
    verified = verify(
      null,
      Buffer.from(`rr-restore-v2.${payload}`, "utf8"),
      createPublicKey(input.authorityPublicKeyPem),
      signature,
    );
  } catch {
    throw new Error("hosted_codex_restore_permit_invalid");
  } finally {
    signature.fill(0);
  }
  if (!verified) throw new Error("hosted_codex_restore_permit_invalid");
  const claims = parseClaims(decodeBase64Url(payload).toString("utf8"));
  const expiresAt = new Date(claims.expires_at);
  const now = input.now ?? new Date();
  if (
    claims.inventory_hash !== input.expectedInventoryHash ||
    claims.database_resource_identity !==
      input.expectedDatabaseResourceIdentity ||
    claims.target_incarnation !== input.expectedTargetIncarnation ||
    claims.authority_key_id !== input.expectedAuthorityKeyId ||
    claims.source_incarnation === claims.target_incarnation ||
    !/^[a-f0-9]{64}$/u.test(claims.inventory_hash) ||
    claims.database_resource_identity.length < 16 ||
    claims.nonce.length < 32 ||
    claims.actor_id.length < 3 ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt.getTime() - now.getTime() > 24 * 60 * 60_000
  ) {
    throw new Error("hosted_codex_restore_permit_scope_invalid");
  }
  requireKeyArn(claims.source_kms_key_arn);
  requireKeyArn(claims.target_kms_key_arn);
  return {
    inventoryHash: claims.inventory_hash,
    databaseResourceIdentity: claims.database_resource_identity,
    sourceIncarnation: claims.source_incarnation,
    targetIncarnation: claims.target_incarnation,
    sourceKmsKeyArn: claims.source_kms_key_arn,
    targetKmsKeyArn: claims.target_kms_key_arn,
    authorityKeyId: claims.authority_key_id,
    actorId: claims.actor_id,
    nonce: claims.nonce,
    expiresAt,
  };
}

function parseClaims(json: string): RestorePermitClaims {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("hosted_codex_restore_permit_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("hosted_codex_restore_permit_invalid");
  }
  const claims = value as Record<string, unknown>;
  const exactKeys = [
    "actor_id",
    "authority_key_id",
    "database_resource_identity",
    "expires_at",
    "inventory_hash",
    "nonce",
    "source_incarnation",
    "source_kms_key_arn",
    "target_incarnation",
    "target_kms_key_arn",
    "v",
  ];
  if (
    Object.keys(claims).sort().join("\u0000") !== exactKeys.join("\u0000") ||
    claims.v !== 2 ||
    exactKeys.slice(0, -1).some((key) => typeof claims[key] !== "string")
  ) {
    throw new Error("hosted_codex_restore_permit_invalid");
  }
  return claims as RestorePermitClaims;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("hosted_codex_restore_permit_invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new Error("hosted_codex_restore_permit_invalid");
  }
  return decoded;
}
