const authorityEnvironmentName =
  "REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL";
const authorityRole = "reviewrouter_comment_token_custody";

function databaseIdentity(url: URL): string {
  const port = url.port || "5432";
  return `${url.hostname.toLowerCase().replace(/\.$/u, "")}:${port}${url.pathname}`;
}

/** Resolve the isolated database principal that alone may mutate bearer custody. */
export function resolveCommentTokenCustodyDatabaseAuthorityUrl(input: {
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
    throw new Error("comment_token_custody_database_authority_url_invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(authorityUrl.protocol) ||
    decodeURIComponent(authorityUrl.username) !== authorityRole ||
    !authorityUrl.password ||
    databaseIdentity(authorityUrl) !== databaseIdentity(runtimeUrl)
  ) {
    throw new Error("comment_token_custody_database_authority_url_invalid");
  }
  return authorityUrl.toString();
}
