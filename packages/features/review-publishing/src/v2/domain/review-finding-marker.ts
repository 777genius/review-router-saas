const legacyFindingMarker =
  /<!--\s*review-router-finding:([a-f0-9]{24,64})\s*-->/giu;
const v2FindingMarker =
  /\breviewrouter:finding:v2:([a-f0-9]{24,64})(?=$|[ \t\r\n])/gu;

export function extractUniqueReviewFindingFingerprint(
  body: string,
): string | null {
  const fingerprints = new Set<string>();
  for (const match of body.matchAll(legacyFindingMarker)) {
    if (match[1]) fingerprints.add(match[1].toLowerCase());
  }
  for (const match of body.matchAll(v2FindingMarker)) {
    if (match[1]) fingerprints.add(match[1]);
  }
  return fingerprints.size === 1 ? [...fingerprints][0]! : null;
}
