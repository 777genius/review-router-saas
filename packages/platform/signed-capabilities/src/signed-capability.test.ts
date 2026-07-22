import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  CapabilityAudience,
  CapabilityKind,
  CapabilityVerificationError,
  CapabilityVerificationErrorCode,
  ConfiguredCapabilityKeyRing,
  JoseRotatingCapabilityCodec,
  type SignedCapabilityClaims,
} from "./index";
import { InMemoryCapabilityKeyRing } from "./testing";

const now = new Date("2026-07-22T12:00:00.000Z");
const firstKey = {
  keyId: "key-1",
  secret: new TextEncoder().encode("a".repeat(32)),
};

describe("signed capabilities", () => {
  it("binds exact audience, kind, identity, payload, and deadlines", async () => {
    const codec = new JoseRotatingCapabilityCodec(
      new InMemoryCapabilityKeyRing(firstKey),
    );
    const claims = leaseClaims();
    const signed = await codec.sign(claims);

    await expect(
      codec.verify({
        token: signed.token,
        expectedIssuer: "reviewrouter",
        expectedAudience: CapabilityAudience.ReviewInvocationLease,
        expectedKind: CapabilityKind.InvocationLease,
        now,
      }),
    ).resolves.toEqual(claims);
    await expect(
      codec.verify({
        token: signed.token,
        expectedIssuer: "reviewrouter",
        expectedAudience: CapabilityAudience.ReviewRun,
        expectedKind: CapabilityKind.InvocationLease,
        now,
      }),
    ).rejects.toMatchObject({
      code: CapabilityVerificationErrorCode.WrongAudience,
    });
    await expect(
      codec.verify({
        token: signed.token,
        expectedIssuer: "another-service",
        expectedAudience: CapabilityAudience.ReviewInvocationLease,
        expectedKind: CapabilityKind.InvocationLease,
        now,
      }),
    ).rejects.toMatchObject({
      code: CapabilityVerificationErrorCode.WrongIssuer,
    });
    await expect(
      codec.verify({
        token: signed.token,
        expectedIssuer: "reviewrouter",
        expectedAudience: CapabilityAudience.ReviewInvocationLease,
        expectedKind: CapabilityKind.CompletionCommand,
        now,
      }),
    ).rejects.toMatchObject({
      code: CapabilityVerificationErrorCode.WrongKind,
    });
  });

  it("rejects a signed token with multiple audiences or additional claims", async () => {
    const codec = new JoseRotatingCapabilityCodec(
      new InMemoryCapabilityKeyRing(firstKey),
    );
    const multiAudience = await rawToken({
      audience: [CapabilityAudience.ReviewInvocationLease, "other-service"],
    });
    const additionalClaim = await rawToken({ unexpected: true });

    await expect(
      codec.verify({
        token: multiAudience,
        expectedIssuer: "reviewrouter",
        expectedAudience: CapabilityAudience.ReviewInvocationLease,
        expectedKind: CapabilityKind.InvocationLease,
        now,
      }),
    ).rejects.toMatchObject({
      code: CapabilityVerificationErrorCode.WrongAudience,
    });
    await expect(
      codec.verify({
        token: additionalClaim,
        expectedIssuer: "reviewrouter",
        expectedAudience: CapabilityAudience.ReviewInvocationLease,
        expectedKind: CapabilityKind.InvocationLease,
        now,
      }),
    ).rejects.toMatchObject({ code: CapabilityVerificationErrorCode.Invalid });
  });

  it("keeps old signatures verifiable through rotation and fails after retirement", async () => {
    const keyRing = new InMemoryCapabilityKeyRing(firstKey);
    const codec = new JoseRotatingCapabilityCodec(keyRing);
    const first = await codec.sign(leaseClaims());
    keyRing.rotate({
      keyId: "key-2",
      secret: new TextEncoder().encode("b".repeat(32)),
    });
    await expect(
      codec.verify({
        token: first.token,
        expectedIssuer: "reviewrouter",
        expectedAudience: CapabilityAudience.ReviewInvocationLease,
        expectedKind: CapabilityKind.InvocationLease,
        now,
      }),
    ).resolves.toMatchObject({ capabilityId: "capability-1" });

    keyRing.retire("key-1");
    await expect(
      codec.verify({
        token: first.token,
        expectedIssuer: "reviewrouter",
        expectedAudience: CapabilityAudience.ReviewInvocationLease,
        expectedKind: CapabilityKind.InvocationLease,
        now,
      }),
    ).rejects.toEqual(
      new CapabilityVerificationError(
        CapabilityVerificationErrorCode.UnknownKey,
      ),
    );
  });

  it("retains historical verification keys only through their configured deadline", async () => {
    const keyRing = new ConfiguredCapabilityKeyRing({
      activeKeyId: "key-2",
      keys: [
        {
          ...firstKey,
          verifyUntil: new Date("2026-07-22T12:10:30.000Z"),
        },
        {
          keyId: "key-2",
          secret: new TextEncoder().encode("b".repeat(32)),
          verifyUntil: null,
        },
      ],
    });

    await expect(
      keyRing.verificationKey("key-1", new Date("2026-07-22T12:10:30.000Z")),
    ).resolves.toMatchObject({ keyId: "key-1" });
    await expect(
      keyRing.verificationKey("key-1", new Date("2026-07-22T12:10:31.000Z")),
    ).resolves.toBeNull();
  });

  it("enforces report expiry independently from ownership expiry", async () => {
    const codec = new JoseRotatingCapabilityCodec(
      new InMemoryCapabilityKeyRing(firstKey),
      0,
    );
    const signed = await codec.sign(leaseClaims());
    await expect(
      codec.verify({
        token: signed.token,
        expectedIssuer: "reviewrouter",
        expectedAudience: CapabilityAudience.ReviewInvocationLease,
        expectedKind: CapabilityKind.InvocationLease,
        now: new Date("2026-07-22T12:07:00.000Z"),
      }),
    ).resolves.toMatchObject({
      ownershipExpiresAt: new Date("2026-07-22T12:05:00.000Z"),
    });
    await expect(
      codec.verify({
        token: signed.token,
        expectedIssuer: "reviewrouter",
        expectedAudience: CapabilityAudience.ReviewInvocationLease,
        expectedKind: CapabilityKind.InvocationLease,
        now: new Date("2026-07-22T12:10:01.000Z"),
      }),
    ).rejects.toMatchObject({ code: CapabilityVerificationErrorCode.Expired });
  });
});

