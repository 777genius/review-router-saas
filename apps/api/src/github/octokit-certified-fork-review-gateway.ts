import { Buffer } from "node:buffer";
import { isProxy } from "node:util/types";
import { App } from "@octokit/app";
import {
  certifiedForkReviewPacketMaxBytes,
  certifiedForkReviewFilePatchMaxBytes,
  certifiedForkReviewMaxFiles,
  certifiedForkReviewPromptContextHash,
  parseCertifiedForkReviewFile,
  parseCertifiedForkReviewPromptPacket,
  type CertifiedForkReviewFile,
  type CertifiedForkReviewPromptPacket,
} from "@reviewrouter/features-action-control-plane";
import type {
  CertifiedForkReviewBinding,
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

type RepositorySnapshot = Readonly<{
  id: string;
  fullName: string;
  private: boolean;
  visibility: string;
  fork: boolean;
  parentId: string | null;
  sourceId: string | null;
}>;

type PullRequestSnapshot = Readonly<{
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  authorType: string;
  baseSha: string;
  headSha: string;
  baseId: string;
  headId: string;
  baseName: string;
  headName: string;
  changedFiles: number;
}>;

// GitHub exposes at most 300 compare files; 301..500 cannot be certified
// even though the shared packet budget remains 500. Commit pagination cannot help.
const githubCompareMaxFiles = 300;
const maxPatchBytes = 240_000;
const maxChangedLines = 20_000;
const githubRequestTimeoutMs = 15_000;
const contextHashPattern = /^[a-f0-9]{64}$/u;

export const certifiedForkReviewMaxFilePatchBytes =
  certifiedForkReviewFilePatchMaxBytes;

export class OctokitCertifiedForkReviewGateway implements CertifiedForkReviewGatewayPort {
  private readonly app: InstallationApp;

  constructor(options: {
    readonly appId?: string;
    readonly privateKey?: string;
    readonly app?: InstallationApp;
  }) {
    if (!options.app && (!options.appId || !options.privateKey)) {
      throw new Error("certified_fork_github_app_unavailable");
    }
    this.app =
      options.app ??
      new App({ appId: options.appId!, privateKey: options.privateKey! });
  }

  async assertBindingCurrent(input: {
    readonly githubInstallationId: string;
    readonly binding: CertifiedForkReviewBinding;
  }): Promise<void> {
    await validateTuple(
      await this.client(input.githubInstallationId),
      input.binding,
    );
  }

  async prepareContext(input: {
    readonly githubInstallationId: string;
    readonly binding: CertifiedForkReviewBinding;
  }): Promise<{
    readonly contextHash: string;
    readonly promptPacket: CertifiedForkReviewPromptPacket;
  }> {
    const octokit = await this.client(input.githubInstallationId);
    if (input.binding.trustDomain !== "fork") {
      throw new Error("certified_fork_tuple_mismatch");
    }
    const initialPullRequest = await validateTuple(octokit, input.binding);
    const expectedChangedFiles = initialPullRequest.changedFiles;
    if (expectedChangedFiles > certifiedForkReviewMaxFiles) {
      throw new Error("certified_fork_diff_budget_exceeded");
    }

    if (expectedChangedFiles > githubCompareMaxFiles) {
      throw new Error("certified_fork_diff_api_limit_exceeded");
    }
    const [owner, repo] = splitRepository(input.binding.baseRepository);
    const compare = responseData(
      await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        owner,
        repo,
        basehead: `${input.binding.baseSha}...${input.binding.reviewHeadSha}`,
        page: 1,
        per_page: 1,
      }),
    );
    if (!isPlainRecord(compare))
      throw new Error("certified_fork_files_invalid");
    const baseCommit = dataProperty(compare, "base_commit");
    if (
      !isPlainRecord(baseCommit) ||
      dataProperty(baseCommit, "sha") !== input.binding.baseSha
    ) {
      throw new Error("certified_fork_tuple_mismatch");
    }
    // Three-dot comparisons may legitimately have an older merge base.
    const rawFiles = snapshotFiles(dataProperty(compare, "files"));
    if (rawFiles.length !== expectedChangedFiles) {
      throw new Error("certified_fork_files_incomplete");
    }
    const files: CertifiedForkReviewFile[] = [];
    let patchBytes = 0;
    let changedLines = 0;
    for (const rawFile of rawFiles) {
      const file = parseGitHubFile(rawFile);
      patchBytes += Buffer.byteLength(file.patch, "utf8");
      changedLines += file.additions + file.deletions;
      if (patchBytes > maxPatchBytes || changedLines > maxChangedLines) {
        throw new Error("certified_fork_diff_budget_exceeded");
      }
      files.push(file);
    }
    if (files.length !== expectedChangedFiles) {
      throw new Error("certified_fork_files_incomplete");
    }
    const finalPullRequest = await validateTuple(octokit, input.binding);
    if (
      finalPullRequest.relationship !== initialPullRequest.relationship ||
      finalPullRequest.changedFiles !== expectedChangedFiles ||
      finalPullRequest.baseSha !== input.binding.baseSha.toLowerCase() ||
      finalPullRequest.headSha !== input.binding.reviewHeadSha.toLowerCase()
    ) {
      throw new Error("certified_fork_tuple_mismatch");
    }
    try {
      const candidate = parseCertifiedForkReviewPromptPacket({
        protocolVersion: 1,
        binding: input.binding,
        contextHash: certifiedForkReviewPromptContextHash({
          binding: input.binding,
          files,
        }),
        files,
      });
      const contextHash = candidate.contextHash;
      if (
        Buffer.byteLength(JSON.stringify(candidate), "utf8") >
        certifiedForkReviewPacketMaxBytes
      ) {
        throw new Error("certified_fork_review_packet_too_large");
      }
      return {
        contextHash,
        promptPacket: candidate,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "certified_fork_review_packet_too_large"
      ) {
        throw error;
      }
      throw new Error("certified_fork_files_invalid", { cause: error });
    }
  }

  async assertContextCurrent(input: {
    readonly githubInstallationId: string;
    readonly binding: CertifiedForkReviewBinding;
    readonly expectedContextHash: string;
  }): Promise<{ readonly promptPacket: CertifiedForkReviewPromptPacket }> {
    if (!contextHashPattern.test(input.expectedContextHash)) {
      throw new Error("certified_fork_context_mismatch");
    }
    const current = await this.prepareContext(input);
    if (current.contextHash !== input.expectedContextHash) {
      throw new Error("certified_fork_context_mismatch");
    }
    return { promptPacket: current.promptPacket };
  }

  private async client(value: string): Promise<Requester> {
    const installationId = Number(value);
    if (
      !/^[1-9][0-9]*$/u.test(value) ||
      !Number.isSafeInteger(installationId) ||
      installationId < 1
    ) {
      throw new Error("certified_fork_installation_invalid");
    }
    const octokit = await this.app.getInstallationOctokit(installationId);
    return {
      request: (route: string, parameters: Record<string, unknown> = {}) =>
        octokit.request(route, {
          ...parameters,
          request: { timeout: githubRequestTimeoutMs },
        }),
    };
  }
}

