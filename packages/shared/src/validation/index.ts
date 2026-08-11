import { z } from "zod";
export { isLoopbackHostname } from "./loopback-hostname.mjs";

export const nonEmptyString = z.string().trim().min(1);

export const gitHubBranchNameMaxLength = 255;

export const safeGitHubBranchName = z
  .string()
  .min(1)
  .max(gitHubBranchNameMaxLength)
  .refine(isSafeGitHubBranchName, {
    message: "unsafe_github_branch_name",
  });

export const conflictReviewDispatchIdPattern =
  /^cr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const safeConflictReviewDispatchId = z
  .string()
  .regex(conflictReviewDispatchIdPattern);

export function isSafeConflictReviewDispatchId(value: string): boolean {
  return conflictReviewDispatchIdPattern.test(value);
}

export function isSafeGitHubBranchName(value: string): boolean {
  if (value.length < 1 || value.length > gitHubBranchNameMaxLength) {
    return false;
  }
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    return false;
  }
  if (value.endsWith(".")) {
    return false;
  }
  if (value === "@" || value.includes("@{")) {
    return false;
  }
  if (value.includes("..")) {
    return false;
  }
  if (/^refs\//i.test(value)) {
    return false;
  }
  if (/^gh-readonly-queue\//i.test(value)) {
    return false;
  }
  if (hasUnsafeGitHubBranchNameCharacter(value)) {
    return false;
  }

  return value.split("/").every(isSafeGitHubBranchNameSegment);
}

function hasUnsafeGitHubBranchNameCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
    if ("~^:?*[\\".includes(value[index]!)) {
      return true;
    }
  }
  return false;
}

function isSafeGitHubBranchNameSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.startsWith(".")) return false;
  if (segment.endsWith(".lock")) return false;
  return true;
}
