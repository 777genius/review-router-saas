import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import type { CertifiedForkReviewBinding } from "../ports/certified-fork-review-port.js";
import { parseCertifiedForkReviewBinding } from "./certified-fork-review-binding.js";

export type CertifiedForkReviewFile = Readonly<{
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}>;

export type CertifiedForkReviewPromptPacket = Readonly<{
  protocolVersion: 1;
  binding: CertifiedForkReviewBinding;
  contextHash: string;
  files: readonly CertifiedForkReviewFile[];
}>;

export type CertifiedForkReviewFinding = Readonly<{
  severity: "critical" | "major" | "minor" | "info";
  title: string;
  body: string;
  path?: string;
  startLine?: number;
  endLine?: number;
}>;

export type CertifiedForkReviewModelOutput = Readonly<{
  protocolVersion: 1;
  summaryMarkdown: string;
  findings: readonly CertifiedForkReviewFinding[];
}>;

const fileKeys = ["path", "status", "additions", "deletions", "patch"] as const;
const packetKeys = [
  "protocolVersion",
  "binding",
  "contextHash",
  "files",
] as const;
const modelOutputKeys = [
  "protocolVersion",
  "summaryMarkdown",
  "findings",
] as const;
const hex64 = /^[a-f0-9]{64}$/u;
const safePathBanned = /[\\`\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u;
const fileStatuses = new Set<CertifiedForkReviewFile["status"]>([
  "added",
  "modified",
  "removed",
  "renamed",
]);
const severities = new Set<CertifiedForkReviewFinding["severity"]>([
  "critical",
  "major",
  "minor",
  "info",
]);

export const certifiedForkReviewFilePatchMaxBytes = 200_000;
export const certifiedForkReviewPacketMaxBytes = 300_000;
export const certifiedForkReviewMaxFiles = 500;
export const certifiedForkReviewModelSummaryMaxBytes = 60_000;
export const certifiedForkReviewModelTitleMaxBytes = 200;
export const certifiedForkReviewModelBodyMaxBytes = 8_000;
export const certifiedForkReviewModelPathMaxBytes = 500;
export const certifiedForkReviewMaxFindings = 50;

function invalid(code: string): never {
  throw new Error(code);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
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

export function readExactRecord(
  input: unknown,
  allowedKeys: readonly string[],
  code: string,
): Record<string, unknown> {
  return readRequiredRecord(input, allowedKeys, [], code);
}

function readRequiredRecord(
  input: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!isPlainObject(input)) invalid(code);
  const allowedKeys = [...requiredKeys, ...optionalKeys];
  const keys = Reflect.ownKeys(input);
  if (
    keys.length < requiredKeys.length ||
    keys.length > allowedKeys.length ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
  )
    invalid(code);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const values: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string") invalid(code);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    )
      invalid(code);
    values[key] = descriptor.value;
  }
  if (
    requiredKeys.some(
      (key) => !Object.prototype.hasOwnProperty.call(values, key),
    )
  )
    invalid(code);
  return values;
}

function readStrictArray(
  input: unknown,
  code: string,
  maxLength: number,
  tooManyCode = code,
): readonly unknown[] {
  if (
    typeof input !== "object" ||
    input === null ||
    isProxy(input) ||
    !Array.isArray(input)
  ) {
    invalid(code);
  }
  if (Object.getPrototypeOf(input) !== Array.prototype) {
    invalid(code);
  }
  const length = input.length;
  if (length > maxLength) invalid(tooManyCode);
  const keys = Reflect.ownKeys(input);
  if (keys.length !== length + 1) invalid(code);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      invalid(code);
    }
    result.push(descriptor.value);
  }
  return result;
}

function assertSafePath(
  path: unknown,
  code: string,
  maxBytes = certifiedForkReviewPacketMaxBytes,
): asserts path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    byteLength(path) > maxBytes
  ) {
    invalid(code);
  }
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    safePathBanned.test(path)
  ) {
    invalid(code);
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    invalid(code);
  }
}

export function parseCertifiedForkReviewFile(
  input: unknown,
): CertifiedForkReviewFile {
  const values = readExactRecord(
    input,
    fileKeys,
    "certified_fork_review_file_invalid",
  );
  assertSafePath(values.path, "certified_fork_review_file_path_invalid");
  if (
    typeof values.status !== "string" ||
    !fileStatuses.has(values.status as CertifiedForkReviewFile["status"])
  ) {
    invalid("certified_fork_review_file_status_invalid");
  }
  for (const count of [values.additions, values.deletions]) {
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      invalid("certified_fork_review_file_count_invalid");
    }
  }
  if (
    typeof values.patch !== "string" ||
    byteLength(values.patch) > certifiedForkReviewFilePatchMaxBytes
  ) {
    invalid("certified_fork_review_file_patch_invalid");
  }
  return Object.freeze({
    path: values.path,
    status: values.status as CertifiedForkReviewFile["status"],
    additions: values.additions as number,
    deletions: values.deletions as number,
    patch: values.patch,
  });
}

export function parseCertifiedForkReviewFiles(
  input: unknown,
): readonly CertifiedForkReviewFile[] {
  const values = readStrictArray(
    input,
    "certified_fork_review_files_invalid",
    certifiedForkReviewMaxFiles,
    "certified_fork_review_files_too_many",
  );
  const files: CertifiedForkReviewFile[] = [];
  let encodedBytes = 2;
  for (const value of values) {
    const file = parseCertifiedForkReviewFile(value);
    encodedBytes +=
      byteLength(JSON.stringify(file)) + (files.length === 0 ? 0 : 1);
    if (encodedBytes > certifiedForkReviewPacketMaxBytes)
      invalid("certified_fork_review_packet_too_large");
    files.push(file);
  }
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length)
    invalid("certified_fork_review_duplicate_path");
  return Object.freeze(files);
}

function bindingObject(
  binding: CertifiedForkReviewBinding,
): Record<string, unknown> {
  return {
    sourceRepository: binding.sourceRepository,
    sourceRepositoryId: binding.sourceRepositoryId,
    baseRepository: binding.baseRepository,
    baseRepositoryId: binding.baseRepositoryId,
    pullRequestNumber: binding.pullRequestNumber,
    reviewHeadSha: binding.reviewHeadSha,
    baseSha: binding.baseSha,
    trustDomain: binding.trustDomain,
  };
}

function fileObject(file: CertifiedForkReviewFile): Record<string, unknown> {
  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  };
}

export function serializeCertifiedForkReviewPacketContent(
  input: unknown,
): string {
  const values = readExactRecord(
    input,
    ["binding", "files"],
    "certified_fork_review_content_invalid",
  );
  const binding = parseCertifiedForkReviewBinding(values.binding);
  const files = parseCertifiedForkReviewFiles(values.files);
  return JSON.stringify({
    protocolVersion: 1,
    binding: bindingObject(binding),
    files: files.map(fileObject),
  });
}

export function serializeCertifiedForkReviewPromptPacket(
  input: unknown,
): string {
  const packet = parseCertifiedForkReviewPromptPacket(input);
  return serializeParsedCertifiedForkReviewPromptPacket(packet);
}

function serializeParsedCertifiedForkReviewPromptPacket(
  packet: CertifiedForkReviewPromptPacket,
): string {
  return JSON.stringify({
    protocolVersion: 1,
    binding: bindingObject(packet.binding),
    contextHash: packet.contextHash,
    files: packet.files.map(fileObject),
  });
}

export function certifiedForkReviewPromptContextHash(input: unknown): string {
  return createHash("sha256")
    .update(serializeCertifiedForkReviewPacketContent(input), "utf8")
    .digest("hex");
}

export function parseCertifiedForkReviewPromptPacket(
  input: unknown,
): CertifiedForkReviewPromptPacket {
  const values = readExactRecord(
    input,
    packetKeys,
    "certified_fork_review_packet_invalid",
  );
  if (values.protocolVersion !== 1)
    invalid("certified_fork_review_packet_version_invalid");
  const binding = parseCertifiedForkReviewBinding(values.binding);
  const files = parseCertifiedForkReviewFiles(values.files);
  if (
    typeof values.contextHash !== "string" ||
    !hex64.test(values.contextHash)
  ) {
    invalid("certified_fork_review_context_hash_invalid");
  }
  const expectedHash = certifiedForkReviewPromptContextHash({ binding, files });
  if (values.contextHash !== expectedHash)
    invalid("certified_fork_review_context_hash_mismatch");
  const packet = Object.freeze({
    protocolVersion: 1 as const,
    binding,
    contextHash: values.contextHash,
    files,
  });
  if (
    byteLength(serializeParsedCertifiedForkReviewPromptPacket(packet)) >
    certifiedForkReviewPacketMaxBytes
  ) {
    invalid("certified_fork_review_packet_too_large");
  }
  return packet;
}

function parseFinding(
  input: unknown,
  filePaths: ReadonlySet<string>,
): CertifiedForkReviewFinding {
  const values = readRequiredRecord(
    input,
    ["severity", "title", "body"],
    ["path", "startLine", "endLine"],
    "certified_fork_review_finding_invalid",
  );
  if (
    typeof values.severity !== "string" ||
    !severities.has(values.severity as CertifiedForkReviewFinding["severity"])
  ) {
    invalid("certified_fork_review_finding_severity_invalid");
  }
  if (
    typeof values.title !== "string" ||
    values.title.length === 0 ||
    byteLength(values.title) > certifiedForkReviewModelTitleMaxBytes
  ) {
    invalid("certified_fork_review_finding_title_invalid");
  }
  if (
    typeof values.body !== "string" ||
    values.body.length === 0 ||
    byteLength(values.body) > certifiedForkReviewModelBodyMaxBytes
  ) {
    invalid("certified_fork_review_finding_body_invalid");
  }
  const hasPath = Object.prototype.hasOwnProperty.call(values, "path");
  if (hasPath) {
    assertSafePath(
      values.path,
      "certified_fork_review_finding_path_invalid",
      certifiedForkReviewModelPathMaxBytes,
    );
    if (!filePaths.has(values.path))
      invalid("certified_fork_review_finding_path_unknown");
  }
  for (const lineName of ["startLine", "endLine"] as const) {
    const line = values[lineName];
    if (
      Object.prototype.hasOwnProperty.call(values, lineName) &&
      (typeof line !== "number" ||
        !Number.isSafeInteger(line) ||
        line <= 0 ||
        line > 1_000_000)
    ) {
      invalid("certified_fork_review_finding_line_invalid");
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(values, "startLine") &&
    Object.prototype.hasOwnProperty.call(values, "endLine") &&
    (values.endLine as number) < (values.startLine as number)
  ) {
    invalid("certified_fork_review_finding_line_order_invalid");
  }
  const path = values.path as string | undefined;
  const startLine = values.startLine as number | undefined;
  const endLine = values.endLine as number | undefined;
  return Object.freeze({
    severity: values.severity as CertifiedForkReviewFinding["severity"],
    title: values.title,
    body: values.body,
    ...(path === undefined ? {} : { path }),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  });
}

export function parseCertifiedForkReviewModelOutput(
  input: unknown,
  filePaths: ReadonlySet<string> | readonly string[],
): CertifiedForkReviewModelOutput {
  const values = readExactRecord(
    input,
    modelOutputKeys,
    "certified_fork_review_model_output_invalid",
  );
  if (values.protocolVersion !== 1)
    invalid("certified_fork_review_model_output_version_invalid");
  if (
    typeof values.summaryMarkdown !== "string" ||
    values.summaryMarkdown.length === 0 ||
    byteLength(values.summaryMarkdown) > certifiedForkReviewModelSummaryMaxBytes
  ) {
    invalid("certified_fork_review_model_summary_invalid");
  }
  const findingsInput = readStrictArray(
    values.findings,
    "certified_fork_review_model_findings_invalid",
    certifiedForkReviewMaxFindings,
    "certified_fork_review_model_findings_too_many",
  );
  const paths = filePaths instanceof Set ? filePaths : new Set(filePaths);
  const findings = Object.freeze(
    findingsInput.map((finding) => parseFinding(finding, paths)),
  );
  return Object.freeze({
    protocolVersion: 1 as const,
    summaryMarkdown: values.summaryMarkdown,
    findings,
  });
}

function findingObject(
  finding: CertifiedForkReviewFinding,
): Record<string, unknown> {
  return {
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    ...(finding.path === undefined ? {} : { path: finding.path }),
    ...(finding.startLine === undefined
      ? {}
      : { startLine: finding.startLine }),
    ...(finding.endLine === undefined ? {} : { endLine: finding.endLine }),
  };
}

export function serializeCertifiedForkReviewModelOutput(
  input: unknown,
  filePaths: ReadonlySet<string> | readonly string[],
): string {
  const output = parseCertifiedForkReviewModelOutput(input, filePaths);
  return JSON.stringify({
    protocolVersion: 1,
    summaryMarkdown: output.summaryMarkdown,
    findings: output.findings.map(findingObject),
  });
}

export function certifiedForkReviewModelOutputHash(
  input: unknown,
  filePaths: ReadonlySet<string> | readonly string[],
): string {
  return createHash("sha256")
    .update(serializeCertifiedForkReviewModelOutput(input, filePaths), "utf8")
    .digest("hex");
}
