import { sha256Canonical } from "./canonical-json";

declare const sha256Brand: unique symbol;
declare const commitShaBrand: unique symbol;
const actionRefBrand: unique symbol = Symbol("immutable-action-ref");
const verifiedActionReleaseBrand: unique symbol = Symbol(
  "verified-action-release-v2",
);
declare const verifiedCanaryReceiptBrand: unique symbol;
const workflowActionSelectionBrand: unique symbol = Symbol(
  "workflow-action-selection",
);

export type Sha256 = string & { readonly [sha256Brand]: true };
export type CommitSha = string & { readonly [commitShaBrand]: true };

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]*$/u;
const FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/u;
const SEMVER_IDENTIFIER = "(?:0|[1-9][0-9]*|[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_TAG_PATTERN = new RegExp(
  `^v(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  "u",
);

function freezeWithRuntimeBrand<T extends object>(
  value: T,
  brand: symbol,
): Readonly<T> {
  Object.defineProperty(value, brand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(value);
}

export function sha256(value: string, label = "sha256"): Sha256 {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label}_invalid`);
  return value as Sha256;
}

export function commitSha(value: string, label = "commit_sha"): CommitSha {
  if (!COMMIT_SHA_PATTERN.test(value)) throw new Error(`${label}_invalid`);
  return value as CommitSha;
}

function identifier(value: string, label: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function positiveInteger(value: number | bigint, label: string): void {
  if (
    (typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 1)) ||
    (typeof value === "bigint" && value < 1n)
  )
    throw new Error(`${label}_invalid`);
}

function timestamp(value: string, label: string): string {
  if (new Date(value).toISOString() !== value)
    throw new Error(`${label}_invalid`);
  return value;
}

export interface ActionRepositoryIdentity {
  readonly repositoryId: string;
  readonly fullName: string;
}

export function actionRepositoryIdentity(
  value: ActionRepositoryIdentity,
): Readonly<ActionRepositoryIdentity> {
  if (
    !NUMERIC_ID_PATTERN.test(value.repositoryId) ||
    !FULL_NAME_PATTERN.test(value.fullName)
  )
    throw new Error("action_repository_identity_invalid");
  return Object.freeze({
    repositoryId: value.repositoryId,
    fullName: value.fullName.toLowerCase(),
  });
}

export interface ImmutableActionRef {
  readonly repository: Readonly<ActionRepositoryIdentity>;
  readonly commitSha: CommitSha;
  readonly canonical: string;
  readonly [actionRefBrand]: true;
}

export function immutableActionRef(input: {
  readonly repository: ActionRepositoryIdentity;
  readonly commitSha: string;
}): ImmutableActionRef {
  const repository = actionRepositoryIdentity(input.repository);
  const exactCommitSha = commitSha(input.commitSha, "action_ref_commit_sha");
  return freezeWithRuntimeBrand(
    {
      repository,
      commitSha: exactCommitSha,
      canonical: `${repository.repositoryId}:${repository.fullName}@${exactCommitSha}`,
    },
    actionRefBrand,
  ) as ImmutableActionRef;
}

export function assertImmutableActionRef(
  value: ImmutableActionRef,
): ImmutableActionRef {
  const expected = immutableActionRef({
    repository: value.repository,
    commitSha: value.commitSha,
  });
  if (value[actionRefBrand] !== true || value.canonical !== expected.canonical)
    throw new Error("immutable_action_ref_invalid");
  return value;
}

/** @internal Reconstitutes a trusted persisted ref without trusting its brand. */
export function hydrateImmutableActionRef(
  value: ImmutableActionRef,
): ImmutableActionRef {
  const rebuilt = immutableActionRef({
    repository: value.repository,
    commitSha: value.commitSha,
  });
  if (value.canonical !== rebuilt.canonical)
    throw new Error("immutable_action_ref_persisted_identity_mismatch");
  return rebuilt;
}

export function sameActionRepository(
  left: ImmutableActionRef,
  right: ImmutableActionRef,
): boolean {
  return (
    left.repository.repositoryId === right.repository.repositoryId &&
    left.repository.fullName === right.repository.fullName
  );
}

