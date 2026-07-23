import type {
  CapabilityAudience,
  CapabilityKind,
  SignedCapability,
  SignedCapabilityClaims,
} from "../domain/signed-capability";

export interface SignedCapabilityCodecPort {
  sign(claims: SignedCapabilityClaims): Promise<SignedCapability>;
  verify(input: {
    readonly token: string;
    readonly expectedIssuer: string;
    readonly expectedAudience: CapabilityAudience;
    readonly expectedKind: CapabilityKind;
    readonly now: Date;
  }): Promise<SignedCapabilityClaims>;
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
