import type {
  CapabilityAudience,
  CapabilityKind,
  SignedCapability,
  SignedCapabilityClaims,
} from "../domain/signed-capability";

export interface SignedCapabilityCodecPort {
  sign(claims: SignedCapabilityClaims): Promise<SignedCapability>;
  verify(
    input: SignedCapabilityVerificationInput,
  ): Promise<SignedCapabilityClaims>;
  /** Optional for legacy codecs; metadata consumers must fail closed if absent. */
  verifyWithMetadata?(
    input: SignedCapabilityVerificationInput,
  ): Promise<VerifiedSignedCapability>;
}

export type CapabilitySigningKey = {
  readonly keyId: string;
  readonly secret: Uint8Array;
};

export interface CapabilityKeyRingPort {
  activeSigningKey(): Promise<CapabilitySigningKey>;
  verificationKey(
    keyId: string,
    verificationTime: Date,
  ): Promise<CapabilitySigningKey | null>;
}

/** Verification uses the caller's current time, never a historical replay clock. */
export type SignedCapabilityVerificationInput = {
  readonly token: string;
  readonly expectedIssuer: string;
  readonly expectedAudience: CapabilityAudience;
  readonly expectedKind: CapabilityKind;
  readonly now: Date;
};

export type VerifiedSignedCapability = {
  readonly claims: SignedCapabilityClaims;
  readonly authenticatedKeyId: string;
};
