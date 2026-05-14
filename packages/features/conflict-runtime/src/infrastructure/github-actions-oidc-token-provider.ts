import { defaultActionOidcAudience } from "@reviewrouter/features-action-control-plane";

type FetchLike = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly redirect?: "error" | undefined;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export type GitHubActionsOidcTokenProviderOptions = {
  readonly requestUrl?: string | undefined;
  readonly requestToken?: string | undefined;
  readonly audience?: string | undefined;
  readonly fetch?: FetchLike | undefined;
};

export class GitHubActionsOidcTokenProvider {
  private readonly requestUrl: string;
  private readonly requestTokenValue: string;
  private readonly audience: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GitHubActionsOidcTokenProviderOptions = {}) {
    this.requestUrl =
      options.requestUrl ?? process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "";
    this.requestTokenValue =
      options.requestToken ?? process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "";
    this.audience = options.audience ?? defaultActionOidcAudience;
    this.fetchImpl =
      options.fetch ??
      (async (input, init) => {
        return fetch(input, {
          method: init.method,
          headers: init.headers,
          ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
        });
      });
  }

  async requestToken(): Promise<string> {
    if (!this.requestUrl || !this.requestTokenValue) {
      throw new Error("conflict_runtime_oidc_unavailable");
    }
    const url = parseTrustedOidcUrl(this.requestUrl);
    url.searchParams.set("audience", this.audience);
    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.requestTokenValue}`,
      },
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        `conflict_runtime_oidc_http_error:${safeOidcErrorCode(payload)}:${response.status}`,
      );
    }
    const token =
      typeof payload === "object" &&
      payload !== null &&
      "value" in payload &&
      typeof payload.value === "string"
        ? payload.value
        : "";
    if (!token) {
      throw new Error("conflict_runtime_oidc_response_invalid");
    }
    return token;
  }
}

function parseTrustedOidcUrl(requestUrl: string): URL {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    throw new Error("conflict_runtime_oidc_url_untrusted");
  }
  if (url.protocol !== "https:") {
    throw new Error("conflict_runtime_oidc_url_untrusted");
  }
  return url;
}

function safeOidcErrorCode(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return "oidc_request_failed";
  }
  return "unknown_oidc_error";
}