async function validateTuple(
  octokit: Requester,
  binding: CertifiedForkReviewBinding,
): Promise<PullRequestSnapshot & { relationship: string }> {
  if (
    binding.trustDomain !== "fork" ||
    !/^[a-f0-9]{40}$/u.test(binding.baseSha) ||
    !/^[a-f0-9]{40}$/u.test(binding.reviewHeadSha) ||
    !Number.isSafeInteger(binding.pullRequestNumber) ||
    binding.pullRequestNumber < 1 ||
    binding.sourceRepositoryId === binding.baseRepositoryId ||
    binding.sourceRepository.toLowerCase() ===
      binding.baseRepository.toLowerCase()
  ) {
    throw new Error("certified_fork_tuple_mismatch");
  }
  const [baseOwner, baseRepo] = splitRepository(binding.baseRepository);
  const [sourceOwner, sourceRepo] = splitRepository(binding.sourceRepository);
  const [baseResponse, sourceResponse, pullRequestResponse] = await Promise.all(
    [
      octokit.request("GET /repos/{owner}/{repo}", {
        owner: baseOwner,
        repo: baseRepo,
      }),
      octokit.request("GET /repos/{owner}/{repo}", {
        owner: sourceOwner,
        repo: sourceRepo,
      }),
      octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: baseOwner,
        repo: baseRepo,
        pull_number: binding.pullRequestNumber,
      }),
    ],
  );
  const base = parseRepository(responseData(baseResponse));
  const source = parseRepository(responseData(sourceResponse));
  const pullRequest = parsePullRequest(responseData(pullRequestResponse));
  if (
    !source.fork ||
    source.sourceId !== (base.fork ? base.sourceId : base.id) ||
    base.id !== binding.baseRepositoryId ||
    source.id !== binding.sourceRepositoryId ||
    normalizeRepositoryName(base.fullName) !==
      normalizeRepositoryName(binding.baseRepository) ||
    normalizeRepositoryName(source.fullName) !==
      normalizeRepositoryName(binding.sourceRepository) ||
    base.private ||
    source.private ||
    base.visibility !== "public" ||
    source.visibility !== "public" ||
    pullRequest.state !== "open" ||
    pullRequest.draft ||
    pullRequest.merged ||
    pullRequest.authorType === "Bot" ||
    pullRequest.number !== binding.pullRequestNumber ||
    pullRequest.baseId !== base.id ||
    pullRequest.headId !== source.id ||
    normalizeRepositoryName(pullRequest.baseName) !==
      normalizeRepositoryName(base.fullName) ||
    normalizeRepositoryName(pullRequest.headName) !==
      normalizeRepositoryName(source.fullName) ||
    pullRequest.baseSha !== binding.baseSha.toLowerCase() ||
    pullRequest.headSha !== binding.reviewHeadSha.toLowerCase()
  ) {
    throw new Error("certified_fork_tuple_mismatch");
  }
  return {
    ...pullRequest,
    relationship: JSON.stringify([
      base.fork,
      base.parentId,
      base.sourceId,
      source.fork,
      source.parentId,
      source.sourceId,
    ]),
  };
}

