import { describe, expect, it } from "vitest";
import {
  collectPayloadStrings,
  looksLikeCodeOrDiff,
  looksLikeSecretValue,
} from "./index.js";

describe("safe payload helpers", () => {
  it("collects bounded strings from nested payloads with key=value context", () => {
    expect(
      collectPayloadStrings({
        provider: { safeErrorCategory: "provider_auth_missing" },
        attempts: ["one", "two"],
      }),
    ).toEqual([
      "provider",
      "safeErrorCategory",
      "safeErrorCategory=provider_auth_missing",
      "provider_auth_missing",
      "attempts",
      "one",
      "two",
    ]);
  });

  it("does not recurse forever on cyclic objects", () => {
    const payload: Record<string, unknown> = { message: "safe" };
    payload.self = payload;

    expect(collectPayloadStrings(payload)).toContain("message=safe");
  });

  it("detects diff and common source-code snippets", () => {
    expect(looksLikeCodeOrDiff("@@ -1,2 +1,2 @@\n- old\n+ new")).toBe(true);
    expect(
      looksLikeCodeOrDiff("async function findUserByEmail(db, email) {"),
    ).toBe(true);
    expect(looksLikeCodeOrDiff("const rows = await db.query(sql)")).toBe(true);
  });

  it("does not classify ordinary setup guidance as code", () => {
    expect(
      looksLikeCodeOrDiff(
        "CODEX_AUTH_JSON secret is missing. reseed auth.json from a trusted machine.",
      ),
    ).toBe(false);
  });

  it("detects common secret formats and key names", () => {
    expect(looksLikeSecretValue("OPENAI_API_KEY=sk-abc12345678901234567")).toBe(
      true,
    );
    expect(looksLikeSecretValue("Authorization: Bearer abcdefghijklmnop")).toBe(
      true,
    );
    expect(looksLikeSecretValue("refresh_token=opaque-refresh-token")).toBe(
      true,
    );
    expect(looksLikeSecretValue("nonce=raw-dispatch-nonce")).toBe(true);
    expect(looksLikeSecretValue("DISPATCH_NONCE: raw-dispatch-nonce")).toBe(
      true,
    );
  });

  it("keeps enough long-string context to detect unsafe tail content", () => {
    const payload = {
      safeErrorSummary:
        "provider failed after retries " +
        "x".repeat(8_000) +
        " OPENAI_API_KEY=sk-abc12345678901234567",
      rawOutput:
        "provider failed after retries " +
        "x".repeat(8_000) +
        "\ndiff --git a/src/app.ts b/src/app.ts",
    };

    const values = collectPayloadStrings(payload);

    expect(values.some(looksLikeSecretValue)).toBe(true);
    expect(values.some(looksLikeCodeOrDiff)).toBe(true);
  });
});
