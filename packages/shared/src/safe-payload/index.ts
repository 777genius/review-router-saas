const maxCollectedStrings = 500;
const maxStringLength = 64 * 1024;
const codeLikeLinePattern =
  /^\s*(?:async\s+)?(?:export\s+)?(?:function|class|interface|type|const|let|var|import|from|return|if|for|while|switch|try|catch)\b|=>|;\s*$/m;

export function collectPayloadStrings(value: unknown): string[] {
  const result: string[] = [];
  const visited = new WeakSet<object>();
  const stack: Array<{ readonly key?: string; readonly value: unknown }> = [
    { value },
  ];

  while (stack.length > 0 && result.length < maxCollectedStrings) {
    const current = stack.pop();
    if (!current) break;
    const entry = current.value;

    if (typeof current.key === "string") {
      pushBounded(result, current.key);
      if (typeof entry === "string") {
        pushBounded(result, `${current.key}=${entry}`);
      }
    }

    if (typeof entry === "string") {
      pushBounded(result, entry);
      continue;
    }

    if (!entry || typeof entry !== "object") {
      continue;
    }

    if (visited.has(entry)) {
      continue;
    }
    visited.add(entry);

    if (Array.isArray(entry)) {
      for (let index = entry.length - 1; index >= 0; index -= 1) {
        stack.push({ value: entry[index] });
      }
      continue;
    }

    const entries = Object.entries(entry);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const current = entries[index];
      if (!current) continue;
      const [key, nested] = current;
      stack.push({ key, value: nested });
    }
  }

  return result;
}

export function looksLikeCodeOrDiff(value: string): boolean {
  return (
    /```|diff --git|@@\s+-\d+|^\+\+\+\s|^---\s/m.test(value) ||
    codeLikeLinePattern.test(value)
  );
}

export function looksLikeSecretValue(value: string): boolean {
  return (
    /BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY/.test(value) ||
    /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|AUTH_JSON)[A-Z0-9_]*\s*[:=]\s*\S+/i.test(
      value,
    ) ||
    /\b[A-Z0-9_]*NONCE[A-Z0-9_]*\s*[:=]\s*\S+/i.test(value) ||
    /\b[A-Za-z0-9_]*(token|secret|password|privateKey|apiKey|authJson)[A-Za-z0-9_]*\s*[:=]\s*\S+/i.test(
      value,
    ) ||
    /\b[A-Za-z0-9_]*nonce[A-Za-z0-9_]*\s*[:=]\s*\S+/.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i.test(value) ||
    /\b(refresh[_-]?token|access[_-]?token)\b\s*[:=]\s*\S+/i.test(value) ||
    /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/.test(
      value,
    )
  );
}

function pushBounded(result: string[], value: string): void {
  if (result.length >= maxCollectedStrings) return;
  result.push(value.slice(0, maxStringLength));
}
