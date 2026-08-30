import { createHash } from "node:crypto";
import { App } from "@octokit/app";
import type {
  CertifiedForkReviewBinding,
  CertifiedForkReviewFile,
  CertifiedForkReviewGatewayPort,
} from "@reviewrouter/features-action-control-plane";

type Requester = {
  request(
    route: string,
    parameters?: Record<string, unknown>,
  ): Promise<{ data: unknown }>;
};
type InstallationApp = {
  getInstallationOctokit(id: number): Promise<Requester> | Requester;
};
const maxFiles = 300;
const maxPatchBytes = 240_000;
export const certifiedForkReviewMaxFilePatchBytes = 200_000;
const maxChangedLines = 20_000;
const maxCommentPages = 10;
const githubRequestTimeoutMs = 15_000;

export class OctokitCertifiedForkReviewGateway implements CertifiedForkReviewGatewayPort {
  private readonly app: InstallationApp;
  private readonly botLogin: string;
  constructor(options: {
    appId?: string;
    privateKey?: string;
    appSlug?: string;
    botLogin?: string;
    app?: InstallationApp;
  }) {
    if (!options.app && (!options.appId || !options.privateKey))
      throw new Error("certified_fork_github_app_unavailable");
    this.app =
      options.app ??
      new App({ appId: options.appId!, privateKey: options.privateKey! });
    this.botLogin = (
      options.botLogin ?? `${options.appSlug}[bot]`
    ).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*(?:\[bot\])$/.test(this.botLogin))
      throw new Error("certified_fork_bot_login_invalid");
  }
  async assertBindingCurrent(input: {
    githubInstallationId: string;
    binding: CertifiedForkReviewBinding;
  }): Promise<void> {
    await validateTuple(
      await this.client(input.githubInstallationId),
      input.binding,
    );
  }
  async prepareContext(input: {
    githubInstallationId: string;
    binding: CertifiedForkReviewBinding;
  }) {
    const octokit = await this.client(input.githubInstallationId);
    await validateTuple(octokit, input.binding);
    const files: CertifiedForkReviewFile[] = [];
    let bytes = 0;
    let lines = 0;
    const [owner, repo] = split(input.binding.baseRepository);
    for (let page = 1; page <= 4; page += 1) {
      await validateTuple(octokit, input.binding);
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        {
          owner,
          repo,
          pull_number: input.binding.pullRequestNumber,
          per_page: 100,
          page,
        },
      );
      if (!Array.isArray(response.data))
        throw new Error("certified_fork_files_invalid");
      for (const value of response.data) {
        const file = parseFile(value);
        const filePatchBytes = Buffer.byteLength(file.patch, "utf8");
        if (filePatchBytes > certifiedForkReviewMaxFilePatchBytes)
          throw new Error("certified_fork_diff_budget_exceeded");
        bytes += filePatchBytes;
        lines += file.additions + file.deletions;
        if (
          files.length + 1 > maxFiles ||
          bytes > maxPatchBytes ||
          lines > maxChangedLines
        )
          throw new Error("certified_fork_diff_budget_exceeded");
        files.push(file);
      }
      if (response.data.length < 100) break;
      if (page === 4)
        throw new Error("certified_fork_diff_pagination_exceeded");
    }
    await validateTuple(octokit, input.binding);
    const base = {
      protocolVersion: 1 as const,
      repository: {
        base: input.binding.baseRepository,
        source: input.binding.sourceRepository,
      },
      pullRequestNumber: input.binding.pullRequestNumber,
      baseSha: input.binding.baseSha.toLowerCase(),
      headSha: input.binding.reviewHeadSha.toLowerCase(),
      files,
    };
    const contextHash = sha256(canonical(base));
    return { contextHash, promptPacket: { ...base, contextHash } };
  }
  async assertContextCurrent(input: {
    githubInstallationId: string;
    binding: CertifiedForkReviewBinding;
    expectedContextHash: string;
  }) {
    const current = await this.prepareContext(input);
    if (current.contextHash !== input.expectedContextHash)
      throw new Error("certified_fork_context_mismatch");
    return { promptPacket: current.promptPacket };
  }
  async upsertOwnedComment(input: {
    githubInstallationId: string;
    binding: CertifiedForkReviewBinding;
    markerPrefix: string;
    marker: string;
    executionDigest: string;
    outputDigest: string;
    body: string;
  }) {
    const octokit = await this.client(input.githubInstallationId);
    await validateTuple(octokit, input.binding);
    const [owner, repo] = split(input.binding.baseRepository);
    let owned: {
      id: number;
      executionDigest: string;
      outputDigest: string;
      marker: string;
      url?: string;
    } | null = null;
    for (let page = 1; page <= maxCommentPages; page += 1) {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner,
          repo,
          issue_number: input.binding.pullRequestNumber,
          per_page: 100,
          page,
        },
      );
      if (!Array.isArray(response.data))
        throw new Error("certified_fork_comments_invalid");
      for (const raw of response.data) {
        const comment = parseComment(raw);
        if (
          comment.body.startsWith(input.markerPrefix) &&
          comment.author === this.botLogin
        ) {
          if (owned) throw new Error("certified_fork_owned_marker_ambiguous");
          const identity = parseOwnedMarker(comment.body, input.markerPrefix);
          owned = {
            id: comment.id,
            ...identity,
            ...(comment.url ? { url: comment.url } : {}),
          };
        }
      }
      if (response.data.length < 100) break;
      if (page === maxCommentPages)
        throw new Error("certified_fork_comment_pagination_exceeded");
    }
    await validateTuple(octokit, input.binding);
    if (
      owned?.executionDigest === input.executionDigest &&
      owned.outputDigest !== input.outputDigest
    )
      throw new Error("certified_fork_publish_digest_conflict");
    if (
      owned?.executionDigest === input.executionDigest &&
      owned.outputDigest === input.outputDigest
    ) {
      if (owned.marker !== input.marker)
        throw new Error("certified_fork_owned_marker_invalid");
      return {
        status: "updated" as const,
        commentId: String(owned.id),
        ...(owned.url ? { commentUrl: owned.url } : {}),
      };
    }
    const response = owned
      ? await octokit.request(
          "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
          { owner, repo, comment_id: owned.id, body: input.body },
        )
      : await octokit.request(
          "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            owner,
            repo,
            issue_number: input.binding.pullRequestNumber,
            body: input.body,
          },
        );
    const comment = parseComment(response.data);
    return {
      status: owned ? ("updated" as const) : ("created" as const),
      commentId: String(comment.id),
      ...(comment.url ? { commentUrl: comment.url } : {}),
    };
  }
  private async client(value: string) {
    if (!/^[1-9][0-9]*$/.test(value))
      throw new Error("certified_fork_installation_invalid");
    const octokit = await this.app.getInstallationOctokit(Number(value));
    return {
      request: (route: string, parameters: Record<string, unknown> = {}) =>
        octokit.request(route, {
          ...parameters,
          request: { timeout: githubRequestTimeoutMs },
        }),
    } satisfies Requester;
  }
}

