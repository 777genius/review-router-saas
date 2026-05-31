import {
  createReviewPublicationPlan,
  reviewFindingInlineSkipReason,
  type ReviewFinding,
  type ReviewFindingLocation,
  type ReviewPublicationPlan,
  type ReviewPublicationTarget,
} from "../../domain/review-publication";
import {
  renderReviewFindingMarkdown,
  renderReviewSummaryMarkdown,
  reviewFindingMarker,
  reviewSummaryMarker,
} from "../../domain/review-publication-markdown";
import type { ReviewPublicationSkippedInlineFinding } from "../../application/ports/review-publisher-port";
import type { ReviewPublisherPort } from "../../application/ports/review-publisher-port";

type FetchLike = typeof fetch;

export type GitLabReviewPublisherOptions = {
  readonly token: string;
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly maxDiscussionPages?: number | undefined;
};

type GitLabMergeRequest = {
  readonly iid: number;
  readonly project_id: number;
  readonly source_project_id: number;
  readonly target_project_id: number;
  readonly state: string;
  readonly sha: string;
  readonly diff_refs?: {
    readonly base_sha?: string | null;
    readonly start_sha?: string | null;
    readonly head_sha?: string | null;
  } | null;
};

type GitLabMergeRequestVersion = {
  readonly head_commit_sha: string;
  readonly base_commit_sha: string;
  readonly start_commit_sha: string;
  readonly state?: string | undefined;
};

type GitLabDiff = {
  readonly old_path: string;
  readonly new_path: string;
  readonly diff?: string | undefined;
  readonly collapsed?: boolean | undefined;
  readonly too_large?: boolean | undefined;
};

type GitLabDiscussion = {
  readonly id: string;
  readonly notes?: readonly GitLabDiscussionNote[] | undefined;
};

type GitLabDiscussionNote = {
  readonly id: number;
  readonly body?: string | null | undefined;
  readonly position?:
    | {
        readonly head_sha?: string | null | undefined;
        readonly old_path?: string | null | undefined;
        readonly new_path?: string | null | undefined;
        readonly old_line?: number | null | undefined;
        readonly new_line?: number | null | undefined;
      }
    | null
    | undefined;
};

type GitLabDiscussionCreateResponse = {
  readonly id: string;
  readonly notes?: readonly GitLabDiscussionNote[] | undefined;
};

type GitLabDiffPosition = {
  readonly oldPath: string;
  readonly newPath: string;
  readonly oldLine?: number | undefined;
  readonly newLine?: number | undefined;
};

type ExistingReviewNote = {
  readonly discussionId: string;
  readonly noteId: number;
};

const defaultGitLabApiBaseUrl = "https://gitlab.com/api/v4";
const defaultMaxDiscussionPages = 10;

export class GitLabReviewPublisher implements ReviewPublisherPort {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxDiscussionPages: number;

  constructor(options: GitLabReviewPublisherOptions) {
    const token = options.token.trim();
    if (!token) {
      throw new Error("gitlab_review_publisher_token_required");
    }
    this.token = token;
    this.apiBaseUrl = (options.apiBaseUrl ?? defaultGitLabApiBaseUrl).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxDiscussionPages =
      options.maxDiscussionPages ?? defaultMaxDiscussionPages;
  }