export function sameActionRef(
  left: ImmutableActionRef,
  right: ImmutableActionRef,
): boolean {
  return (
    sameActionRepository(left, right) && left.commitSha === right.commitSha
  );
}

export interface ExactActionInstallerIdentity {
  readonly version: string;
  readonly url: string;
  readonly sha256: Sha256;
}

export function exactActionInstallerIdentity(
  input: ExactActionInstallerIdentity,
  actionRefInput: ImmutableActionRef,
): Readonly<ExactActionInstallerIdentity> {
  const actionRef = assertImmutableActionRef(actionRefInput);
  identifier(input.version, "action_installer_version");
  sha256(input.sha256, "action_installer_sha256");
  let installerUrl: URL;
  try {
    installerUrl = new URL(input.url);
  } catch {
    throw new Error("action_installer_url_invalid");
  }
  if (
    installerUrl.protocol !== "https:" ||
    !decodeURIComponent(installerUrl.pathname).includes(actionRef.commitSha)
  )
    throw new Error("action_installer_not_commit_bound");
  return Object.freeze({ ...input });
}

export interface ExactActionReleaseIdentityV2 {
  readonly schemaVersion: 2;
  readonly actionRef: ImmutableActionRef;
  readonly tag: string;
  readonly tagRef: Readonly<{
    objectSha: CommitSha;
    objectType: "tag" | "commit";
    peeledCommitSha: CommitSha;
  }>;
  readonly commitTreeSha: CommitSha;
  readonly actionManifest: Readonly<{
    blobSha: CommitSha;
    main: "action-dist/index.cjs";
  }>;
  readonly executable: Readonly<{
    blobOid: CommitSha;
    mode: "100644" | "100755";
    byteLength: number;
    sha256: Sha256;
  }>;
  readonly taggedSourceTreeSha256: Sha256;
  readonly buildRecipeSha256: Sha256;
  readonly lockfileSha256: Sha256;
  readonly toolchainSha256: Sha256;
  readonly dependencyInstallationSha256: Sha256;
  readonly rebuiltExecutableSha256: Sha256;
  readonly publishedBundle: Readonly<{
    artifactId: string;
    artifactSha256: Sha256;
    executableSha256: Sha256;
  }>;
  readonly release: Readonly<{
    releaseId: string;
    immutable: true;
    digest: Sha256;
  }>;
  readonly attestation: Readonly<{
    attestationId: string;
    digest: Sha256;
    subjectBundleSha256: Sha256;
  }>;
  readonly trustedWorkflow: Readonly<{
    path: string;
    ref: string;
    commitSha: CommitSha;
    runId: string;
    runAttempt: number;
  }>;
  readonly installer: Readonly<ExactActionInstallerIdentity>;
  readonly proofDigest: Sha256;
}

export type VerifiedActionReleaseV2 = ExactActionReleaseIdentityV2 & {
  readonly [verifiedActionReleaseBrand]: true;
};

export type ExactActionReleaseIdentityV2Input = Omit<
  ExactActionReleaseIdentityV2,
  | "schemaVersion"
  | "actionRef"
  | "proofDigest"
  | "tagRef"
  | "commitTreeSha"
  | "actionManifest"
  | "executable"
  | "trustedWorkflow"
> & {
  readonly repository: ActionRepositoryIdentity;
  readonly tagRef: Readonly<{
    objectSha: string;
    objectType: "tag" | "commit";
    peeledCommitSha: string;
  }>;
  readonly commitTreeSha: string;
  readonly actionManifest: Readonly<{
    blobSha: string;
    main: "action-dist/index.cjs";
  }>;
  readonly executable: Readonly<{
    blobOid: string;
    mode: "100644" | "100755";
    byteLength: number;
    sha256: Sha256;
  }>;
  readonly trustedWorkflow: Readonly<{
    path: string;
    ref: string;
    commitSha: string;
    runId: string;
    runAttempt: number;
  }>;
};

function releaseIdentityDigest(
  value: Omit<ExactActionReleaseIdentityV2, "proofDigest">,
): Sha256 {
  return sha256(`sha256:${sha256Canonical(value)}`, "release_proof_digest");
}

