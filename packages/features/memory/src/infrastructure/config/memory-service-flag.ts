export type MemoryServiceFlagEnv = Readonly<Record<string, string | undefined>>;

export function readMemoryServiceEnabled(env: MemoryServiceFlagEnv): boolean {
  const explicit = normalizeFlag(env.REVIEW_ROUTER_MEMORY_ENABLED);
  if (explicit !== null) return explicit;
  const disabled = normalizeFlag(env.REVIEW_ROUTER_DISABLE_MEMORY);
  return disabled === null ? true : !disabled;
}

function normalizeFlag(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "1" || normalized === "true" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "off") {
    return false;
  }
  return null;
}