function parseRepository(value: unknown): RepositorySnapshot {
  if (!isPlainRecord(value)) {
    throw new Error("certified_fork_repository_invalid");
  }
  const idValue = dataProperty(value, "id");
  if (!isIdentifier(idValue)) {
    throw new Error("certified_fork_repository_invalid");
  }
  const id = String(idValue);
  const fullName = dataProperty(value, "full_name");
  const privateValue = dataProperty(value, "private");
  const visibility = dataProperty(value, "visibility");
  const fork = dataProperty(value, "fork");
  let parentId: string | null = null;
  let sourceId: string | null = null;
  if (fork === true) {
    const parent = dataProperty(value, "parent");
    const source = dataProperty(value, "source");
    if (!isPlainRecord(parent) || !isPlainRecord(source))
      throw new Error("certified_fork_repository_invalid");
    const parentValue = dataProperty(parent, "id");
    const sourceValue = dataProperty(source, "id");
    if (
      !isIdentifier(parentValue) ||
      !isIdentifier(sourceValue) ||
      String(parentValue) === id ||
      String(sourceValue) === id
    )
      throw new Error("certified_fork_repository_invalid");
    parentId = String(parentValue);
    sourceId = String(sourceValue);
  }
  if (
    typeof fork !== "boolean" ||
    typeof fullName !== "string" ||
    typeof privateValue !== "boolean" ||
    typeof visibility !== "string"
  ) {
    throw new Error("certified_fork_repository_invalid");
  }
  return {
    id,
    fullName,
    private: privateValue,
    visibility,
    fork,
    parentId,
    sourceId,
  };
}

function parsePullRequest(value: unknown): PullRequestSnapshot {
  if (!isPlainRecord(value)) {
    throw new Error("certified_fork_pull_request_invalid");
  }
  const number = dataProperty(value, "number");
  const state = dataProperty(value, "state");
  const draft = dataProperty(value, "draft");
  const merged = dataProperty(value, "merged");
  const user = dataProperty(value, "user");
  const base = dataProperty(value, "base");
  const head = dataProperty(value, "head");
  const changedFiles = dataProperty(value, "changed_files");
  if (
    !isPositiveInteger(number) ||
    typeof state !== "string" ||
    typeof draft !== "boolean" ||
    typeof merged !== "boolean" ||
    !isPlainRecord(user) ||
    !isPlainRecord(base) ||
    !isPlainRecord(head) ||
    !isNonnegativeInteger(changedFiles)
  ) {
    throw new Error("certified_fork_pull_request_invalid");
  }
  const authorType = dataProperty(user, "type");
  const baseSha = dataProperty(base, "sha");
  const headSha = dataProperty(head, "sha");
  const baseRepo = dataProperty(base, "repo");
  const headRepo = dataProperty(head, "repo");
  if (
    typeof authorType !== "string" ||
    typeof baseSha !== "string" ||
    typeof headSha !== "string" ||
    !isPlainRecord(baseRepo) ||
    !isPlainRecord(headRepo)
  ) {
    throw new Error("certified_fork_pull_request_invalid");
  }
  const baseId = dataProperty(baseRepo, "id");
  const headId = dataProperty(headRepo, "id");
  const baseName = dataProperty(baseRepo, "full_name");
  const headName = dataProperty(headRepo, "full_name");
  if (
    !isIdentifier(baseId) ||
    !isIdentifier(headId) ||
    typeof baseName !== "string" ||
    typeof headName !== "string" ||
    !/^[a-f0-9]{40}$/iu.test(baseSha) ||
    !/^[a-f0-9]{40}$/iu.test(headSha)
  ) {
    throw new Error("certified_fork_pull_request_invalid");
  }
  return {
    number,
    state,
    draft,
    merged,
    authorType,
    baseSha: baseSha.toLowerCase(),
    headSha: headSha.toLowerCase(),
    baseId: String(baseId),
    headId: String(headId),
    baseName,
    headName,
    changedFiles,
  };
}

