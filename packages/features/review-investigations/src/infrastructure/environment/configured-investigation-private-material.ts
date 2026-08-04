import {
  assertInvestigationPrivateMaterialTtl,
  investigationPrivateMaterialDefaultTtlMs,
} from "../../domain/investigation-private-material";
import { AesGcmInvestigationPrivateMaterialCipher } from "../crypto/aes-gcm-investigation-private-material-cipher";

export const investigationPrivateMaterialActiveKeyIdEnvironmentVariable =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_ACTIVE_KEY_ID" as const;
export const investigationPrivateMaterialKeysEnvironmentVariable =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_KEYS_JSON" as const;
export const investigationPrivateMaterialTtlEnvironmentVariable =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRIVATE_MATERIAL_TTL_MS" as const;
export const investigationRetentionMaintenanceEnabledEnvironmentVariable =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_MAINTENANCE_ENABLED" as const;

export type ConfiguredInvestigationPrivateMaterial = Readonly<{
  cipher: AesGcmInvestigationPrivateMaterialCipher;
  ttlMs: number;
}>;

export function loadConfiguredInvestigationPrivateMaterial(
  environment: Readonly<Record<string, string | undefined>>,
): ConfiguredInvestigationPrivateMaterial | null {
  const activeKeyId = normalized(
    environment[investigationPrivateMaterialActiveKeyIdEnvironmentVariable],
  );
  const keysJson = normalized(
    environment[investigationPrivateMaterialKeysEnvironmentVariable],
  );
  const ttlValue = normalized(
    environment[investigationPrivateMaterialTtlEnvironmentVariable],
  );
  if (!activeKeyId && !keysJson && !ttlValue) return null;
  if (!activeKeyId || !keysJson) {
    throw new Error("investigation_private_material_configuration_incomplete");
  }
  const ttlMs = ttlValue
    ? parsePositiveInteger(ttlValue)
    : investigationPrivateMaterialDefaultTtlMs;
  assertInvestigationPrivateMaterialTtl(ttlMs);
  return Object.freeze({
    cipher: new AesGcmInvestigationPrivateMaterialCipher(
      activeKeyId,
      parseKeys(keysJson),
    ),
    ttlMs,
  });
}

function parseKeys(value: string): ReadonlyMap<string, Uint8Array> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("investigation_private_material_keys_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("investigation_private_material_keys_invalid");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > 16) {
    throw new Error("investigation_private_material_keys_invalid");
  }
  const keys = new Map<string, Uint8Array>();
  for (const [keyId, encoded] of entries) {
    if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
      throw new Error("investigation_private_material_keys_invalid");
    }
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== encoded) {
      throw new Error("investigation_private_material_keys_invalid");
    }
    keys.set(keyId, key);
  }
  return keys;
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("investigation_private_material_ttl_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("investigation_private_material_ttl_invalid");
  }
  return parsed;
}

function normalized(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  return value.trim();
}
