import { describe, expect, it } from "vitest";
import {
  authoritativeReviewProjectionObservationIds,
  authoritativeReviewProjectionObservationIdsFromJson,
  reviewProjectionObservationAuthority,
  ReviewProjectionAuthoritySource,
} from "../domain/review-projection-authority";

describe("authoritative review projection observation lineage", () => {
  it("uses the explicit sorted authority set, including clean projections", () => {
    expect(
      authoritativeReviewProjectionObservationIds({
        authoritativeObservationIds: ["observation-a", "observation-b"],
        occurrences: [],
      }),
    ).toEqual(["observation-a", "observation-b"]);
  });

  it("falls back to deduplicated occurrence lineage for legacy envelopes", () => {
    expect(
      authoritativeReviewProjectionObservationIds({
        occurrences: [
          { observationIds: ["observation-b", "observation-a"] },
          { observationIds: ["observation-a"] },
        ],
      }),
    ).toEqual(["observation-a", "observation-b"]);
  });

  it("reports whether authority is explicit or legacy occurrence lineage", () => {
    expect(
      reviewProjectionObservationAuthority({
        authoritativeObservationIds: [],
        occurrences: [],
      }),
    ).toEqual({
      source: ReviewProjectionAuthoritySource.Explicit,
      observationIds: [],
    });
    expect(reviewProjectionObservationAuthority({ occurrences: [] })).toEqual({
      source: ReviewProjectionAuthoritySource.LegacyOccurrenceLineage,
      observationIds: [],
    });
  });

  it("rejects malformed, duplicate, unsorted, and oversized authority", () => {
    for (const authoritativeObservationIds of [
      ["observation-b", "observation-a"],
      ["observation-a", "observation-a"],
      [""],
      Array.from({ length: 1_025 }, (_, index) => `observation-${index}`),
    ]) {
      expect(() =>
        authoritativeReviewProjectionObservationIds({
          authoritativeObservationIds,
          occurrences: [],
        }),
      ).toThrow("projection_authoritative_observation_ids_invalid");
    }
  });

  it("fails closed on invalid JSON and occurrence lineage", () => {
    expect(() =>
      authoritativeReviewProjectionObservationIdsFromJson("{"),
    ).toThrow("projection_envelope_json_invalid");
    expect(() =>
      authoritativeReviewProjectionObservationIds({ occurrences: [{}] }),
    ).toThrow("projection_occurrence_observation_ids_invalid");
    expect(() =>
      authoritativeReviewProjectionObservationIds({
        authoritativeObservationIds: ["observation-a"],
        occurrences: [{ observationIds: ["observation-b"] }],
      }),
    ).toThrow("projection_occurrence_authority_mismatch");
  });
});
