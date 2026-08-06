import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractUniqueReviewFindingFingerprint } from "../domain/review-finding-marker";

type FindingMarkerFixture = {
  readonly schemaVersion: string;
  readonly cases: readonly {
    readonly name: string;
    readonly body: string;
    readonly expectedFingerprint: string | null;
  }[];
};

const pairedActionRepo =
  process.env.REVIEW_ROUTER_PAIRED_ACTION_REPO?.trim() || null;
const pairedActionTest = pairedActionRepo ? it : it.skip;

describe("review finding marker grammar", () => {
  it.each([
    [
      "legacy",
      "<!-- review-router-finding:aaaaaaaaaaaaaaaaaaaaaaaa -->",
      "aaaaaaaaaaaaaaaaaaaaaaaa",
    ],
    [
      "v2",
      "reviewrouter:finding:v2:bbbbbbbbbbbbbbbbbbbbbbbb",
      "bbbbbbbbbbbbbbbbbbbbbbbb",
    ],
    [
      "same duplicate",
      "reviewrouter:finding:v2:bbbbbbbbbbbbbbbbbbbbbbbb\nreviewrouter:finding:v2:bbbbbbbbbbbbbbbbbbbbbbbb",
      "bbbbbbbbbbbbbbbbbbbbbbbb",
    ],
    [
      "conflict",
      "reviewrouter:finding:v2:aaaaaaaaaaaaaaaaaaaaaaaa\nreviewrouter:finding:v2:bbbbbbbbbbbbbbbbbbbbbbbb",
      null,
    ],
    ["suffix", "reviewrouter:finding:v2:aaaaaaaaaaaaaaaaaaaaaaaa_suffix", null],
  ] as const)("parses %s", (_name, body, expected) => {
    expect(extractUniqueReviewFindingFingerprint(body)).toBe(expected);
  });

  pairedActionTest("matches the paired Action golden corpus", () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          pairedActionRepo!,
          "src/review-projection/fixtures/finding-marker-grammar.v1.golden.json",
        ),
        "utf8",
      ),
    ) as FindingMarkerFixture;
    expect(fixture.schemaVersion).toBe("review_finding_marker_grammar.v1");
    for (const testCase of fixture.cases) {
      expect(
        extractUniqueReviewFindingFingerprint(testCase.body),
        testCase.name,
      ).toBe(testCase.expectedFingerprint);
    }
  });
});
