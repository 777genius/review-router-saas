import { describe, expect, it } from "vitest";
import {
  decryptServerToken,
  encryptServerToken,
  getTokenEncryptionStatus,
} from "./token-crypto";

const env = {
  REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY:
    "test-token-encryption-secret-0123456789abcdef",
};

describe("token crypto", () => {
  it("encrypts and decrypts a token without exposing plaintext", () => {
    const encrypted = encryptServerToken("ghu_test_token", env);

    expect(encrypted).toMatch(/^v1:[A-Za-z0-9_-]+:/);
    expect(encrypted).not.toContain("ghu_test_token");
    expect(decryptServerToken(encrypted, env)).toBe("ghu_test_token");
  });

  it("rejects decryption with the wrong key", () => {
    const encrypted = encryptServerToken("ghu_test_token", env);

    expect(() =>
      decryptServerToken(encrypted, {
        REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY:
          "different-token-encryption-secret-0123456789",
      }),
    ).toThrow();
  });

  it("reports missing and short encryption keys", () => {
    expect(getTokenEncryptionStatus({})).toEqual({
      configured: false,
      reason: "missing",
      envName: "REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY",
    });
    expect(
      getTokenEncryptionStatus({
        REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY: "too-short",
      }),
    ).toEqual({
      configured: false,
      reason: "too_short",
      envName: "REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY",
    });
  });
});
