export function canonicalReviewPublicationJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalReviewPublicationJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(codeUnitCompare)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalReviewPublicationJson(record[key])}`,
    )
    .join(",")}}`;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
