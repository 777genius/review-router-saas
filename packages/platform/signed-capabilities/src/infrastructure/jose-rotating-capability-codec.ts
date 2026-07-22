import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import {
  CapabilityAudience,
  CapabilityKind,
  CapabilityVerificationError,
  CapabilityVerificationErrorCode,
  validateSignedCapabilityClaims,
  type SignedCapability,
  type SignedCapabilityClaims,
} from "../domain/signed-capability";
import type {
  CapabilityKeyRingPort,
  SignedCapabilityCodecPort,
} from "../application/signed-capability-codec-port";

export class JoseRotatingCapabilityCodec implements SignedCapabilityCodecPort {
  constructor(
    private readonly keyRing: CapabilityKeyRingPort,
    private readonly maximumClockSkewSeconds = 30,
  ) {
    if (
      !Number.isSafeInteger(maximumClockSkewSeconds) ||
      maximumClockSkewSeconds < 0 ||
      maximumClockSkewSeconds > 300
    ) {
      throw new Error("capability_clock_skew_invalid");
    }
  }

  async sign(claims: SignedCapabilityClaims): Promise<SignedCapability> {
    const parsed = validateSignedCapabilityClaims(claims);
    const key = await this.keyRing.activeSigningKey();
    assertSigningKey(key.keyId, key.secret);
    const token = await new SignJWT({
      capability_kind: parsed.kind,
      ownership_exp: parsed.ownershipExpiresAt
        ? Math.floor(parsed.ownershipExpiresAt.getTime() / 1000)
        : null,
      capability_payload: parsed.payload,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: key.keyId })
      .setIssuer(parsed.issuer)
      .setSubject(parsed.subject)
      .setAudience(parsed.audience)
      .setJti(parsed.capabilityId)
      .setIssuedAt(Math.floor(parsed.issuedAt.getTime() / 1000))
      .setNotBefore(Math.floor(parsed.notBefore.getTime() / 1000))
      .setExpirationTime(Math.floor(parsed.expiresAt.getTime() / 1000))
      .sign(key.secret);
    return {
      token,
      capabilityId: parsed.capabilityId,
      signingKeyId: key.keyId,
      expiresAt: parsed.expiresAt,
    };
  }

  async verify(input: {
    readonly token: string;
    readonly expectedIssuer: string;
    readonly expectedAudience: CapabilityAudience;
    readonly expectedKind: CapabilityKind;
    readonly now: Date;
  }): Promise<SignedCapabilityClaims> {
    let keyId: string;
    try {
      const header = decodeProtectedHeader(input.token);
      if (header.alg !== "HS256" || header.typ !== "JWT" || !header.kid) {
        throw new Error("header_invalid");
      }
      keyId = header.kid;
    } catch {
      throw new CapabilityVerificationError(
        CapabilityVerificationErrorCode.Invalid,
      );
    }
    const key = await this.keyRing.verificationKey(keyId, input.now);
    if (!key) {
      throw new CapabilityVerificationError(
        CapabilityVerificationErrorCode.UnknownKey,
      );
    }
    assertSigningKey(key.keyId, key.secret);
    if (key.keyId !== keyId) {
      throw new CapabilityVerificationError(
        CapabilityVerificationErrorCode.UnknownKey,
      );
    }

    try {
      const { payload } = await jwtVerify(input.token, key.secret, {
        algorithms: ["HS256"],
        issuer: input.expectedIssuer,
        audience: input.expectedAudience,
        clockTolerance: this.maximumClockSkewSeconds,
        currentDate: input.now,
      });
      if (payload.capability_kind !== input.expectedKind) {
        throw new CapabilityVerificationError(
          CapabilityVerificationErrorCode.WrongKind,
        );
      }
      if (!hasExactJwtPayloadKeys(payload)) {
        throw new CapabilityVerificationError(
          CapabilityVerificationErrorCode.Invalid,
        );
      }
      if (payload.iss !== input.expectedIssuer) {
        throw new CapabilityVerificationError(
          CapabilityVerificationErrorCode.WrongIssuer,
        );
      }
      if (payload.aud !== input.expectedAudience) {
        throw new CapabilityVerificationError(
          CapabilityVerificationErrorCode.WrongAudience,
        );
      }
      return validateSignedCapabilityClaims({
        capabilityId: payload.jti,
        kind: payload.capability_kind,
        audience: payload.aud,
        issuer: payload.iss,
        subject: payload.sub,
        issuedAt: fromNumericDate(payload.iat),
        notBefore: fromNumericDate(payload.nbf),
        ownershipExpiresAt:
          payload.ownership_exp === null
            ? null
            : fromNumericDate(payload.ownership_exp),
        expiresAt: fromNumericDate(payload.exp),
        payload: payload.capability_payload,
      });
    } catch (error) {
      if (error instanceof CapabilityVerificationError) throw error;
      const code = joseErrorCode(error);
      throw new CapabilityVerificationError(code);
    }
  }
}

function fromNumericDate(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("numeric_date_invalid");
  }
  return new Date(value * 1000);
}

function assertSigningKey(keyId: string, secret: Uint8Array): void {
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(keyId) || secret.byteLength < 32) {
    throw new Error("capability_signing_key_invalid");
  }
}

function joseErrorCode(error: unknown): CapabilityVerificationErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "ERR_JWT_EXPIRED") {
      return CapabilityVerificationErrorCode.Expired;
    }
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      const claim = (error as { readonly claim?: unknown }).claim;
      if (claim === "nbf") return CapabilityVerificationErrorCode.NotYetValid;
      if (claim === "aud") return CapabilityVerificationErrorCode.WrongAudience;
      if (claim === "iss") return CapabilityVerificationErrorCode.WrongIssuer;
    }
  }
  return CapabilityVerificationErrorCode.Invalid;
}

const expectedJwtPayloadKeys = [
  "aud",
  "capability_kind",
  "capability_payload",
  "exp",
  "iat",
  "iss",
  "jti",
  "nbf",
  "ownership_exp",
  "sub",
] as const;

function hasExactJwtPayloadKeys(input: Record<string, unknown>): boolean {
  const actual = Object.keys(input).sort();
  return (
    actual.length === expectedJwtPayloadKeys.length &&
    [...expectedJwtPayloadKeys]
      .sort()
      .every((key, index) => key === actual[index])
  );
}