  async publishReview(plan: ReviewPublicationPlan) {
    if (plan.target.provider !== "gitlab") {
      throw new Error("gitlab_review_publisher_target_invalid");
    }

    const mergeRequest = await this.fetchMergeRequest(plan.target);
    assertMergeRequestMatchesTarget({ mergeRequest, target: plan.target });
    const latestVersion = await this.fetchLatestMergeRequestVersion(
      plan.target,
    );
    assertLatestVersionMatchesTarget({ latestVersion, target: plan.target });
    const effectivePlan = createReviewPublicationPlan({
      target: {
        ...plan.target,
        baseSha: latestVersion.base_commit_sha,
        startSha: latestVersion.start_commit_sha,
        headSha: latestVersion.head_commit_sha,
      },
      marker: plan.marker,
      mode: plan.mode,
      maxInlineComments: plan.maxInlineComments,
      findings: plan.findings,
    });
    const [existingDiscussions, diffs] = await Promise.all([
      this.listMergeRequestDiscussions(plan.target),
      this.listMergeRequestDiffs(plan.target),
    ]);

    const externalIds: string[] = [];
    const skippedInlineFindings: ReviewPublicationSkippedInlineFinding[] = [];
    const summaryId = await this.upsertDiscussionNote({
      target: effectivePlan.target,
      existing: findExistingNote({
        discussions: existingDiscussions,
        marker: reviewSummaryMarker(effectivePlan.marker),
      }),
      body: renderReviewSummaryMarkdown({ plan: effectivePlan }),
    });
    externalIds.push(`gitlab:summary:${summaryId}`);

    let inlineCommentCount = 0;
    const claimedExistingInlineNotes = new Set<string>();
    for (const finding of effectivePlan.findings) {
      const skipReason = reviewFindingInlineSkipReason({
        finding,
        plan: effectivePlan,
        inlineIndex: inlineCommentCount,
      });
      if (skipReason) {
        skippedInlineFindings.push({
          fingerprint: finding.fingerprint,
          reason: skipReason,
        });
        continue;
      }

      const position = mapFindingToGitLabPosition({
        finding,
        diffs,
      });
      if (!position) {
        skippedInlineFindings.push({
          fingerprint: finding.fingerprint,
          reason: "provider_position_unavailable" as const,
        });
        continue;
      }

      const inlineId = await this.upsertDiscussionNote({
        target: effectivePlan.target,
        existing: findExistingInlineNote({
          discussions: existingDiscussions,
          marker: effectivePlan.marker,
          fingerprint: finding.fingerprint,
          headSha: effectivePlan.target.headSha,
          position,
          claimed: claimedExistingInlineNotes,
        }),
        body: renderReviewFindingMarkdown({ plan: effectivePlan, finding }),
        position,
      });
      claimedExistingInlineNotes.add(inlineId);
      inlineCommentCount += 1;
      externalIds.push(`gitlab:inline:${finding.fingerprint}:${inlineId}`);
    }

    return {
      target: effectivePlan.target,
      inlineCommentCount,
      summaryCommentCount: 1,
      skippedInlineFindings,
      externalIds,
    };
  }

  private async fetchMergeRequest(
    target: ReviewPublicationTarget,
  ): Promise<GitLabMergeRequest> {
    return this.requestJson<GitLabMergeRequest>({
      method: "GET",
      path: `/projects/${encodeURIComponent(target.repositoryExternalId)}/merge_requests/${encodeURIComponent(target.changeRequestExternalId)}`,
      label: "gitlab_merge_request_fetch",
    });
  }

  private async fetchLatestMergeRequestVersion(
    target: ReviewPublicationTarget,
  ): Promise<GitLabMergeRequestVersion> {
    const versions = await this.requestJson<GitLabMergeRequestVersion[]>({
      method: "GET",
      path: `/projects/${encodeURIComponent(target.repositoryExternalId)}/merge_requests/${encodeURIComponent(target.changeRequestExternalId)}/versions`,
      label: "gitlab_merge_request_versions_fetch",
    });
    if (!Array.isArray(versions) || !versions[0]) {
      throw new Error("gitlab_merge_request_version_missing");
    }
    return versions[0];
  }

  private async listMergeRequestDiffs(
    target: ReviewPublicationTarget,
  ): Promise<readonly GitLabDiff[]> {
    const diffs = await this.requestJson<GitLabDiff[]>({
      method: "GET",
      path: `/projects/${encodeURIComponent(target.repositoryExternalId)}/merge_requests/${encodeURIComponent(target.changeRequestExternalId)}/diffs?per_page=100`,
      label: "gitlab_merge_request_diffs_fetch",
    });
    if (!Array.isArray(diffs)) {
      throw new Error("gitlab_merge_request_diffs_invalid");
    }
    return diffs;
  }

