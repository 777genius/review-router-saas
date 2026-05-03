import { describe, expect, it } from "vitest";
import {
  signGitHubWebhookPayload,
  verifyGitHubWebhookSignature,
} from "../infrastructure/crypto/github-webhook-signature";

describe("GitHub webhook signature", () => {
  it("accepts matching sha256 signatures", () => {
    const payload = Buffer.from('{"action":"created"}');
    const signature = signGitHubWebhookPayload(payload, "secret");

    expect(
      verifyGitHubWebhookSignature({
        payload,
        signatureHeader: signature,
        secret: "secret",
      }),
    ).toBe(true);
  });

  it("rejects tampered payloads", () => {
    const signature = signGitHubWebhookPayload("original", "secret");

    expect(
      verifyGitHubWebhookSignature({
        payload: "changed",
        signatureHeader: signature,
        secret: "secret",
      }),
    ).toBe(false);
  });
});