function leaseClaims(): SignedCapabilityClaims {
  return {
    capabilityId: "capability-1",
    kind: CapabilityKind.InvocationLease,
    audience: CapabilityAudience.ReviewInvocationLease,
    issuer: "reviewrouter",
    subject: "lease-1",
    issuedAt: now,
    notBefore: now,
    ownershipExpiresAt: new Date("2026-07-22T12:05:00.000Z"),
    expiresAt: new Date("2026-07-22T12:10:00.000Z"),
    payload: {
      leaseId: "lease-1",
      attemptId: "attempt-1",
      fencingToken: "42",
      ownerIdHash: "a".repeat(64),
    },
  };
}

async function rawToken(options: {
  readonly audience?: string | string[];
  readonly unexpected?: boolean;
}): Promise<string> {
  const claims = leaseClaims();
  return new SignJWT({
    capability_kind: claims.kind,
    ownership_exp: Math.floor(claims.ownershipExpiresAt!.getTime() / 1000),
    capability_payload: claims.payload,
    ...(options.unexpected ? { unexpected: true } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: firstKey.keyId })
    .setIssuer(claims.issuer)
    .setSubject(claims.subject)
    .setAudience(options.audience ?? claims.audience)
    .setJti(claims.capabilityId)
    .setIssuedAt(Math.floor(claims.issuedAt.getTime() / 1000))
    .setNotBefore(Math.floor(claims.notBefore.getTime() / 1000))
    .setExpirationTime(Math.floor(claims.expiresAt.getTime() / 1000))
    .sign(firstKey.secret);
}
