import { describe, expect, it } from "vitest";
import {
  investigationPrivateMaterialActiveKeyIdEnvironmentVariable,
  investigationPrivateMaterialKeysEnvironmentVariable,
  investigationPrivateMaterialTtlEnvironmentVariable,
  loadConfiguredInvestigationPrivateMaterial,
} from "../infrastructure/environment/configured-investigation-private-material";

describe("configured investigation private material", () => {
  it("loads a bounded AES-256-GCM keyring without exposing key bytes", () => {
    const current = Buffer.alloc(32, 3).toString("base64url");
    const previous = Buffer.alloc(32, 7).toString("base64url");
    const configuration = loadConfiguredInvestigationPrivateMaterial({
      [investigationPrivateMaterialActiveKeyIdEnvironmentVariable]: "key-2",
      [investigationPrivateMaterialKeysEnvironmentVariable]: JSON.stringify({
        "key-1": previous,
        "key-2": current,
      }),
      [investigationPrivateMaterialTtlEnvironmentVariable]: "3600000",
    });

    expect(configuration).toMatchObject({ ttlMs: 3_600_000 });
    expect(JSON.stringify(configuration)).not.toContain(current);
    expect(JSON.stringify(configuration)).not.toContain(previous);
  });

  it("returns null only when the complete feature configuration is absent", () => {
    expect(loadConfiguredInvestigationPrivateMaterial({})).toBeNull();
    expect(() =>
      loadConfiguredInvestigationPrivateMaterial({
        [investigationPrivateMaterialTtlEnvironmentVariable]: "3600000",
      }),
    ).toThrow("investigation_private_material_configuration_incomplete");
  });

  it.each([
    ["too short key", Buffer.alloc(31).toString("base64url"), "3600000"],
    [
      "non-canonical key",
      `${Buffer.alloc(32).toString("base64url")}=`,
      "3600000",
    ],
    ["ttl below minimum", Buffer.alloc(32).toString("base64url"), "59999"],
    [
      "ttl above maximum",
      Buffer.alloc(32).toString("base64url"),
      String(7 * 24 * 60 * 60 * 1_000 + 1),
    ],
  ])("rejects %s", (_name, encodedKey, ttlMs) => {
    expect(() =>
      loadConfiguredInvestigationPrivateMaterial({
        [investigationPrivateMaterialActiveKeyIdEnvironmentVariable]: "key-1",
        [investigationPrivateMaterialKeysEnvironmentVariable]: JSON.stringify({
          "key-1": encodedKey,
        }),
        [investigationPrivateMaterialTtlEnvironmentVariable]: ttlMs,
      }),
    ).toThrow();
  });
});
