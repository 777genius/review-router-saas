import { describe, expect, it } from "vitest";
import { resolveHostedCodexKeyring } from "./hosted-codex-keyring.js";

describe("hosted Codex production keyring", () => {
  it("rejects local envelope keys in production", () => {
    expect(() =>
      resolveHostedCodexKeyring({
        env: {
          NODE_ENV: "production",
          REVIEW_ROUTER_HOSTED_CODEX_KEYRING_MODE: "local_env",
        },
      }),
    ).toThrow("hosted_codex_external_kms_required");
    expect(() =>
      resolveHostedCodexKeyring({
        env: {
          NODE_ENV: "production",
          REVIEW_ROUTER_HOSTED_CODEX_KEYRING_MODE: "external_kms",
          REVIEW_ROUTER_HOSTED_CODEX_KMS_ROLE: "relay",
        },
      }),
    ).toThrow("hosted_codex_aws_kms_key_id_missing");
  });

  it("accepts an injected external keyring in production", () => {
    const externalKeyring = {
      custodyMode: "aws_kms" as const,
      currentKeyId:
        "arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555",
      wrapDataEncryptionKey: async () => ({
        keyId:
          "arn:aws:kms:eu-west-1:123456789012:key/11111111-2222-3333-4444-555555555555",
        nonce: "nonce",
        ciphertext: "ciphertext",
        authenticationTag: "tag",
      }),
      unwrapDataEncryptionKey: async () => Buffer.alloc(32),
    };
    expect(
      resolveHostedCodexKeyring({
        env: {
          NODE_ENV: "production",
          REVIEW_ROUTER_HOSTED_CODEX_KEYRING_MODE: "external_kms",
          REVIEW_ROUTER_HOSTED_CODEX_KMS_ROLE: "relay",
        },
        externalKeyring,
      }),
    ).toBe(externalKeyring);
  });
});
