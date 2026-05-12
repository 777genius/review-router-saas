import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const tokenCipherVersion = "v1";
const tokenCipherAlgorithm = "aes-256-gcm";
const tokenEncryptionEnvName = "REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY";
const minimumSecretLength = 32;

export type TokenEncryptionStatus =
  | { readonly configured: true }
  | {
      readonly configured: false;
      readonly reason: "missing" | "too_short";
      readonly envName: typeof tokenEncryptionEnvName;
    };

type TokenCryptoEnvironment = {
  readonly [key: string]: string | undefined;
};

export function getTokenEncryptionStatus(
  env: TokenCryptoEnvironment = process.env,
): TokenEncryptionStatus {
  const secret = env[tokenEncryptionEnvName]?.trim() ?? "";
  if (!secret) {
    return {
      configured: false,
      reason: "missing",
      envName: tokenEncryptionEnvName,
    };
  }
  if (secret.length < minimumSecretLength) {
    return {
      configured: false,
      reason: "too_short",
      envName: tokenEncryptionEnvName,
    };
  }

  return { configured: true };
}

export function encryptServerToken(
  plaintext: string,
  env: TokenCryptoEnvironment = process.env,
): string {
  if (!plaintext) {
    throw new Error("token_crypto_empty_plaintext");
  }

  const key = deriveTokenEncryptionKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv(tokenCipherAlgorithm, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    tokenCipherVersion,
    base64UrlEncode(iv),
    base64UrlEncode(tag),
    base64UrlEncode(ciphertext),
  ].join(":");
}

export function decryptServerToken(
  payload: string,
  env: TokenCryptoEnvironment = process.env,
): string {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded, extra] =
    payload.split(":");
  if (
    version !== tokenCipherVersion ||
    !ivEncoded ||
    !tagEncoded ||
    !ciphertextEncoded ||
    extra !== undefined
  ) {
    throw new Error("token_crypto_invalid_payload");
  }

  const key = deriveTokenEncryptionKey(env);
  const decipher = createDecipheriv(
    tokenCipherAlgorithm,
    key,
    base64UrlDecode(ivEncoded),
  );
  decipher.setAuthTag(base64UrlDecode(tagEncoded));

  return Buffer.concat([
    decipher.update(base64UrlDecode(ciphertextEncoded)),
    decipher.final(),
  ]).toString("utf8");
}

function deriveTokenEncryptionKey(env: TokenCryptoEnvironment): Buffer {
  const status = getTokenEncryptionStatus(env);
  if (!status.configured) {
    throw new Error(`missing_env:${status.envName}`);
  }

  const secret = env[tokenEncryptionEnvName]?.trim() ?? "";
  return createHash("sha256").update(secret, "utf8").digest();
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