  private async listMergeRequestDiscussions(
    target: ReviewPublicationTarget,
  ): Promise<readonly GitLabDiscussion[]> {
    const discussions: GitLabDiscussion[] = [];
    let nextPage = "1";
    for (let page = 0; page < this.maxDiscussionPages; page += 1) {
      const response = await this.request({
        method: "GET",
        path: `/projects/${encodeURIComponent(target.repositoryExternalId)}/merge_requests/${encodeURIComponent(target.changeRequestExternalId)}/discussions?per_page=100&page=${nextPage}`,
        label: "gitlab_merge_request_discussions_fetch",
      });
      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) {
        throw new Error("gitlab_merge_request_discussions_invalid");
      }
      discussions.push(...(body as GitLabDiscussion[]));
      nextPage = response.headers.get("x-next-page")?.trim() ?? "";
      if (!nextPage) {
        break;
      }
    }
    return discussions;
  }

  private async upsertDiscussionNote(input: {
    readonly target: ReviewPublicationTarget;
    readonly existing: ExistingReviewNote | null;
    readonly body: string;
    readonly position?: GitLabDiffPosition | undefined;
  }): Promise<string> {
    if (input.existing) {
      await this.requestJson({
        method: "PUT",
        path: `/projects/${encodeURIComponent(input.target.repositoryExternalId)}/merge_requests/${encodeURIComponent(input.target.changeRequestExternalId)}/discussions/${encodeURIComponent(input.existing.discussionId)}/notes/${input.existing.noteId}`,
        label: "gitlab_merge_request_discussion_update",
        body: new URLSearchParams({ body: input.body }),
      });
      return `${input.existing.discussionId}:${input.existing.noteId}`;
    }

    const body = new URLSearchParams({ body: input.body });
    if (input.position) {
      body.set("position[position_type]", "text");
      body.set("position[base_sha]", requireSha(input.target.baseSha));
      body.set("position[start_sha]", requireSha(input.target.startSha));
      body.set("position[head_sha]", requireSha(input.target.headSha));
      body.set("position[old_path]", input.position.oldPath);
      body.set("position[new_path]", input.position.newPath);
      if (input.position.oldLine !== undefined) {
        body.set("position[old_line]", String(input.position.oldLine));
      }
      if (input.position.newLine !== undefined) {
        body.set("position[new_line]", String(input.position.newLine));
      }
    }

    const created = await this.requestJson<GitLabDiscussionCreateResponse>({
      method: "POST",
      path: `/projects/${encodeURIComponent(input.target.repositoryExternalId)}/merge_requests/${encodeURIComponent(input.target.changeRequestExternalId)}/discussions`,
      label: "gitlab_merge_request_discussion_create",
      body,
    });
    const noteId = created.notes?.[0]?.id;
    if (typeof created.id !== "string" || typeof noteId !== "number") {
      throw new Error("gitlab_merge_request_discussion_create_invalid");
    }
    return `${created.id}:${noteId}`;
  }

  private async requestJson<T>(input: {
    readonly method: string;
    readonly path: string;
    readonly label: string;
    readonly body?: URLSearchParams | undefined;
  }): Promise<T> {
    const response = await this.request(input);
    return (await response.json()) as T;
  }

  private async request(input: {
    readonly method: string;
    readonly path: string;
    readonly label: string;
    readonly body?: URLSearchParams | undefined;
  }): Promise<Response> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${input.path}`, {
      method: input.method,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "private-token": this.token,
      },
      ...(input.body ? { body: input.body } : {}),
    });
    if (!response.ok) {
      throw new Error(`${input.label}_failed:${response.status}`);
    }
    return response;
  }
}

function assertMergeRequestMatchesTarget(input: {
  readonly mergeRequest: GitLabMergeRequest;
  readonly target: ReviewPublicationTarget;
}): void {
  const projectId = Number(input.target.repositoryExternalId);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error("gitlab_project_id_invalid");
  }
  if (input.mergeRequest.iid !== Number(input.target.changeRequestExternalId)) {
    throw new Error("gitlab_merge_request_iid_mismatch");
  }
  if (input.mergeRequest.target_project_id !== projectId) {
    throw new Error("gitlab_merge_request_target_project_mismatch");
  }
  if (
    input.mergeRequest.source_project_id !==
    input.mergeRequest.target_project_id
  ) {
    throw new Error("gitlab_merge_request_fork_unsupported");
  }
  if (input.mergeRequest.state !== "opened") {
    throw new Error("gitlab_merge_request_not_opened");
  }
  if (input.mergeRequest.sha.toLowerCase() !== input.target.headSha) {
    throw new Error("gitlab_merge_request_head_sha_mismatch");
  }
}

function assertLatestVersionMatchesTarget(input: {
  readonly latestVersion: GitLabMergeRequestVersion;
  readonly target: ReviewPublicationTarget;
}): void {
  const latestHeadSha = input.latestVersion.head_commit_sha.toLowerCase();
  const latestBaseSha = input.latestVersion.base_commit_sha.toLowerCase();
  const latestStartSha = input.latestVersion.start_commit_sha.toLowerCase();
  if (latestHeadSha !== input.target.headSha) {
    throw new Error("gitlab_merge_request_version_head_sha_mismatch");
  }
  if (input.target.baseSha && latestBaseSha !== input.target.baseSha) {
    throw new Error("gitlab_merge_request_version_base_sha_mismatch");
  }
  if (input.target.startSha && latestStartSha !== input.target.startSha) {
    throw new Error("gitlab_merge_request_version_start_sha_mismatch");
  }
}

function mapFindingToGitLabPosition(input: {
  readonly finding: ReviewFinding;
  readonly diffs: readonly GitLabDiff[];
}): GitLabDiffPosition | null {
  const location = input.finding.location;
  if (!location) {
    return null;
  }
  for (const diff of input.diffs) {
    if (diff.collapsed || diff.too_large || !diff.diff) {
      continue;
    }
    if (
      diff.old_path !== location.filePath &&
      diff.new_path !== location.filePath
    ) {
      continue;
    }
    const lineKind = findLocationInUnifiedDiff({
      diff: diff.diff,
      location,
    });
    if (!lineKind) {
      continue;
    }
    return {
      oldPath: diff.old_path,
      newPath: diff.new_path,
      ...(lineKind.oldLine !== undefined ? { oldLine: lineKind.oldLine } : {}),
      ...(lineKind.newLine !== undefined ? { newLine: lineKind.newLine } : {}),
    };
  }
  return null;
}

function findLocationInUnifiedDiff(input: {
  readonly diff: string;
  readonly location: ReviewFindingLocation;
}): {
  readonly oldLine?: number | undefined;
  readonly newLine?: number | undefined;
} | null {
  let insideHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of input.diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      insideHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!insideHunk || line.startsWith("\\ No newline")) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (
        input.location.newLine === newLine &&
        input.location.oldLine === undefined
      ) {
        return { newLine };
      }
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      if (
        input.location.oldLine === oldLine &&
        input.location.newLine === undefined
      ) {
        return { oldLine };
      }
      oldLine += 1;
      continue;
    }
    if (
      contextLineMatchesLocation({ location: input.location, oldLine, newLine })
    ) {
      return { oldLine, newLine };
    }
    oldLine += 1;
    newLine += 1;
  }
  return null;
}

function contextLineMatchesLocation(input: {
  readonly location: ReviewFindingLocation;
  readonly oldLine: number;
  readonly newLine: number;
}): boolean {
  if (
    input.location.oldLine !== undefined &&
    input.location.newLine !== undefined
  ) {
    return (
      input.location.oldLine === input.oldLine &&
      input.location.newLine === input.newLine
    );
  }
  if (input.location.oldLine !== undefined) {
    return input.location.oldLine === input.oldLine;
  }
  return input.location.newLine === input.newLine;
}

function findExistingNote(input: {
  readonly discussions: readonly GitLabDiscussion[];
  readonly marker: string;
  readonly headSha?: string | undefined;
  readonly claimed?: ReadonlySet<string> | undefined;
}): ExistingReviewNote | null {
  for (const discussion of input.discussions) {
    for (const note of discussion.notes ?? []) {
      const noteKey = `${discussion.id}:${note.id}`;
      if (input.claimed?.has(noteKey)) {
        continue;
      }
      if (
        typeof note.body === "string" &&
        note.body.startsWith(input.marker) &&
        (!input.headSha ||
          note.position?.head_sha?.toLowerCase() === input.headSha)
      ) {
        return { discussionId: discussion.id, noteId: note.id };
      }
    }
  }
  return null;
}

function findExistingInlineNote(input: {
  readonly discussions: readonly GitLabDiscussion[];
  readonly marker: string;
  readonly fingerprint: string;
  readonly headSha: string;
  readonly position: GitLabDiffPosition;
  readonly claimed: ReadonlySet<string>;
}): ExistingReviewNote | null {
  return (
    findExistingNote({
      discussions: input.discussions,
      marker: reviewFindingMarker({
        marker: input.marker,
        fingerprint: input.fingerprint,
      }),
      headSha: input.headSha,
      claimed: input.claimed,
    }) ??
    findExistingNoteAtPosition({
      discussions: input.discussions,
      markerPrefix: `<!-- ${input.marker} finding=`,
      headSha: input.headSha,
      position: input.position,
      claimed: input.claimed,
    })
  );
}

function findExistingNoteAtPosition(input: {
  readonly discussions: readonly GitLabDiscussion[];
  readonly markerPrefix: string;
  readonly headSha: string;
  readonly position: GitLabDiffPosition;
  readonly claimed: ReadonlySet<string>;
}): ExistingReviewNote | null {
  for (const discussion of input.discussions) {
    for (const note of discussion.notes ?? []) {
      const noteKey = `${discussion.id}:${note.id}`;
      if (
        input.claimed.has(noteKey) ||
        typeof note.body !== "string" ||
        !note.body.startsWith(input.markerPrefix) ||
        !gitLabNotePositionMatches({
          note,
          headSha: input.headSha,
          position: input.position,
        })
      ) {
        continue;
      }
      return { discussionId: discussion.id, noteId: note.id };
    }
  }
  return null;
}

function gitLabNotePositionMatches(input: {
  readonly note: GitLabDiscussionNote;
  readonly headSha: string;
  readonly position: GitLabDiffPosition;
}): boolean {
  const position = input.note.position;
  if (!position || position.head_sha?.toLowerCase() !== input.headSha) {
    return false;
  }
  return (
    position.old_path === input.position.oldPath &&
    position.new_path === input.position.newPath &&
    normalizeOptionalLine(position.old_line) ===
      normalizeOptionalLine(input.position.oldLine) &&
    normalizeOptionalLine(position.new_line) ===
      normalizeOptionalLine(input.position.newLine)
  );
}

function normalizeOptionalLine(
  value: number | null | undefined,
): number | null {
  return typeof value === "number" ? value : null;
}

function requireSha(value: string | undefined): string {
  if (!value) {
    throw new Error("gitlab_diff_refs_required");
  }
  return value;
}