/**
 * The only domain constructor for the release-v2 brand. It accepts exact
 * observations but refuses to mint the brand unless all source, build,
 * publication, attestation, and installer identities agree byte-for-byte.
 * @internal The package API exposes only VerifyExactTaggedActionRelease.
 */
export function verifiedActionReleaseV2(
  input: ExactActionReleaseIdentityV2Input,
): VerifiedActionReleaseV2 {
  if (!SEMVER_TAG_PATTERN.test(input.tag))
    throw new Error("action_release_tag_invalid");
  if (input.tagRef.objectType !== "tag" && input.tagRef.objectType !== "commit")
    throw new Error("action_release_tag_object_type_invalid");
  const actionRef = immutableActionRef({
    repository: input.repository,
    commitSha: input.tagRef.peeledCommitSha,
  });
  const tagRef = Object.freeze({
    objectSha: commitSha(input.tagRef.objectSha, "action_tag_object_sha"),
    objectType: input.tagRef.objectType,
    peeledCommitSha: actionRef.commitSha,
  });
  if (
    tagRef.objectType === "commit" &&
    tagRef.objectSha !== tagRef.peeledCommitSha
  )
    throw new Error("action_release_lightweight_tag_invalid");
  const commitTree = commitSha(input.commitTreeSha, "action_commit_tree_sha");
  const actionManifest = Object.freeze({
    blobSha: commitSha(
      input.actionManifest.blobSha,
      "action_manifest_blob_sha",
    ),
    main: input.actionManifest.main,
  });
  if (actionManifest.main !== "action-dist/index.cjs")
    throw new Error("action_release_entrypoint_invalid");
  positiveInteger(input.executable.byteLength, "action_executable_byte_length");
  const executable = Object.freeze({
    blobOid: commitSha(input.executable.blobOid, "action_executable_blob_oid"),
    mode: input.executable.mode,
    byteLength: input.executable.byteLength,
    sha256: sha256(input.executable.sha256, "action_executable_sha256"),
  });
  if (executable.mode !== "100644" && executable.mode !== "100755")
    throw new Error("action_executable_mode_invalid");
  const expectedBundleDigest = executable.sha256;
  if (
    input.rebuiltExecutableSha256 !== expectedBundleDigest ||
    input.publishedBundle.executableSha256 !== expectedBundleDigest ||
    input.attestation.subjectBundleSha256 !== expectedBundleDigest
  )
    throw new Error("action_release_executable_identity_mismatch");
  for (const [label, digest] of Object.entries({
    tagged_source_tree: input.taggedSourceTreeSha256,
    build_recipe: input.buildRecipeSha256,
    lockfile: input.lockfileSha256,
    toolchain: input.toolchainSha256,
    dependency_installation: input.dependencyInstallationSha256,
    rebuilt_executable: input.rebuiltExecutableSha256,
    published_artifact: input.publishedBundle.artifactSha256,
    published_executable: input.publishedBundle.executableSha256,
    release: input.release.digest,
    attestation: input.attestation.digest,
    attested_subject: input.attestation.subjectBundleSha256,
    installer: input.installer.sha256,
  }))
    sha256(digest, `action_release_${label}_sha256`);
  if (!input.release.immutable) throw new Error("action_release_not_immutable");
  identifier(input.publishedBundle.artifactId, "action_artifact_id");
  identifier(input.release.releaseId, "action_release_id");
  identifier(input.attestation.attestationId, "action_attestation_id");
  if (
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(
      input.trustedWorkflow.path,
    ) ||
    !input.trustedWorkflow.ref.startsWith("refs/")
  )
    throw new Error("action_release_workflow_identity_invalid");
  commitSha(
    input.trustedWorkflow.commitSha,
    "action_release_workflow_commit_sha",
  );
  if (
    !NUMERIC_ID_PATTERN.test(input.trustedWorkflow.runId) ||
    !Number.isSafeInteger(input.trustedWorkflow.runAttempt) ||
    input.trustedWorkflow.runAttempt < 1
  )
    throw new Error("action_release_workflow_run_invalid");
  if (input.installer.version !== input.tag.slice(1))
    throw new Error("action_installer_version_tag_mismatch");
  const installer = exactActionInstallerIdentity(input.installer, actionRef);

  const unsigned: Omit<ExactActionReleaseIdentityV2, "proofDigest"> = {
    schemaVersion: 2,
    actionRef,
    tag: input.tag,
    tagRef,
    commitTreeSha: commitTree,
    actionManifest,
    executable,
    taggedSourceTreeSha256: input.taggedSourceTreeSha256,
    buildRecipeSha256: input.buildRecipeSha256,
    lockfileSha256: input.lockfileSha256,
    toolchainSha256: input.toolchainSha256,
    dependencyInstallationSha256: input.dependencyInstallationSha256,
    rebuiltExecutableSha256: input.rebuiltExecutableSha256,
    publishedBundle: Object.freeze({
      artifactId: input.publishedBundle.artifactId,
      artifactSha256: input.publishedBundle.artifactSha256,
      executableSha256: input.publishedBundle.executableSha256,
    }),
    release: Object.freeze({
      releaseId: input.release.releaseId,
      immutable: true as const,
      digest: input.release.digest,
    }),
    attestation: Object.freeze({
      attestationId: input.attestation.attestationId,
      digest: input.attestation.digest,
      subjectBundleSha256: input.attestation.subjectBundleSha256,
    }),
    trustedWorkflow: Object.freeze({
      ...input.trustedWorkflow,
      commitSha: commitSha(
        input.trustedWorkflow.commitSha,
        "action_release_workflow_commit_sha",
      ),
    }),
    installer,
  };
  return freezeWithRuntimeBrand(
    {
      ...unsigned,
      proofDigest: releaseIdentityDigest(unsigned),
    },
    verifiedActionReleaseBrand,
  ) as VerifiedActionReleaseV2;
}

