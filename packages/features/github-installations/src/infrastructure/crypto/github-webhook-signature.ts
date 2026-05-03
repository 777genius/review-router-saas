import { createHmac, timingSafeEqual } from "node:crypto";

const signaturePrefix = "sha256=";

export function signGitHubWebhookPayload(
  payload: Buffer | string,
  secret: string,
): string {
  return `${signaturePrefix}${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export function verifyGitHubWebhookSignature(input: {
  readonly payload: Buffer | string;
  readonly signatureHeader: string | undefined;
  readonly secret: string;
}): boolean {
  if (!input.signatureHeader?.startsWith(signaturePrefix)) return false;

  const expected = Buffer.from(
    signGitHubWebhookPayload(input.payload, input.secret),
    "utf8",
  );
  const actual = Buffer.from(input.signatureHeader, "utf8");

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