function parseOwnedMarker(body: string, prefix: string) {
  const firstLine = body.split("\n", 1)[0];
  if (!firstLine?.startsWith(prefix) || !firstLine.endsWith(" -->"))
    throw new Error("certified_fork_owned_marker_invalid");
  const suffix = firstLine.slice(prefix.length, -4);
  const match =
    /^execution=([a-f0-9]{64}):output=([a-f0-9]{64}):signature=([a-f0-9]{64})$/.exec(
      suffix,
    );
  if (!match) throw new Error("certified_fork_owned_marker_invalid");
  return {
    executionDigest: match[1]!,
    outputDigest: match[2]!,
    marker: firstLine,
  };
}

async function validateTuple(
  octokit: Requester,
  b: CertifiedForkReviewBinding,
) {
  if (
    b.trustDomain !== "fork" ||
    !/^[a-f0-9]{40}$/i.test(b.baseSha) ||
    !/^[a-f0-9]{40}$/i.test(b.reviewHeadSha) ||
    !Number.isSafeInteger(b.pullRequestNumber) ||
    b.pullRequestNumber < 1 ||
    b.baseRepositoryId === b.sourceRepositoryId ||
    b.baseRepository.toLowerCase() === b.sourceRepository.toLowerCase()
  )
    throw new Error("certified_fork_tuple_mismatch");
  const [owner, repo] = split(b.baseRepository);
  const [sourceOwner, sourceRepo] = split(b.sourceRepository);
  const [baseResponse, sourceResponse, prResponse] = await Promise.all([
    octokit.request("GET /repos/{owner}/{repo}", { owner, repo }),
    octokit.request("GET /repos/{owner}/{repo}", {
      owner: sourceOwner,
      repo: sourceRepo,
    }),
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: b.pullRequestNumber,
    }),
  ]);
  const base = parseRepository(baseResponse.data);
  const source = parseRepository(sourceResponse.data);
  const pr = parsePullRequest(prResponse.data);
  if (
    base.id !== b.baseRepositoryId ||
    source.id !== b.sourceRepositoryId ||
    base.fullName !== b.baseRepository ||
    source.fullName !== b.sourceRepository ||
    base.private ||
    source.private ||
    base.visibility !== "public" ||
    source.visibility !== "public" ||
    pr.state !== "open" ||
    pr.draft ||
    pr.merged ||
    pr.authorType === "Bot" ||
    pr.number !== b.pullRequestNumber ||
    pr.baseId !== base.id ||
    pr.headId !== source.id ||
    pr.baseName !== base.fullName ||
    pr.headName !== source.fullName ||
    pr.baseSha !== b.baseSha.toLowerCase() ||
    pr.headSha !== b.reviewHeadSha.toLowerCase()
  )
    throw new Error("certified_fork_tuple_mismatch");
}
function parseRepository(value: unknown) {
  if (
    !record(value) ||
    !id(value.id) ||
    typeof value.full_name !== "string" ||
    typeof value.private !== "boolean" ||
    typeof value.visibility !== "string"
  )
    throw new Error("certified_fork_repository_invalid");
  return {
    id: String(value.id),
    fullName: value.full_name,
    private: value.private,
    visibility: value.visibility,
  };
}
function parsePullRequest(value: unknown) {
  if (
    !record(value) ||
    !record(value.base) ||
    !record(value.head) ||
    !record(value.base.repo) ||
    !record(value.head.repo) ||
    !record(value.user) ||
    typeof value.base.sha !== "string" ||
    typeof value.head.sha !== "string" ||
    !id(value.base.repo.id) ||
    !id(value.head.repo.id) ||
    typeof value.base.repo.full_name !== "string" ||
    typeof value.head.repo.full_name !== "string" ||
    typeof value.draft !== "boolean" ||
    typeof value.merged !== "boolean" ||
    typeof value.user.type !== "string" ||
    !positiveInteger(value.number)
  )
    throw new Error("certified_fork_pull_request_invalid");
  return {
    state: value.state,
    number: value.number,
    draft: value.draft,
    merged: value.merged,
    authorType: value.user.type,
    baseSha: value.base.sha.toLowerCase(),
    headSha: value.head.sha.toLowerCase(),
    baseId: String(value.base.repo.id),
    headId: String(value.head.repo.id),
    baseName: value.base.repo.full_name,
    headName: value.head.repo.full_name,
  };
}
function parseFile(value: unknown): CertifiedForkReviewFile {
  if (
    !record(value) ||
    typeof value.filename !== "string" ||
    !safePath(value.filename) ||
    !["added", "modified", "removed", "renamed"].includes(
      String(value.status),
    ) ||
    !nonnegative(value.additions) ||
    !nonnegative(value.deletions) ||
    typeof value.patch !== "string" ||
    value.patch.length === 0 ||
    value.patch.includes("GIT binary patch") ||
    value.patch.includes("Binary files ")
  )
    throw new Error("certified_fork_file_unsupported");
  return {
    path: value.filename,
    status: value.status as CertifiedForkReviewFile["status"],
    additions: value.additions,
    deletions: value.deletions,
    patch: value.patch,
  };
}
function parseComment(value: unknown) {
  if (
    !record(value) ||
    !id(value.id) ||
    typeof value.body !== "string" ||
    !record(value.user) ||
    typeof value.user.login !== "string"
  )
    throw new Error("certified_fork_comment_invalid");
  return {
    id: Number(value.id),
    body: value.body,
    author: value.user.login.toLowerCase(),
    url: typeof value.html_url === "string" ? value.html_url : undefined,
  };
}
function split(value: string): [string, string] {
  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[1])
  )
    throw new Error("certified_fork_repository_invalid");
  return [parts[0], parts[1]];
}
function safePath(value: string) {
  return (
    value.length <= 500 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("`") &&
    !/[\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    !value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function id(value: unknown) {
  return (
    (typeof value === "number" || typeof value === "string") &&
    /^[1-9][0-9]*$/.test(String(value))
  );
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function canonical(value: unknown): string {
  return JSON.stringify(sort(value));
}
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (record(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort(value[key])]),
    );
  return value;
}
function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
