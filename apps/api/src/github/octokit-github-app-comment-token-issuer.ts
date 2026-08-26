import { App } from "@octokit/app";
import type {
  GitHubAppCommentTokenIssuerPort,
  IssueGitHubAppCommentTokenInput,
  IssuedGitHubAppCommentToken,
} from "@reviewrouter/features-action-control-plane";

type InstallationTokenResponse = {
  readonly token?: unknown;
  readonly expires_at?: unknown;
  readonly permissions?: {
    readonly contents?: unknown;
    readonly pull_requests?: unknown;
    readonly issues?: unknown;
    readonly statuses?: unknown;
  };
  readonly repositories?: readonly { readonly id?: unknown }[];
};

const githubResponseByteCeiling = 16 * 1024;
const githubRequestDeadlineMs = 15_000;
// An authenticated revocation proof is the only safe way to clear custody when
// GitHub returns a bearer without a parseable expiry. PostgreSQL supports this
// finite sentinel and closure will remain fenced until revocation succeeds.
const unknownBearerExpiry = new Date("9999-12-31T23:59:59.000Z");

export class OctokitGitHubAppCommentTokenIssuer implements GitHubAppCommentTokenIssuerPort {
  private readonly app: App;
  private readonly monotonicNow: () => number;

  constructor(options: {
    readonly appId: string;
    readonly privateKey: string;
    readonly monotonicNow?: () => number;
  }) {
    this.app = new App({
      appId: options.appId,
      privateKey: options.privateKey,
    });
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async issueCommentToken(
    input: IssueGitHubAppCommentTokenInput,
  ): Promise<IssuedGitHubAppCommentToken> {
    // This shared adapter remains substitutable for action-control-plane
    // consumers. Hosted callers use prepareCommentToken directly and enforce
    // durable custody at that higher-level protocol boundary.
    const budgetStartedAtMonotonicMs = this.monotonicNow();
    const prepared = await this.prepareCommentToken(input);
    const issued = await prepared.send({
      remainingBudgetMs: 15_000,
      budgetStartedAtMonotonicMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (issued.custody === "acceptable") return issued;
    // Legacy action consumers do not own durable custody. If provider evidence
    // is unacceptable, keep control here until this exact bearer is proved
    // invalid rather than returning it or dropping it on a failed DELETE.
    let attempt = 0;
    for (;;) {
      try {
        await this.revokeCommentToken({ token: issued.token });
        throw new Error("comment_token_invalid_response");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "comment_token_invalid_response"
        )
          throw error;
        attempt += 1;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1_000, 25 * 2 ** Math.min(attempt, 5))),
        );
      }
    }
  }

  async prepareCommentToken(
    input: Omit<IssueGitHubAppCommentTokenInput, "signal">,
  ) {
    const installationId = parsePositiveSafeInteger(
      input.githubInstallationId,
      "comment_token_installation_id_invalid",
    );
    const repositoryId = parsePositiveSafeInteger(
      input.githubRepositoryId,
      "comment_token_repository_id_invalid",
    );
    // App authentication is a local JWT operation. The token mint itself is an
    // explicit, non-caching POST so one durable providerAttempt maps to one POST.
    const appAuthentication = (await this.app.octokit.auth({
      type: "app",
    })) as { token?: unknown };
    if (
      typeof appAuthentication.token !== "string" ||
      appAuthentication.token.length === 0
    )
      throw new Error("comment_token_app_auth_invalid");
    const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
    const request = {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appAuthentication.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        repository_ids: [repositoryId],
        permissions: {
          contents: "read",
          pull_requests: "write",
          issues: "write",
          statuses: "write",
        },
      }),
    } as const;
    return {
      send: async (sendInput: {
        readonly remainingBudgetMs: number;
        readonly budgetStartedAtMonotonicMs: number;
        readonly signal?: AbortSignal;
      }): Promise<IssuedGitHubAppCommentToken> => {
        // No await may be inserted between this monotonic budget check and
        // fetch. Calling fetch synchronously is the actual HTTP send boundary.
        if (this.remainingBudget(sendInput) <= 0) {
          const error = new Error(
            "comment_token_send_deadline_expired",
          ) as Error & {
            lateSend?: true;
          };
          error.lateSend = true;
          throw error;
        }
        const deadline = boundedSignal(
          Math.min(githubRequestDeadlineMs, this.remainingBudget(sendInput)),
          sendInput.signal,
        );
        try {
          const response = await fetch(url, {
            ...request,
            signal: deadline.signal,
          });
          return await this.parseMintResponse(
            response,
            input,
            repositoryId,
            sendInput,
          );
        } finally {
          deadline.dispose();
        }
      },
    };
  }

  private async parseMintResponse(
    response: Response,
    input: Omit<IssueGitHubAppCommentTokenInput, "signal">,
    repositoryId: number,
    sendBudget: Readonly<{
      remainingBudgetMs: number;
      budgetStartedAtMonotonicMs: number;
    }>,
  ): Promise<IssuedGitHubAppCommentToken> {
    if (response.status < 200 || response.status >= 300) {
      await cancelResponseBody(response);
      const error = new Error(
        response.status >= 400 && response.status < 500
          ? "comment_token_provider_rejected"
          : "comment_token_provider_unavailable",
      ) as Error & { effect?: "none" };
      if (response.status >= 400 && response.status < 500)
        error.effect = "none";
      throw error;
    }
    const data = (await readBoundedJson(response)) as InstallationTokenResponse;
    if (typeof data.token !== "string" || data.token.length === 0) {
      throw new Error("comment_token_invalid_response");
    }
    const parsedExpiresAt =
      typeof data.expires_at === "string" ? new Date(data.expires_at) : null;
    const expiryKnown =
      parsedExpiresAt !== null && Number.isFinite(parsedExpiresAt.getTime());
    const expiresAt = expiryKnown ? parsedExpiresAt! : unknownBearerExpiry;
    const observedAt = Date.now();
    const permissionsMatch =
      data.permissions?.contents !== "read" ||
      data.permissions?.pull_requests !== "write" ||
      data.permissions?.issues !== "write" ||
      data.permissions?.statuses !== "write";
    const repositoryIds = Array.isArray(data.repositories)
      ? data.repositories.map((repository) =>
          repository && typeof repository === "object"
            ? (repository as { readonly id?: unknown }).id
            : undefined,
        )
      : null;
    const repositoryMatch =
      repositoryIds?.length === 1 && repositoryIds[0] === repositoryId;
    const custodyReason =
      response.status !== 201
        ? `unexpected_creation_status:${response.status}`
        : !expiryKnown
          ? "provider_expiry_unbounded"
          : expiresAt.getTime() <= observedAt
            ? "provider_expiry_not_future"
            : expiresAt.getTime() > observedAt + 61 * 60_000
              ? "provider_expiry_too_long"
              : permissionsMatch
                ? "permissions_mismatch"
                : !repositoryMatch
                  ? "repository_inventory_mismatch"
                  : this.remainingBudget(sendBudget) <= 0
                    ? "late_provider_result"
                    : undefined;

    return {
      token: data.token,
      expiresAt,
      repository: input.repositoryFullName,
      permissions: {
        contents: "read",
        pullRequests: "write",
        issues: "write",
        statuses: "write",
      },
      custody: custodyReason ? "unacceptable" : "acceptable",
      ...(custodyReason ? { custodyReason } : {}),
    };
  }

  private remainingBudget(input: {
    readonly remainingBudgetMs: number;
    readonly budgetStartedAtMonotonicMs: number;
  }): number {
    if (
      !Number.isFinite(input.remainingBudgetMs) ||
      input.remainingBudgetMs <= 0 ||
      !Number.isFinite(input.budgetStartedAtMonotonicMs)
    )
      return 0;
    const elapsed = this.monotonicNow() - input.budgetStartedAtMonotonicMs;
    if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
    return input.remainingBudgetMs - elapsed;
  }

  async revokeCommentToken(input: {
    readonly token: string;
    readonly signal?: AbortSignal;
  }): Promise<Readonly<{ proof: "revoked" | "already_invalid" }>> {
    const deadline = boundedSignal(githubRequestDeadlineMs, input.signal);
    try {
      const response = await fetch(
        "https://api.github.com/installation/token",
        {
          method: "DELETE",
          cache: "no-store",
          redirect: "error",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${input.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: deadline.signal,
        },
      );
      // 204 proves revocation; 401 from this exact bearer proves it is invalid.
      if (response.status !== 204 && response.status !== 401) {
        await cancelResponseBody(response);
        throw new Error("comment_token_revoke_failed");
      }
      await cancelResponseBody(response);
      return { proof: response.status === 204 ? "revoked" : "already_invalid" };
    } finally {
      deadline.dispose();
    }
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > githubResponseByteCeiling
    ) {
      await cancelResponseBody(response);
      throw new Error("comment_token_response_too_large");
    }
  }
  if (!response.body) throw new Error("comment_token_invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let combined: Uint8Array | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > githubResponseByteCeiling) {
        value.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new Error("comment_token_response_too_large");
      }
      chunks.push(value);
    }
    combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(combined));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "comment_token_response_too_large"
    )
      throw error;
    throw new Error("comment_token_invalid_response", { cause: error });
  } finally {
    combined?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

function boundedSignal(milliseconds: number, caller?: AbortSignal) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(caller?.reason);
  if (caller?.aborted) abortFromCaller();
  else caller?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("request deadline exceeded", "AbortError"),
      ),
    Math.max(1, milliseconds),
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", abortFromCaller);
    },
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  await response.body.cancel().catch(() => undefined);
}

function parsePositiveSafeInteger(value: string, errorCode: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(errorCode);
  }
  return parsed;
}
