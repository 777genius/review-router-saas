import { validateCodexAuthJsonBytes } from "@777genius/subscription-runtime/provider-codex";
import { stableAccountFingerprint } from "../crypto/credential-envelope-vault.js";

export function fingerprintCodexAuthJson(
  authJsonBytes: Uint8Array,
  pepper: Uint8Array,
): string {
  const parsed = validateCodexAuthJsonBytes({
    authJsonBytes: Buffer.from(authJsonBytes).toString("utf8"),
  }).parsed;
  const idToken = parsed.tokens.id_token;
  if (!idToken) throw new Error("hosted_codex_identity_token_missing");
  return stableAccountFingerprint({
    canonicalSubject: canonicalCodexAccountSubject(idToken),
    pepper,
  });
}

export function canonicalCodexAccountSubject(idToken: string): string {
  let claims: Record<string, unknown>;
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3 || !parts[1]) throw new Error("jwt_shape");
    claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw new Error("hosted_codex_identity_token_invalid");
  }
  const auth = claims["https://api.openai.com/auth"];
  const nested =
    auth && typeof auth === "object" && !Array.isArray(auth)
      ? (auth as Record<string, unknown>)
      : {};
  const accountIds = [
    claims.chatgpt_account_id,
    claims.account_id,
    claims["https://api.openai.com/auth.chatgpt_account_id"],
    nested.chatgpt_account_id,
    nested.account_id,
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );
  if (new Set(accountIds).size !== 1) {
    throw new Error("hosted_codex_account_identity_invalid");
  }
  return JSON.stringify({
    issuer: stableClaim(claims.iss),
    subject: stableClaim(claims.sub),
    chatgptAccountId: accountIds[0],
  });
}

function stableClaim(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("hosted_codex_identity_claim_invalid");
  }
  return value;
}