export function assertVerifiedActionReleaseV2(
  value: VerifiedActionReleaseV2,
): VerifiedActionReleaseV2 {
  const { proofDigest, ...unsigned } = value;
  if (
    value[verifiedActionReleaseBrand] !== true ||
    releaseIdentityDigest(unsigned) !== proofDigest
  )
    throw new Error("verified_action_release_proof_digest_mismatch");
  assertImmutableActionRef(value.actionRef);
  return value;
}

/** @internal Revalidates and rebrands a trusted persisted release snapshot. */
export function hydrateVerifiedActionReleaseV2(
  value: VerifiedActionReleaseV2,
): VerifiedActionReleaseV2 {
  const persistedActionRef = hydrateImmutableActionRef(value.actionRef);
  const rebuilt = verifiedActionReleaseV2({
    repository: persistedActionRef.repository,
    tag: value.tag,
    tagRef: value.tagRef,
    commitTreeSha: value.commitTreeSha,
    actionManifest: value.actionManifest,
    executable: value.executable,
    taggedSourceTreeSha256: value.taggedSourceTreeSha256,
    buildRecipeSha256: value.buildRecipeSha256,
    lockfileSha256: value.lockfileSha256,
    toolchainSha256: value.toolchainSha256,
    dependencyInstallationSha256: value.dependencyInstallationSha256,
    rebuiltExecutableSha256: value.rebuiltExecutableSha256,
    publishedBundle: value.publishedBundle,
    release: value.release,
    attestation: value.attestation,
    trustedWorkflow: value.trustedWorkflow,
    installer: value.installer,
  });
  if (
    value.schemaVersion !== rebuilt.schemaVersion ||
    value.proofDigest !== rebuilt.proofDigest ||
    !sameActionRef(persistedActionRef, rebuilt.actionRef)
  )
    throw new Error("verified_action_release_persisted_identity_mismatch");
  return rebuilt;
}

export interface WorkflowSourceIdentity {
  readonly commitSha: CommitSha;
  readonly blobSha: CommitSha;
  readonly semanticSha256: Sha256;
}

export interface FixedCanaryTargetIdentity {
  readonly githubRepositoryId: string;
  readonly githubRepositoryNodeId: string;
  readonly repositoryFullName: string;
  readonly providerInstanceId: string;
  readonly pullRequestNumber: number;
  readonly reviewWorkflowPath: string;
  readonly interactionWorkflowPath: string;
  readonly expectedGithubAppSlug: string;
  readonly expectedGithubAppLogin: string;
}

