export enum CapabilityAudience {
  ReviewRun = "review_run",
  ReviewInvocationLease = "review_invocation_lease",
  ReviewInvestigationShadowLease = "review_investigation_shadow_lease",
  ReviewContextGatewaySeal = "review_context_gateway_seal",
  ReviewPublicationClaim = "review_publication_claim",
  ReviewPublicationOperation = "review_publication_operation",
  ReviewCompletionProcess = "review_completion_process",
}

export enum CapabilityKind {
  RunAuthorization = "run_authorization",
  InvocationLease = "invocation_lease",
  InvestigationShadowLease = "investigation_shadow_lease",
  ContextGatewaySeal = "context_gateway_seal",
  PublicationClaim = "publication_claim",
  PublicationOperation = "publication_operation",
  CompletionCommand = "completion_command",
}

export type SafeCapabilityClaimValue = string | number | boolean;

export type SignedCapabilityClaims = {
  readonly capabilityId: string;
  readonly kind: CapabilityKind;
  readonly audience: CapabilityAudience;
  readonly issuer: string;
  readonly subject: string;
  readonly issuedAt: Date;
  readonly notBefore: Date;
  readonly ownershipExpiresAt: Date | null;
  readonly expiresAt: Date;
  readonly payload: Readonly<Record<string, SafeCapabilityClaimValue>>;
};

const claimKeys = [
  "capabilityId",
  "kind",
  "audience",
  "issuer",
  "subject",
  "issuedAt",
  "notBefore",
  "ownershipExpiresAt",
  "expiresAt",
  "payload",
] as const;

export function validateSignedCapabilityClaims(
  input: unknown,
): SignedCapabilityClaims {
  if (!isRecord(input) || !hasExactKeys(input, claimKeys)) {
    throw new Error("capability_claims_invalid");
  }

  const capabilityId = boundedString(input.capabilityId, 160);
  const kind = enumValue(CapabilityKind, input.kind);
  const audience = enumValue(CapabilityAudience, input.audience);
  const issuer = boundedString(input.issuer, 160);
  const subject = boundedString(input.subject, 256);
  const issuedAt = validDate(input.issuedAt);
  const notBefore = validDate(input.notBefore);
  const ownershipExpiresAt =
    input.ownershipExpiresAt === null
      ? null
      : validDate(input.ownershipExpiresAt);
  const expiresAt = validDate(input.expiresAt);
  const payload = safePayload(input.payload);

  if (notBefore < issuedAt) {
    throw new Error("capability_not_before_precedes_issued_at");
  }
  if (expiresAt <= notBefore) {
    throw new Error("capability_expiry_not_after_not_before");
  }
  if (
    ownershipExpiresAt !== null &&
    (ownershipExpiresAt < notBefore || ownershipExpiresAt > expiresAt)
  ) {
    throw new Error("capability_ownership_expiry_out_of_bounds");
  }

  return {
    capabilityId,
    kind,
    audience,
    issuer,
    subject,
    issuedAt,
    notBefore,
    ownershipExpiresAt,
    expiresAt,
    payload,
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasExactKeys(
  input: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(input).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => key === actual[index])
  );
}

function boundedString(input: unknown, maximumLength: number): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximumLength
  ) {
    throw new Error("capability_claim_string_invalid");
  }
  return input;
}

function enumValue<T extends string>(
  values: Record<string, T>,
  input: unknown,
): T {
  if (
    typeof input !== "string" ||
    !Object.values(values).includes(input as T)
  ) {
    throw new Error("capability_claim_enum_invalid");
  }
  return input as T;
}

function validDate(input: unknown): Date {
  if (!(input instanceof Date) || !Number.isFinite(input.getTime())) {
    throw new Error("capability_claim_date_invalid");
  }
  return new Date(input);
}

function safePayload(
  input: unknown,
): Readonly<Record<string, SafeCapabilityClaimValue>> {
  if (!isRecord(input)) {
    throw new Error("capability_payload_invalid");
  }
  const result: Record<string, SafeCapabilityClaimValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.length === 0 || key.length > 96) {
      throw new Error("capability_payload_key_invalid");
    }
    if (typeof value === "string") {
      if (value.length === 0 || value.length > 512) {
        throw new Error("capability_payload_value_invalid");
      }
      result[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      result[key] = value;
      continue;
    }
    throw new Error("capability_payload_value_invalid");
  }
  return Object.freeze(result);
}

export type SignedCapability = {
  readonly token: string;
  readonly capabilityId: string;
  readonly signingKeyId: string;
  readonly expiresAt: Date;
};

export enum CapabilityVerificationErrorCode {
  Invalid = "invalid",
  UnknownKey = "unknown_key",
  WrongIssuer = "wrong_issuer",
  WrongAudience = "wrong_audience",
  WrongKind = "wrong_kind",
  NotYetValid = "not_yet_valid",
  Expired = "expired",
}

export class CapabilityVerificationError extends Error {
  constructor(readonly code: CapabilityVerificationErrorCode) {
    super(`signed_capability_${code}`);
    this.name = "CapabilityVerificationError";
  }
}
