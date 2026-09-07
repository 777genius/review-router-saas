/** Only the checked-in CI service DB or an explicitly named PR fixture on loopback. */
export function assertDisposableWorkflowDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    (url.pathname !== "/review_router_ci_test" &&
      !/^\/reviewrouter_pr244_disposable(?:_[a-z0-9_]+)?$/.test(
        url.pathname,
      )) ||
    [...url.searchParams.keys()].some((key) => key !== "schema") ||
    (url.searchParams.has("schema") &&
      url.searchParams.get("schema") !== "public") ||
    url.hash !== ""
  )
    throw new Error("disposable_loopback_database_required");
}
