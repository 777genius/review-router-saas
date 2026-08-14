/**
 * Provider-neutral identity for one logical database.  The adapter decides how
 * to obtain the opaque server and database identities; domain policy only
 * compares the canonical tuple.  Names are included to make accidental
 * cross-database routing diagnosable without exposing a DSN or credential.
 */
export type RuntimeDatabaseIdentity = Readonly<{
  serverIdentity: string;
  databaseIdentity: string;
  databaseName: string;
}>;

const opaqueIdentity = /^[A-Za-z0-9._:-]{1,255}$/u;

function databaseNameIsCanonical(value: string): boolean {
  if (value.length < 1 || value.length > 63) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return true;
}

export function runtimeDatabaseIdentityIsCanonical(
  value: RuntimeDatabaseIdentity | null | undefined,
): value is RuntimeDatabaseIdentity {
  return (
    value !== null &&
    value !== undefined &&
    typeof value.serverIdentity === "string" &&
    typeof value.databaseIdentity === "string" &&
    typeof value.databaseName === "string" &&
    opaqueIdentity.test(value.serverIdentity) &&
    opaqueIdentity.test(value.databaseIdentity) &&
    databaseNameIsCanonical(value.databaseName)
  );
}

export function runtimeDatabaseIdentityEquals(
  left: RuntimeDatabaseIdentity | null | undefined,
  right: RuntimeDatabaseIdentity | null | undefined,
): boolean {
  if (
    !runtimeDatabaseIdentityIsCanonical(left) ||
    !runtimeDatabaseIdentityIsCanonical(right)
  )
    return false;
  return (
    left.serverIdentity === right.serverIdentity &&
    left.databaseIdentity === right.databaseIdentity &&
    left.databaseName === right.databaseName
  );
}
