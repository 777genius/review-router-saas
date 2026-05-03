export function collectPayloadStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectPayloadStrings);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [
      key,
      ...(typeof entry === "string" ? [`${key}=${entry}`] : []),
      ...collectPayloadStrings(entry),
    ]);
  }
  return [];
}

export function looksLikeCodeOrDiff(value: string): boolean {
  return /```|diff --git|@@\s+-\d+|^\+\+\+\s|^---\s/m.test(value);
}

export function looksLikeSecretValue(value: string): boolean {
  return (
    /BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY/.test(value) ||
    /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|AUTH_JSON)[A-Z0-9_]*\s*[:=]\s*\S+/i.test(
      value,
    ) ||
    /\b[A-Za-z0-9_]*(token|secret|password|privateKey|apiKey|authJson)[A-Za-z0-9_]*\s*[:=]\s*\S+/i.test(
      value,
    ) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i.test(value) ||
    /\b(refresh[_-]?token|access[_-]?token)\b\s*[:=]\s*\S+/i.test(value) ||
    /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/.test(
      value,
    )
  );
}
