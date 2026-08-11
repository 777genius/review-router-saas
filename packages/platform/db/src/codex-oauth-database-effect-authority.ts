const authorityEnvironmentName =
  "REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL";
const authorityRole = "reviewrouter_codex_effect_authority";

function databaseIdentity(url: URL): string {
  const port = url.port || "5432";
  return `${url.hostname.toLowerCase().replace(/\.$/u, "")}:${port}${url.pathname}`;
}

export function resolveCodexOAuthDatabaseEffectAuthorityUrl(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runtimeDatabaseUrl?: string | undefined;
}): string | undefined {
  const value = input.env[authorityEnvironmentName]?.trim();
  if (!value) return undefined;
  let authorityUrl: URL;
  let runtimeUrl: URL;
  try {
    authorityUrl = new URL(value);
    if (!input.runtimeDatabaseUrl) throw new Error("runtime database missing");
    runtimeUrl = new URL(input.runtimeDatabaseUrl);
  } catch {
    throw new Error("codex_oauth_database_effect_authority_url_invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(authorityUrl.protocol) ||
    decodeURIComponent(authorityUrl.username) !== authorityRole ||
    !authorityUrl.password ||
    databaseIdentity(authorityUrl) !== databaseIdentity(runtimeUrl)
  ) {
    throw new Error("codex_oauth_database_effect_authority_url_invalid");
  }
  return authorityUrl.toString();
}