export function fixedCanaryTargetIdentity(
  value: FixedCanaryTargetIdentity,
): Readonly<FixedCanaryTargetIdentity> {
  if (
    !NUMERIC_ID_PATTERN.test(value.githubRepositoryId) ||
    !IDENTIFIER_PATTERN.test(value.githubRepositoryNodeId) ||
    !FULL_NAME_PATTERN.test(value.repositoryFullName) ||
    !IDENTIFIER_PATTERN.test(value.providerInstanceId) ||
    !Number.isSafeInteger(value.pullRequestNumber) ||
    value.pullRequestNumber < 1 ||
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(
      value.reviewWorkflowPath,
    ) ||
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(
      value.interactionWorkflowPath,
    ) ||
    !IDENTIFIER_PATTERN.test(value.expectedGithubAppSlug) ||
    value.expectedGithubAppLogin !== `${value.expectedGithubAppSlug}[bot]`
  )
    throw new Error("fixed_canary_target_invalid");
  return Object.freeze({
    ...value,
    repositoryFullName: value.repositoryFullName.toLowerCase(),
  });
}

export interface FixedCanaryBinding {
  readonly schemaVersion: 5;
  readonly target: Readonly<FixedCanaryTargetIdentity>;
  readonly namespaceId: string;
  readonly namespaceEpoch: bigint;
  readonly challengeSha256: Sha256;
  readonly reviewedHeadSha: CommitSha;
  readonly reviewSource: Readonly<WorkflowSourceIdentity>;
  readonly interactionSource: Readonly<WorkflowSourceIdentity>;
  readonly reusableWorkflowRef: ImmutableActionRef;
  readonly runtimeRef: ImmutableActionRef;
  readonly refreshActionRef: ImmutableActionRef;
  readonly interactionRuntimeRef: ImmutableActionRef;
  readonly bindingDigest: Sha256;
}

export type FixedCanaryBindingInput = Omit<
  FixedCanaryBinding,
  | "target"
  | "bindingDigest"
  | "namespaceEpoch"
  | "challengeSha256"
  | "reviewedHeadSha"
  | "reviewSource"
  | "interactionSource"
> & {
  readonly target: FixedCanaryTargetIdentity;
  readonly namespaceEpoch: bigint;
  readonly challengeSha256: Sha256;
  readonly reviewedHeadSha: string;
  readonly reviewSource: Readonly<{
    commitSha: string;
    blobSha: string;
    semanticSha256: Sha256;
  }>;
  readonly interactionSource: Readonly<{
    commitSha: string;
    blobSha: string;
    semanticSha256: Sha256;
  }>;
};

function workflowSourceIdentity(
  value: FixedCanaryBindingInput["reviewSource"],
  label: string,
): Readonly<WorkflowSourceIdentity> {
  return Object.freeze({
    commitSha: commitSha(value.commitSha, `${label}_commit_sha`),
    blobSha: commitSha(value.blobSha, `${label}_blob_sha`),
    semanticSha256: sha256(value.semanticSha256, `${label}_semantic_sha256`),
  });
}

function canonicalFixedCanaryBinding(
  binding: Omit<FixedCanaryBinding, "bindingDigest">,
): unknown {
  const actionRef = (ref: ImmutableActionRef) => ({
    repositoryId: ref.repository.repositoryId,
    repositoryFullName: ref.repository.fullName,
    commitSha: ref.commitSha,
  });
  return {
    ...binding,
    namespaceEpoch: binding.namespaceEpoch.toString(),
    reusableWorkflowRef: actionRef(binding.reusableWorkflowRef),
    runtimeRef: actionRef(binding.runtimeRef),
    refreshActionRef: actionRef(binding.refreshActionRef),
    interactionRuntimeRef: actionRef(binding.interactionRuntimeRef),
  };
}

