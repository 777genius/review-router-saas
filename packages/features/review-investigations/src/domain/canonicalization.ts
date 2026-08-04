export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ReviewInvestigationDomainError("non_finite_canonical_number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new ReviewInvestigationDomainError("unsupported_canonical_value");
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function assertIdentifier(value: string, field: string): void {
  assertBoundedText(value, field, 512);
}

export function assertBoundedText(
  value: string,
  field: string,
  maximumLength: number,
): void {
  if (
    !Number.isSafeInteger(maximumLength) ||
    maximumLength < 1 ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    containsControlCharacter(value)
  ) {
    throw new ReviewInvestigationDomainError(`${field}_invalid`);
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

export function assertDigest(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new ReviewInvestigationDomainError(`${field}_invalid`);
  }
}

export function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReviewInvestigationDomainError(`${field}_invalid`);
  }
}

export function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReviewInvestigationDomainError(`${field}_invalid`);
  }
}

export class ReviewInvestigationDomainError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReviewInvestigationDomainError";
  }
}
