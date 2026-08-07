const legacyFindingMarker =
  /<!--\s*review-router-finding:([a-f0-9]{24,64})\s*-->/gi;
const v2FindingMarker =
  /(?<!\S)reviewrouter:finding:v2:(rrl_[a-f0-9]{32}|[a-f0-9]{24,64})(?=$|[ \t\r\n])/g;
const reservedFindingMarkerPrefix =
  /(?:review-router-finding:|reviewrouter:finding:v2:)/gi;
const reviewFindingFingerprint = /^(?:rrl_[a-f0-9]{32}|[a-f0-9]{24,64})$/u;

type FindingMarkerMatch = Readonly<{
  start: number;
  end: number;
  fingerprint: string;
}>;

export function isReviewFindingFingerprint(value: unknown): value is string {
  return typeof value === "string" && reviewFindingFingerprint.test(value);
}

export function extractUniqueReviewFindingFingerprint(
  body: string,
): string | null {
  const reservedPrefixOffsets = Array.from(
    body.matchAll(reservedFindingMarkerPrefix),
    (match) => match.index,
  ).filter((offset): offset is number => offset !== undefined);
  if (reservedPrefixOffsets.length === 0) return null;

  const matches = [
    ...collectFindingMarkerMatches(body, legacyFindingMarker),
    ...collectFindingMarkerMatches(body, v2FindingMarker),
  ];
  if (
    !reservedPrefixOffsets.every((offset) =>
      matches.some((match) => offset >= match.start && offset < match.end),
    )
  ) {
    return null;
  }

  const fingerprints = new Set(matches.map((match) => match.fingerprint));
  return fingerprints.size === 1 ? [...fingerprints][0]! : null;
}

function collectFindingMarkerMatches(
  body: string,
  pattern: RegExp,
): FindingMarkerMatch[] {
  return Array.from(body.matchAll(pattern), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    fingerprint: (match[1] ?? "").toLowerCase(),
  }));
}
