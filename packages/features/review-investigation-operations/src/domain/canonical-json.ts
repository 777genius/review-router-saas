export function canonicalInvestigationOperationsJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("investigation_canonical_number_invalid");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalInvestigationOperationsJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("investigation_canonical_value_invalid");
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalInvestigationOperationsJson(record[key])}`,
    )
    .join(",")}}`;
}
