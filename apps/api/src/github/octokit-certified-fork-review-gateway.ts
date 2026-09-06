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

    const files: CertifiedForkReviewFile[] = [];
    let patchBytes = 0;
    let changedLines = 0;
    for (
      let page = 1;
      page <= Math.ceil(certifiedForkReviewMaxFiles / 100);
      page += 1
    ) {
      const pullRequest = await validateTuple(octokit, input.binding);
      if (pullRequest.changedFiles > certifiedForkReviewMaxFiles) {
        throw new Error("certified_fork_diff_budget_exceeded");
      }
      if (pullRequest.changedFiles !== expectedChangedFiles) {
        throw new Error("certified_fork_tuple_mismatch");
      }
      const [owner, repo] = splitRepository(input.binding.baseRepository);
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
      if (!Array.isArray(response.data)) {
        throw new Error("certified_fork_files_invalid");
      }
      for (const rawFile of response.data) {
        const file = parseGitHubFile(rawFile);
        const filePatchBytes = Buffer.byteLength(file.patch, "utf8");
        patchBytes += filePatchBytes;
        changedLines += file.additions + file.deletions;
        if (
          files.length >= certifiedForkReviewMaxFiles ||
          filePatchBytes > certifiedForkReviewMaxFilePatchBytes ||
          patchBytes > maxPatchBytes ||
          changedLines > maxChangedLines
        ) {
          throw new Error("certified_fork_diff_budget_exceeded");
        }
        files.push(file);
      }
      if (files.length === expectedChangedFiles || response.data.length < 100) {
        break;
      }
      if (page === Math.ceil(certifiedForkReviewMaxFiles / 100)) {
        throw new Error("certified_fork_diff_pagination_exceeded");
      }
    }
    if (files.length !== expectedChangedFiles) {
      throw new Error("certified_fork_files_incomplete");
    }
    const finalPullRequest = await validateTuple(octokit, input.binding);
    if (
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
): Promise<PullRequestSnapshot> {
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
  const base = parseRepository(baseResponse.data);
  const source = parseRepository(sourceResponse.data);
  const pullRequest = parsePullRequest(pullRequestResponse.data);
  if (
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
  return pullRequest;
}

function parseRepository(value: unknown): RepositorySnapshot {
  if (!isPlainRecord(value)) {
    throw new Error("certified_fork_repository_invalid");
  }
  const idValue = dataProperty(value, "id");
  const fullName = dataProperty(value, "full_name");
  const privateValue = dataProperty(value, "private");
  const visibility = dataProperty(value, "visibility");
  if (
    !isIdentifier(idValue) ||
    typeof fullName !== "string" ||
    typeof privateValue !== "boolean" ||
    typeof visibility !== "string"
  ) {
    throw new Error("certified_fork_repository_invalid");
  }
  return {
    id: String(idValue),
    fullName,
    private: privateValue,
    visibility,
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
    patch.length === 0 ||
    patch.includes("GIT binary patch") ||
    patch.includes("Binary files ")
  ) {
    throw new Error("certified_fork_file_unsupported");
  }
  if (Buffer.byteLength(patch, "utf8") > certifiedForkReviewMaxFilePatchBytes) {
    throw new Error("certified_fork_diff_budget_exceeded");
  }
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
    (typeof value === "number" || typeof value === "string") &&
    /^[1-9][0-9]*$/u.test(String(value))
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
