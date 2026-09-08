// Only the production current-revision prerequisite crosses this fixture boundary.
export type RevisionFixture = Readonly<{
  owner: string; repo: string; installationId: string; pullRequestNumber: number;
  revision: Readonly<{ baseSha: string; headSha: string; mergeBaseSha: string }>;
}>;
export function revisionFetch(fixture: RevisionFixture): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const prefix = `/repos/${fixture.owner}/${fixture.repo}`;
    const json = (status: number, data: unknown) => Response.json(data, { status });
    if (url.origin !== "https://api.github.com" || url.search || url.username || url.password || url.hash) {
      throw new Error("item11_external_fetch_denied");
    }
    if (request.method === "POST" && url.pathname === `/app/installations/${fixture.installationId}/access_tokens`) {
      return json(201, { token: "fake-installation-token", expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { checks: "write", contents: "read", issues: "write", pull_requests: "write" }, repository_selection: "selected" });
    }
    if (request.method === "GET" && url.pathname === `${prefix}/pulls/${fixture.pullRequestNumber}`) {
      return json(200, { number: fixture.pullRequestNumber, state: "open",
        base: { sha: fixture.revision.baseSha, repo: { full_name: `${fixture.owner}/${fixture.repo}` } },
        head: { sha: fixture.revision.headSha } });
    }
    if (request.method === "GET" && url.pathname === `${prefix}/compare/${fixture.revision.baseSha}...${fixture.revision.headSha}`) {
      return json(200, { merge_base_commit: { sha: fixture.revision.mergeBaseSha } });
    }
    throw new Error("item11_external_fetch_denied");
  };
}
