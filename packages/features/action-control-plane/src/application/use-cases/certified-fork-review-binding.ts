import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import type { CertifiedForkReviewBinding } from "../ports/certified-fork-review-port.js";

export const certifiedForkReviewWorkflowSchemaVersion = 6 as const;

const invalidBindingCode = "certified_fork_review_binding_invalid";
const bindingMismatchCode = "certified_fork_review_binding_mismatch";
const invalidLeaseBindingCode = "certified_fork_lease_binding_invalid";

const bindingFieldNames = [
  "sourceRepository",
  "sourceRepositoryId",
  "baseRepository",
  "baseRepositoryId",
  "pullRequestNumber",
  "reviewHeadSha",
  "baseSha",
  "trustDomain",
] as const;

type BindingFieldName = (typeof bindingFieldNames)[number];

const repositoryFullNamePattern = /^[^\s/\p{Cc}]+\/[^\s/\p{Cc}]+$/u;
const repositoryIdPattern = /^[1-9][0-9]*$/;
const shaPattern = /^[a-f0-9]{40}$/;
const leaseBindingHashPattern = /^[a-f0-9]{64}$/;

function invalidBinding(): never {
  throw new Error(invalidBindingCode);
}

function isRepositoryFullName(value: unknown): value is string {
  return typeof value === "string" && repositoryFullNamePattern.test(value);
}

function isRepositoryId(value: unknown): value is string {
  return typeof value === "string" && repositoryIdPattern.test(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && shaPattern.test(value);
}

export function parseCertifiedForkReviewBinding(
  input: unknown,
): CertifiedForkReviewBinding {
  if (typeof input !== "object" || input === null) {
    invalidBinding();
  }

  if (isProxy(input)) {
    invalidBinding();
  }

  if (Array.isArray(input)) {
    invalidBinding();
  }

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidBinding();
  }

  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.length !== bindingFieldNames.length ||
    ownKeys.some((key) => typeof key !== "string") ||
    bindingFieldNames.some((fieldName) => !ownKeys.includes(fieldName))
  ) {
    invalidBinding();
  }

  const descriptors = Object.getOwnPropertyDescriptors(input);
  const values = {} as Record<BindingFieldName, unknown>;

  for (const fieldName of bindingFieldNames) {
    const descriptor = descriptors[fieldName];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      invalidBinding();
    }
    values[fieldName] = descriptor.value;
  }

  if (
    !isRepositoryFullName(values.sourceRepository) ||
    !isRepositoryId(values.sourceRepositoryId) ||
    !isRepositoryFullName(values.baseRepository) ||
    !isRepositoryId(values.baseRepositoryId) ||
    typeof values.pullRequestNumber !== "number" ||
    !Number.isSafeInteger(values.pullRequestNumber) ||
    values.pullRequestNumber <= 0 ||
    !isSha(values.reviewHeadSha) ||
    !isSha(values.baseSha) ||
    values.trustDomain !== "fork"
  ) {
    invalidBinding();
  }

  if (
    values.sourceRepositoryId === values.baseRepositoryId ||
    values.sourceRepository === values.baseRepository
  ) {
    invalidBinding();
  }

  return Object.freeze({
    sourceRepository: values.sourceRepository,
    sourceRepositoryId: values.sourceRepositoryId,
    baseRepository: values.baseRepository,
    baseRepositoryId: values.baseRepositoryId,
    pullRequestNumber: values.pullRequestNumber,
    reviewHeadSha: values.reviewHeadSha,
    baseSha: values.baseSha,
    trustDomain: values.trustDomain,
  });
}

function serializeParsedCertifiedForkReviewBinding(
  binding: CertifiedForkReviewBinding,
): string {
  return JSON.stringify({
    sourceRepository: binding.sourceRepository,
    sourceRepositoryId: binding.sourceRepositoryId,
    baseRepository: binding.baseRepository,
    baseRepositoryId: binding.baseRepositoryId,
    pullRequestNumber: binding.pullRequestNumber,
    reviewHeadSha: binding.reviewHeadSha,
    baseSha: binding.baseSha,
    trustDomain: binding.trustDomain,
  }) as string;
}

export function serializeCertifiedForkReviewBinding(binding: unknown): string {
  return serializeParsedCertifiedForkReviewBinding(
    parseCertifiedForkReviewBinding(binding),
  );
}

export function certifiedForkReviewBindingHash(binding: unknown): string {
  const parsedBinding = parseCertifiedForkReviewBinding(binding);

  return createHash("sha256")
    .update(serializeParsedCertifiedForkReviewBinding(parsedBinding), "utf8")
    .digest("hex");
}

export function assertCertifiedForkReviewBindingMatches(
  expected: unknown,
  actual: unknown,
): void {
  const parsedExpected = parseCertifiedForkReviewBinding(expected);
  const parsedActual = parseCertifiedForkReviewBinding(actual);

  for (const fieldName of bindingFieldNames) {
    if (parsedExpected[fieldName] !== parsedActual[fieldName]) {
      throw new Error(bindingMismatchCode);
    }
  }
}

export function certifiedForkReviewLeaseBindingKey(hash: unknown): string {
  if (typeof hash !== "string" || !leaseBindingHashPattern.test(hash)) {
    throw new Error(invalidLeaseBindingCode);
  }
  return `fork:${hash}`;
}