export function fixedCanaryBinding(
  input: FixedCanaryBindingInput,
  expectedCandidate: ImmutableActionRef,
): Readonly<FixedCanaryBinding> {
  if (input.schemaVersion !== 5)
    throw new Error("canary_schema_version_invalid");
  identifier(input.namespaceId, "canary_namespace_id");
  positiveInteger(input.namespaceEpoch, "canary_namespace_epoch");
  const refs = [
    input.reusableWorkflowRef,
    input.runtimeRef,
    input.refreshActionRef,
    input.interactionRuntimeRef,
  ];
  if (refs.some((ref) => !sameActionRef(ref, expectedCandidate)))
    throw new Error("canary_action_ref_binding_mismatch");
  const unsigned = Object.freeze({
    schemaVersion: 5 as const,
    target: fixedCanaryTargetIdentity(input.target),
    namespaceId: input.namespaceId,
    namespaceEpoch: input.namespaceEpoch,
    challengeSha256: sha256(input.challengeSha256, "canary_challenge_sha256"),
    reviewedHeadSha: commitSha(
      input.reviewedHeadSha,
      "canary_reviewed_head_sha",
    ),
    reviewSource: workflowSourceIdentity(input.reviewSource, "review_source"),
    interactionSource: workflowSourceIdentity(
      input.interactionSource,
      "interaction_source",
    ),
    reusableWorkflowRef: assertImmutableActionRef(input.reusableWorkflowRef),
    runtimeRef: assertImmutableActionRef(input.runtimeRef),
    refreshActionRef: assertImmutableActionRef(input.refreshActionRef),
    interactionRuntimeRef: assertImmutableActionRef(
      input.interactionRuntimeRef,
    ),
  });
  return Object.freeze({
    ...unsigned,
    bindingDigest: sha256(
      `sha256:${sha256Canonical(canonicalFixedCanaryBinding(unsigned))}`,
      "canary_binding_digest",
    ),
  });
}

export interface FixedTerminalCanaryExpectation {
  readonly schemaVersion: 4;
  readonly rolloutAttemptId: string;
  readonly challengeSha256: Sha256;
  readonly candidateReleaseProofDigest: Sha256;
  readonly binding: Readonly<FixedCanaryBinding>;
  readonly expectationDigest: Sha256;
}

export function fixedTerminalCanaryExpectation(input: {
  readonly rolloutAttemptId: string;
  readonly challengeSha256: Sha256;
  readonly candidateReleaseProofDigest: Sha256;
  readonly binding: Readonly<FixedCanaryBinding>;
}): Readonly<FixedTerminalCanaryExpectation> {
  identifier(input.rolloutAttemptId, "rollout_attempt_id");
  if (input.challengeSha256 !== input.binding.challengeSha256)
    throw new Error("canary_expectation_challenge_mismatch");
  const digestInput = {
    schemaVersion: 4 as const,
    rolloutAttemptId: input.rolloutAttemptId,
    challengeSha256: input.challengeSha256,
    candidateReleaseProofDigest: input.candidateReleaseProofDigest,
    binding: input.binding,
  };
  return Object.freeze({
    ...digestInput,
    expectationDigest: sha256(
      `sha256:${sha256Canonical({
        ...digestInput,
        binding: {
          ...digestInput.binding,
          namespaceEpoch: digestInput.binding.namespaceEpoch.toString(),
        },
      })}`,
      "canary_expectation_digest",
    ),
  });
}

export interface ImmutableEvidenceArtifactLocator {
  readonly artifactId: string;
  readonly artifactSha256: Sha256;
}

export function immutableEvidenceArtifactLocator(
  input: ImmutableEvidenceArtifactLocator,
): Readonly<ImmutableEvidenceArtifactLocator> {
  identifier(input.artifactId, "evidence_artifact_id");
  sha256(input.artifactSha256, "evidence_artifact_sha256");
  return Object.freeze({ ...input });
}

/** Opaque output owned and minted by the rollout-evidence-v4 verifier lane. */
export interface VerifiedFixedTerminalCanaryReceiptV4 {
  readonly schemaVersion: 4;
  readonly receiptId: string;
  readonly canonicalPayloadDigest: Sha256;
  readonly artifactId: string;
  readonly artifactSha256: Sha256;
  readonly expectationDigest: Sha256;
  readonly rolloutAttemptId: string;
  readonly candidateActionRef: ImmutableActionRef;
  readonly challengeSha256: Sha256;
  readonly runId: string;
  readonly runAttempt: number;
  readonly completedAt: string;
  readonly [verifiedCanaryReceiptBrand]: true;
}

