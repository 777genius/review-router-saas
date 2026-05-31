export type GitLabSourceUrl = {
  readonly path: string;
  readonly baseUrl: string;
};

export function parseGitLabSourceUrl(input: {
  readonly value: string;
  readonly defaultBaseUrl?: string | undefined;
}): GitLabSourceUrl {
  const defaultBaseUrl = normalizeBaseUrl(
    input.defaultBaseUrl ?? "https://gitlab.com",
  );
  const raw = input.value.trim();
  if (!raw || raw.includes("\n") || raw.includes("\r")) {
    throw new Error("gitlab_source_url_required");
  }
  if (/%2e%2e/i.test(raw)) {
    throw new Error("gitlab_source_url_path_invalid");
  }

  const parsed = parseUrlLike(raw, defaultBaseUrl);
  if (parsed.origin !== new URL(defaultBaseUrl).origin) {
    throw new Error("gitlab_source_url_host_unsupported");
  }
  const path = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/-\/.*$/, "");
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    throw new Error("gitlab_source_url_path_invalid");
  }
  if (
    !decodedPath ||
    decodedPath.includes("..") ||
    decodedPath.startsWith("-/")
  ) {
    throw new Error("gitlab_source_url_path_invalid");
  }

  return {
    baseUrl: defaultBaseUrl,
    path: decodedPath,
  };
}

function parseUrlLike(value: string, defaultBaseUrl: string): URL {
  try {
    if (/^https?:\/\//i.test(value)) {
      return new URL(value);
    }
    return new URL(`/${value.replace(/^\/+/, "")}`, defaultBaseUrl);
  } catch {
    throw new Error("gitlab_source_url_invalid");
  }
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("gitlab_base_url_invalid");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("gitlab_base_url_invalid");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}
