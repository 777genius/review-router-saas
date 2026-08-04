const maximumAuthoritativeObservationCount = 1_024;
const maximumObservationIdentifierLength = 512;

export enum ReviewProjectionAuthoritySource {
  Explicit = "explicit",
  LegacyOccurrenceLineage = "legacy_occurrence_lineage",
}

export type ReviewProjectionObservationAuthority = Readonly<{
  source: ReviewProjectionAuthoritySource;
  observationIds: readonly string[];
}>;

/**
 * Resolves the observations that actually contributed to the authoritative
 * projection. Older projection.v1 envelopes fall back to occurrence lineage.
 */
export function authoritativeReviewProjectionObservationIds(
  envelope: unknown,
): readonly string[] {
  return reviewProjectionObservationAuthority(envelope).observationIds;
}

export function reviewProjectionObservationAuthority(
  envelope: unknown,
): ReviewProjectionObservationAuthority {
  const projection = record(envelope, "projection_envelope_invalid");
  if (projection.authoritativeObservationIds !== undefined) {
    const authoritative = identifiers(
      projection.authoritativeObservationIds,
      "projection_authoritative_observation_ids_invalid",
    );
    const authoritativeSet = new Set(authoritative);
    for (const occurrenceObservationId of occurrenceObservationIds(
      projection,
    )) {
      if (!authoritativeSet.has(occurrenceObservationId)) {
        throw new Error("projection_occurrence_authority_mismatch");
      }
    }
    return Object.freeze({
      source: ReviewProjectionAuthoritySource.Explicit,
      observationIds: authoritative,
    });
  }

  return Object.freeze({
    source: ReviewProjectionAuthoritySource.LegacyOccurrenceLineage,
    observationIds: Object.freeze(
      [...new Set(occurrenceObservationIds(projection))].sort(),
    ),
  });
}

function occurrenceObservationIds(
  projection: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (!Array.isArray(projection.occurrences)) {
    throw new Error("projection_occurrences_invalid");
  }
  const result: string[] = [];
  for (const candidate of projection.occurrences) {
    const occurrence = record(candidate, "projection_occurrence_invalid");
    for (const observationId of identifiers(
      occurrence.observationIds,
      "projection_occurrence_observation_ids_invalid",
      false,
    )) {
      result.push(observationId);
    }
  }
  return result;
}

export function authoritativeReviewProjectionObservationIdsFromJson(
  projectionEnvelopeJson: string,
): readonly string[] {
  return reviewProjectionObservationAuthorityFromJson(projectionEnvelopeJson)
    .observationIds;
}

export function reviewProjectionObservationAuthorityFromJson(
  projectionEnvelopeJson: string,
): ReviewProjectionObservationAuthority {
  let envelope: unknown;
  try {
    envelope = JSON.parse(projectionEnvelopeJson);
  } catch {
    throw new Error("projection_envelope_json_invalid");
  }
  return reviewProjectionObservationAuthority(envelope);
}

function identifiers(
  value: unknown,
  code: string,
  requireSorted = true,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumAuthoritativeObservationCount ||
    value.some(
      (candidate) =>
        typeof candidate !== "string" ||
        candidate.length === 0 ||
        candidate.length > maximumObservationIdentifierLength ||
        candidate.trim() !== candidate,
    )
  ) {
    throw new Error(code);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new Error(code);
  if (
    requireSorted &&
    result.some(
      (candidate, index) => index > 0 && result[index - 1]! >= candidate,
    )
  ) {
    throw new Error(code);
  }
  return Object.freeze([...result]);
}

function record(
  value: unknown,
  code: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Readonly<Record<string, unknown>>;
}
