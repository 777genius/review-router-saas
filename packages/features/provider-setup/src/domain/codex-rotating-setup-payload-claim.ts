import { z } from "zod";

export const codexRotatingSetupPayloadClaimSchema = z
  .object({
    payloadVersion: z.literal(1),
    repositoryId: z.string().regex(/^[0-9]+$/),
    providerInstanceId: z.string().regex(/^[A-Za-z0-9_.:-]{8,160}$/),
    setupNonce: z.string().regex(/^[A-Za-z0-9_.:-]{8,160}$/),
    generationHash: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    accountFingerprint: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    authByteSize: z
      .number()
      .int()
      .positive()
      .max(32 * 1024),
    installerVersion: z.string().min(1).max(120),
  })
  .strict();

export type CodexRotatingSetupPayloadClaim = z.infer<
  typeof codexRotatingSetupPayloadClaimSchema
>;

export function codexRotatingSetupPayloadClaimsMatch(
  left: CodexRotatingSetupPayloadClaim,
  right: CodexRotatingSetupPayloadClaim,
): boolean {
  return (
    left.payloadVersion === right.payloadVersion &&
    left.repositoryId === right.repositoryId &&
    left.providerInstanceId === right.providerInstanceId &&
    left.setupNonce === right.setupNonce &&
    left.generationHash === right.generationHash &&
    left.accountFingerprint === right.accountFingerprint &&
    left.authByteSize === right.authByteSize &&
    left.installerVersion === right.installerVersion
  );
}
