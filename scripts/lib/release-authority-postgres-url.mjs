const allowedSslModes = new Set([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

const invalidUrl = () => new Error("release_authority_database_url_invalid");
const containsControlCharacter = (value) => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);

/**
 * Parse a release-authority credential without ever attaching the original
 * value to an exception. Callers receive only the fields needed to construct
 * libpq's isolated environment and passfile.
 */
export function parseReleaseAuthorityPostgresUrl(value) {
  if (typeof value !== "string" || containsControlCharacter(value))
    throw invalidUrl();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidUrl();
  }
  try {
    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      !url.hostname ||
      !url.pathname.slice(1) ||
      !url.username ||
      !url.password ||
      url.hash
    )
      throw invalidUrl();
    for (const key of url.searchParams.keys())
      if (key !== "sslmode")
        throw new Error("release_authority_database_url_parameter_unsupported");
    const sslmode = url.searchParams.get("sslmode") ?? "require";
    if (!allowedSslModes.has(sslmode))
      throw new Error("release_authority_database_url_sslmode_invalid");
    const database = decodeURIComponent(url.pathname.slice(1));
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (
      !database ||
      !username ||
      !password ||
      [database, username, password].some(containsControlCharacter)
    )
      throw invalidUrl();
    return Object.freeze({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || "5432",
      database,
      username,
      password,
      sslmode,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("release_authority_database_url_")
    )
      throw error;
    throw invalidUrl();
  }
}

export function releaseAuthorityPostgresEndpoint(value) {
  const connection = parseReleaseAuthorityPostgresUrl(value);
  return `${connection.protocol}//${connection.hostname}:${connection.port}/${connection.database}`;
}

export function releaseAuthorityPostgresUrlWithCredentials(
  value,
  username,
  password,
) {
  parseReleaseAuthorityPostgresUrl(value);
  let url;
  try {
    url = new URL(value);
    url.username = username;
    url.password = password;
    const serialized = url.toString();
    parseReleaseAuthorityPostgresUrl(serialized);
    return serialized;
  } catch {
    throw invalidUrl();
  }
}

const escapePassfile = (value) =>
  value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");

export function releaseAuthorityPostgresPassfileLine(value) {
  const connection = parseReleaseAuthorityPostgresUrl(value);
  return `${escapePassfile(connection.hostname)}:${escapePassfile(connection.port)}:${escapePassfile(connection.database)}:${escapePassfile(connection.username)}:${escapePassfile(connection.password)}\n`;
}
