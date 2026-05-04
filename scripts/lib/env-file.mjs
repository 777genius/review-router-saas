import { existsSync, readFileSync } from "node:fs";

export function loadEnvFile(path, base = process.env) {
  const result = { ...base };
  if (!existsSync(path)) return result;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    result[key] = unquoteEnv(rawValue.trim());
  }
  return result;
}

export function unquoteEnv(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }
  return value;
}
