import { safeGitHubDashboardLink } from "../../src/server/safe-dashboard-link";

type DashboardRepositorySource = {
  readonly provider: "github" | "gitlab";
  readonly fullName: string;
  readonly sourceBaseUrl?: string | null;
};

export function repositorySourceUrl(
  repository: DashboardRepositorySource,
): string | null {
  if (repository.provider === "gitlab") {
    return gitLabRepositoryUrl(repository.fullName, repository.sourceBaseUrl);
  }

  return githubRepositoryUrl(repository.fullName);
}

function githubRepositoryUrl(fullName: string): string | null {
  const parts = fullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;

  return safeGitHubDashboardLink(
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
}

function gitLabRepositoryUrl(
  fullName: string,
  sourceBaseUrl: string | null | undefined,
): string | null {
  const parts = fullName.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (!parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) return null;

  const baseUrl = normalizeGitLabSourceBaseUrl(
    sourceBaseUrl ?? "https://gitlab.com",
  );
  if (!baseUrl) return null;

  return `${baseUrl}/${parts.map(encodeURIComponent).join("/")}`;
}

function normalizeGitLabSourceBaseUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.hostname === "localhost") {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
  } else if (parsed.protocol !== "https:") {
    return null;
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}