export function assertVerifiedFixedTerminalCanaryReceiptV4(
  receipt: VerifiedFixedTerminalCanaryReceiptV4,
  expected: FixedTerminalCanaryExpectation,
): VerifiedFixedTerminalCanaryReceiptV4 {
  const candidateActionRef = assertImmutableActionRef(
    receipt.candidateActionRef,
  );
  if (
    receipt.schemaVersion !== 4 ||
    !IDENTIFIER_PATTERN.test(receipt.receiptId) ||
    !IDENTIFIER_PATTERN.test(receipt.artifactId) ||
    receipt.artifactId.length === 0 ||
    !SHA256_PATTERN.test(receipt.canonicalPayloadDigest) ||
    !SHA256_PATTERN.test(receipt.artifactSha256) ||
    receipt.expectationDigest !== expected.expectationDigest ||
    receipt.rolloutAttemptId !== expected.rolloutAttemptId ||
    receipt.challengeSha256 !== expected.challengeSha256 ||
    [
      expected.binding.reusableWorkflowRef,
      expected.binding.runtimeRef,
      expected.binding.refreshActionRef,
      expected.binding.interactionRuntimeRef,
    ].some((ref) => !sameActionRef(ref, candidateActionRef)) ||
    !NUMERIC_ID_PATTERN.test(receipt.runId) ||
    !Number.isSafeInteger(receipt.runAttempt) ||
    receipt.runAttempt < 1
  )
    throw new Error("terminal_canary_receipt_binding_invalid");
  timestamp(receipt.completedAt, "terminal_canary_receipt_completed_at");
  // The verifier lane owns the opaque evidence brand. The rollout takes an
  // immutable snapshot so a retained adapter reference cannot mutate the
  // receipt after it has entered the aggregate or changed its one-shot ID.
  return Object.freeze({
    ...receipt,
    candidateActionRef,
  }) as VerifiedFixedTerminalCanaryReceiptV4;
}

export function terminalCanaryReceiptIdentityDigest(
  receipt: VerifiedFixedTerminalCanaryReceiptV4,
): Sha256 {
  const candidateActionRef = assertImmutableActionRef(
    receipt.candidateActionRef,
  );
  return sha256(
    `sha256:${sha256Canonical({
      schemaVersion: receipt.schemaVersion,
      receiptId: receipt.receiptId,
      canonicalPayloadDigest: receipt.canonicalPayloadDigest,
      artifactId: receipt.artifactId,
      artifactSha256: receipt.artifactSha256,
      expectationDigest: receipt.expectationDigest,
      rolloutAttemptId: receipt.rolloutAttemptId,
      candidateActionRef: {
        repositoryId: candidateActionRef.repository.repositoryId,
        repositoryFullName: candidateActionRef.repository.fullName,
        commitSha: candidateActionRef.commitSha,
      },
      challengeSha256: receipt.challengeSha256,
      runId: receipt.runId,
      runAttempt: receipt.runAttempt,
      completedAt: receipt.completedAt,
    })}`,
    "terminal_canary_receipt_identity_digest",
  );
}

type WorkflowActionSelectionBrand = {
  readonly [workflowActionSelectionBrand]: true;
};

export type WorkflowActionSelection =
  | Readonly<
      WorkflowActionSelectionBrand & {
        kind: "production_primary";
        actionRef: ImmutableActionRef;
        channelVersion: bigint;
      }
    >
  | Readonly<
      WorkflowActionSelectionBrand & {
        kind: "attested_live_namespace";
        actionRef: ImmutableActionRef;
        namespaceId: string;
        namespaceEpoch: bigint;
        workflowSourceDigest: Sha256;
      }
    >
  | Readonly<
      WorkflowActionSelectionBrand & {
        kind: "isolated_candidate";
        schemaVersion: 5;
        rolloutAttemptId: string;
        policyRevision: bigint;
        actionRef: ImmutableActionRef;
        githubRepositoryId: string;
        githubRepositoryNodeId: string;
        repositoryFullName: string;
        providerInstanceId: string;
        namespaceId: string;
        namespaceEpoch: bigint;
        challengeSha256: Sha256;
        bindingDigest: Sha256;
      }
    >;

