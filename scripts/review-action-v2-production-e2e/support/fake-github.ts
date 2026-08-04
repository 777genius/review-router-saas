import type { JWK } from "jose";

export type FakeGitHubRevision = Readonly<{
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  headTreeSha?: string;
}>;

type StoredComment = {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly login: string };
};

type StoredCheckRun = {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly output: {
    readonly title: string;
    readonly summary: string;
  };
  readonly app: { readonly slug: string };
};

export class FakeGitHubTransport {
  readonly calls: Array<{
    readonly method: string;
    readonly pathname: string;
    readonly search: string;
  }> = [];
  readonly comments: StoredComment[] = [];
  readonly checkRuns: StoredCheckRun[] = [];
  revision: FakeGitHubRevision;
  failNextCommentAfterWrite = false;
  private nextExternalId = 10_000;

  constructor(
    readonly options: Readonly<{
      owner: string;
      repo: string;
      pullRequestNumber: number;
      sourceRunId: string;
      installationId: string;
      appSlug: string;
      oidcKeyId: string;
      oidcJwk: JWK;
      revision: FakeGitHubRevision;
    }>,
  ) {
    this.revision = options.revision;
  }

  seedForeignComments(count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.comments.push({
        id: this.nextExternalId++,
        body: `foreign-comment-${index}`,
        user: { login: "someone-else" },
      });
    }
  }

  countCalls(method: string, pathnameIncludes: string): number {
    return this.calls.filter(
      (call) =>
        call.method === method && call.pathname.includes(pathnameIncludes),
    ).length;
  }

  readonly fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request ? input : new Request(input.toString(), init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    this.calls.push({ method, pathname: url.pathname, search: url.search });

    if (
      url.hostname === "token.actions.githubusercontent.com" &&
      url.pathname === "/.well-known/jwks"
    ) {
      return json(200, { keys: [this.options.oidcJwk] });
    }
    if (url.hostname !== "api.github.com") {
      return json(404, { message: "fake_transport_unknown_host" });
    }
    if (
      method === "POST" &&
      url.pathname ===
        `/app/installations/${this.options.installationId}/access_tokens`
    ) {
      return json(201, {
        token: "fake-installation-token",
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        permissions: {
          checks: "write",
          contents: "read",
          issues: "write",
          pull_requests: "write",
        },
        repository_selection: "selected",
      });
    }
    if (method === "GET" && url.pathname === "/app") {
      return json(200, { id: 1, slug: this.options.appSlug });
    }
    if (method === "POST" && url.pathname === "/graphql") {
      return this.graphql(await requestJson(request));
    }

    const repositoryPrefix = `/repos/${this.options.owner}/${this.options.repo}`;
    if (
      method === "GET" &&
      url.pathname ===
        `${repositoryPrefix}/actions/runs/${this.options.sourceRunId}`
    ) {
      return json(200, {
        id: Number(this.options.sourceRunId),
        pull_requests: [{ number: this.options.pullRequestNumber }],
      });
    }
    if (
      method === "GET" &&
      url.pathname ===
        `${repositoryPrefix}/pulls/${this.options.pullRequestNumber}`
    ) {
      return json(200, {
        number: this.options.pullRequestNumber,
        base: { sha: this.revision.baseSha },
        head: { sha: this.revision.headSha },
      });
    }
    if (
      method === "GET" &&
      url.pathname.startsWith(`${repositoryPrefix}/compare/`)
    ) {
      return json(200, {
        merge_base_commit: { sha: this.revision.mergeBaseSha },
      });
    }
    if (
      method === "GET" &&
      this.revision.headTreeSha &&
      url.pathname ===
        `${repositoryPrefix}/git/commits/${this.revision.headSha}`
    ) {
      return json(200, {
        sha: this.revision.headSha,
        tree: { sha: this.revision.headTreeSha },
      });
    }

    const commentsPath = `${repositoryPrefix}/issues/${this.options.pullRequestNumber}/comments`;
    if (method === "GET" && url.pathname === commentsPath) {
      const page = positivePage(url.searchParams.get("page"));
      const perPage = positivePage(url.searchParams.get("per_page"));
      const start = (page - 1) * perPage;
      return json(200, this.comments.slice(start, start + perPage));
    }
    if (method === "POST" && url.pathname === commentsPath) {
      const body = await requestJson(request);
      const comment: StoredComment = {
        id: this.nextExternalId++,
        body: requiredString(body.body),
        user: { login: `${this.options.appSlug}[bot]` },
      };
      this.comments.push(comment);
      if (this.failNextCommentAfterWrite) {
        this.failNextCommentAfterWrite = false;
        throw new TypeError("fake_scm_response_lost_after_write");
      }
      return json(201, comment);
    }

    const checkRunsPath = `${repositoryPrefix}/commits/${this.revision.headSha}/check-runs`;
    if (method === "GET" && url.pathname === checkRunsPath) {
      const page = positivePage(url.searchParams.get("page"));
      const perPage = positivePage(url.searchParams.get("per_page"));
      const start = (page - 1) * perPage;
      return json(200, {
        total_count: this.checkRuns.length,
        check_runs: this.checkRuns.slice(start, start + perPage),
      });
    }
    if (
      method === "POST" &&
      url.pathname === `${repositoryPrefix}/check-runs`
    ) {
      const body = await requestJson(request);
      const output = record(body.output);
      const checkRun: StoredCheckRun = {
        id: this.nextExternalId++,
        name: requiredString(body.name),
        conclusion:
          typeof body.conclusion === "string" ? body.conclusion : null,
        output: {
          title: requiredString(output.title),
          summary: requiredString(output.summary),
        },
        app: { slug: this.options.appSlug },
      };
      this.checkRuns.push(checkRun);
      return json(201, checkRun);
    }

    return json(404, {
      message: `fake_transport_unhandled:${method}:${url.pathname}`,
    });
  };

  private graphql(body: Readonly<Record<string, unknown>>): Response {
    const query = requiredString(body.query);
    const variables = record(body.variables);
    if (query.includes("ReviewRouterPublicationCommandLedger")) {
      const offset = graphqlOffset(variables.commentsAfter);
      const nodes = this.comments
        .slice(offset, offset + 100)
        .map((comment) => ({
          body: comment.body,
          viewerDidAuthor:
            comment.user.login === `${this.options.appSlug}[bot]`,
        }));
      const nextOffset = offset + nodes.length;
      const hasNextPage = nextOffset < this.comments.length;
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              headRefOid: this.revision.headSha,
              comments: {
                pageInfo: {
                  hasNextPage,
                  endCursor: hasNextPage ? `offset:${nextOffset}` : null,
                },
                nodes,
              },
            },
          },
        },
      });
    }
    if (query.includes("ReviewRouterPublicationLifecycle")) {
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              headRefOid: this.revision.headSha,
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      });
    }
    return json(200, {
      errors: [{ message: "fake_transport_unhandled_graphql_operation" }],
    });
  }
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-github-api-version-selected": "2022-11-28",
    },
  });
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  return record(text.length === 0 ? {} : JSON.parse(text));
}

function positivePage(value: string | null): number {
  if (value === null) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function graphqlOffset(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "string") {
    throw new Error("fake_transport_graphql_cursor_invalid");
  }
  const match = /^offset:(\d+)$/u.exec(value);
  const parsed = match?.[1] ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("fake_transport_graphql_cursor_invalid");
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fake_transport_request_invalid");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("fake_transport_request_string_missing");
  }
  return value;
}
