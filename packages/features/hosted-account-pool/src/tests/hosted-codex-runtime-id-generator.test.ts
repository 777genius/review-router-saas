import { describe, expect, it } from "vitest";
import {
  CryptoSubscriptionRuntimeIdGenerator,
  extractChatgptAccountId,
  HostedCodexSessionStore,
} from "../infrastructure/runtime/hosted-codex-session-runtime";

describe("CryptoSubscriptionRuntimeIdGenerator", () => {
  it("uses collision-resistant instance-independent IDs and stable idempotency keys", () => {
    const left = new CryptoSubscriptionRuntimeIdGenerator();
    const right = new CryptoSubscriptionRuntimeIdGenerator();
    const input = {
      providerInstanceId: "account-1",
      runId: "run-1",
      attempt: 2,
      purpose: "refresh" as const,
    };
    expect(left.leaseId()).not.toBe(right.leaseId());
    expect(left.operationId("refresh")).not.toBe(right.operationId("refresh"));
    expect(left.idempotencyKey(input)).toBe(right.idempotencyKey(input));
    expect(left.idempotencyKey({ ...input, attempt: 3 })).not.toBe(
      left.idempotencyKey(input),
    );
  });
});

describe("HostedCodexSessionStore plaintext hygiene", () => {
  it("zeros persistence plaintext after a successful read", async () => {
    const bytes = Buffer.from(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "secret" },
      }),
    );
    const store = new HostedCodexSessionStore({
      read: async () => ({
        accountId: "account-1",
        authJsonBytes: bytes,
        generation: 1,
        generationHash: "a".repeat(64),
        storageVersion: "test",
      }),
      compareAndSwap: async () => {
        throw new Error("unused");
      },
    });
    await expect(
      store.read({ providerInstanceId: "account-1" }),
    ).resolves.toBeTruthy();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("zeros persistence plaintext when validation fails", async () => {
    const bytes = Buffer.from("not-json");
    const store = new HostedCodexSessionStore({
      read: async () => ({
        accountId: "account-1",
        authJsonBytes: bytes,
        generation: 1,
        generationHash: "a".repeat(64),
        storageVersion: "test",
      }),
      compareAndSwap: async () => {
        throw new Error("unused");
      },
    });
    await expect(
      store.read({ providerInstanceId: "account-1" }),
    ).rejects.toThrow();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });
});

describe("extractChatgptAccountId", () => {
  const jwt = (payload: unknown) =>
    `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

  it("extracts the exact server-owned ChatGPT account header value", () => {
    expect(
      extractChatgptAccountId(
        jwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct_workspace_1",
          },
        }),
      ),
    ).toBe("acct_workspace_1");
  });

  it("fails closed for missing or conflicting account claims", () => {
    expect(() => extractChatgptAccountId(jwt({ sub: "user" }))).toThrow(
      "hosted_codex_chatgpt_account_id_missing",
    );
    expect(() =>
      extractChatgptAccountId(
        jwt({
          chatgpt_account_id: "account-a",
          "https://api.openai.com/auth.chatgpt_account_id": "account-b",
        }),
      ),
    ).toThrow("hosted_codex_chatgpt_account_id_conflict");
  });
});