function parseGitHubFile(value: unknown): CertifiedForkReviewFile {
  if (!isPlainRecord(value)) {
    throw new Error("certified_fork_file_unsupported");
  }
  const path = dataProperty(value, "filename");
  const status = dataProperty(value, "status");
  const additions = dataProperty(value, "additions");
  const deletions = dataProperty(value, "deletions");
  const patch = dataProperty(value, "patch");
  if (
    typeof path !== "string" ||
    typeof status !== "string" ||
    !isNonnegativeInteger(additions) ||
    !isNonnegativeInteger(deletions) ||
    typeof patch !== "string" ||
    patch.length === 0
  ) {
    throw new Error("certified_fork_file_unsupported");
  }
  if (Buffer.byteLength(patch, "utf8") > certifiedForkReviewMaxFilePatchBytes) {
    throw new Error("certified_fork_diff_budget_exceeded");
  }
  validatePatch(patch, additions, deletions);
  const normalizedStatus = status === "deleted" ? "removed" : status;
  if (!["added", "modified", "removed", "renamed"].includes(normalizedStatus)) {
    throw new Error("certified_fork_file_unsupported");
  }
  try {
    return parseCertifiedForkReviewFile({
      path,
      status: normalizedStatus,
      additions,
      deletions,
      patch,
    });
  } catch {
    throw new Error("certified_fork_file_unsupported");
  }
}

function splitRepository(value: string): readonly [string, string] {
  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_.-]+$/u.test(parts[0]!) ||
    !/^[A-Za-z0-9_.-]+$/u.test(parts[1]!)
  ) {
    throw new Error("certified_fork_repository_invalid");
  }
  return [parts[0]!, parts[1]!];
}

function normalizeRepositoryName(value: string): string {
  return value.toLowerCase();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor)
  ) {
    throw new Error("certified_fork_response_accessor");
  }
  return descriptor.value;
}

function isIdentifier(value: unknown): value is string | number {
  return (
    ((typeof value === "number" && Number.isSafeInteger(value)) ||
      typeof value === "string") &&
    /^[1-9][0-9]*$/u.test(String(value))
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function responseData(value: unknown): unknown {
  if (!isPlainRecord(value))
    throw new Error("certified_fork_response_accessor");
  return dataProperty(value, "data");
}

function snapshotFiles(value: unknown): unknown[] {
  const invalid = () => new Error("certified_fork_files_invalid");
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    throw invalid();
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !length ||
    !("value" in length) ||
    length.enumerable ||
    length.configurable ||
    !isNonnegativeInteger(length.value) ||
    length.value > githubCompareMaxFiles
  )
    throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== length.value + 1) throw invalid();
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !descriptor.configurable ||
      !descriptor.writable
    )
      throw invalid();
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length.value; index += 1)
    snapshot.push(descriptors[String(index)]!.value);
  return snapshot;
}

// Local structural completeness proof for GitHub's bounded textual patch.
function validatePatch(
  patch: string,
  additions: number,
  deletions: number,
): void {
  const invalid = () => new Error("certified_fork_file_unsupported");
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let oldRemaining = 0;
  let newRemaining = 0;
  let hunks = 0;
  let added = 0;
  let deleted = 0;
  let markerAllowed = false;
  for (const line of lines) {
    const structural = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (structural.startsWith("@@")) {
      if (oldRemaining !== 0 || newRemaining !== 0) throw invalid();
      const match =
        /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: .*)?$/u.exec(
          structural,
        );
      if (!match) throw invalid();
      const oldStart = Number(match[1]);
      const oldCount = Number(match[2] ?? "1");
      const newStart = Number(match[3]);
      const newCount = Number(match[4] ?? "1");
      if (
        ![oldStart, oldCount, newStart, newCount].every(isNonnegativeInteger) ||
        (oldStart === 0 && oldCount !== 0) ||
        (newStart === 0 && newCount !== 0) ||
        !Number.isSafeInteger(oldStart + oldCount) ||
        !Number.isSafeInteger(newStart + newCount)
      )
        throw invalid();
      oldRemaining = oldCount;
      newRemaining = newCount;
      hunks += 1;
      markerAllowed = false;
      continue;
    }
    if (structural === "\\ No newline at end of file") {
      if (!markerAllowed) throw invalid();
      markerAllowed = false;
      continue;
    }
    if (hunks === 0 || (oldRemaining === 0 && newRemaining === 0))
      throw invalid();
    if (line.startsWith(" ")) {
      oldRemaining -= 1;
      newRemaining -= 1;
    } else if (line.startsWith("+")) {
      newRemaining -= 1;
      added += 1;
    } else if (line.startsWith("-")) {
      oldRemaining -= 1;
      deleted += 1;
    } else throw invalid();
    if (oldRemaining < 0 || newRemaining < 0) throw invalid();
    markerAllowed = true;
  }
  if (
    hunks === 0 ||
    oldRemaining !== 0 ||
    newRemaining !== 0 ||
    added !== additions ||
    deleted !== deletions
  )
    throw invalid();
}