function brandedWorkflowActionSelection<T extends object>(
  input: T,
): Readonly<T & WorkflowActionSelectionBrand> {
  Object.defineProperty(input, workflowActionSelectionBrand, {
    value: true,
    enumerable: false,
  });
  return Object.freeze(input as T & WorkflowActionSelectionBrand);
}

export function assertWorkflowActionSelection(
  selection: WorkflowActionSelection,
): WorkflowActionSelection {
  if (selection[workflowActionSelectionBrand] !== true)
    throw new Error("workflow_action_selection_unbranded");
  assertImmutableActionRef(selection.actionRef);
  return selection;
}

export function productionPrimaryActionSelection(input: {
  readonly actionRef: ImmutableActionRef;
  readonly channelVersion: bigint;
}): Extract<WorkflowActionSelection, { kind: "production_primary" }> {
  if (input.channelVersion < 1n)
    throw new Error("production_action_selection_version_invalid");
  return brandedWorkflowActionSelection({
    kind: "production_primary" as const,
    actionRef: assertImmutableActionRef(input.actionRef),
    channelVersion: input.channelVersion,
  });
}

export function attestedLiveNamespaceActionSelection(input: {
  readonly actionRef: ImmutableActionRef;
  readonly namespaceId: string;
  readonly namespaceEpoch: bigint;
  readonly workflowSourceDigest: Sha256;
}): Extract<WorkflowActionSelection, { kind: "attested_live_namespace" }> {
  identifier(input.namespaceId, "attested_namespace_id");
  positiveInteger(input.namespaceEpoch, "attested_namespace_epoch");
  return brandedWorkflowActionSelection({
    kind: "attested_live_namespace" as const,
    actionRef: assertImmutableActionRef(input.actionRef),
    namespaceId: input.namespaceId,
    namespaceEpoch: input.namespaceEpoch,
    workflowSourceDigest: sha256(
      input.workflowSourceDigest,
      "attested_namespace_workflow_source_digest",
    ),
  });
}

/** @internal Candidate selections must be exposed only through the aggregate. */
export function isolatedCandidateActionSelection(input: {
  readonly rolloutAttemptId: string;
  readonly policyRevision: bigint;
  readonly candidateRelease: VerifiedActionReleaseV2;
  readonly binding: Readonly<FixedCanaryBinding>;
}): Extract<WorkflowActionSelection, { kind: "isolated_candidate" }> {
  identifier(input.rolloutAttemptId, "candidate_selection_attempt_id");
  positiveInteger(input.policyRevision, "candidate_selection_policy_revision");
  const release = assertVerifiedActionReleaseV2(input.candidateRelease);
  const binding = input.binding;
  if (
    binding.schemaVersion !== 5 ||
    [
      binding.reusableWorkflowRef,
      binding.runtimeRef,
      binding.refreshActionRef,
      binding.interactionRuntimeRef,
    ].some((ref) => !sameActionRef(ref, release.actionRef))
  )
    throw new Error("candidate_selection_binding_invalid");
  return brandedWorkflowActionSelection({
    kind: "isolated_candidate" as const,
    schemaVersion: 5 as const,
    rolloutAttemptId: input.rolloutAttemptId,
    policyRevision: input.policyRevision,
    actionRef: release.actionRef,
    githubRepositoryId: binding.target.githubRepositoryId,
    githubRepositoryNodeId: binding.target.githubRepositoryNodeId,
    repositoryFullName: binding.target.repositoryFullName,
    providerInstanceId: binding.target.providerInstanceId,
    namespaceId: binding.namespaceId,
    namespaceEpoch: binding.namespaceEpoch,
    challengeSha256: sha256(
      binding.challengeSha256,
      "candidate_selection_challenge",
    ),
    bindingDigest: sha256(
      binding.bindingDigest,
      "candidate_selection_binding_digest",
    ),
  });
}
