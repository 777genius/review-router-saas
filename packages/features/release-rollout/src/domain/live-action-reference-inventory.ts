import { sha256Canonical } from "./canonical-json";
import {
  assertImmutableActionRef,
  commitSha,
  exactActionInstallerIdentity,
  hydrateImmutableActionRef,
  sameActionRef,
  sameActionRepository,
  sha256,
  type ExactActionInstallerIdentity,
  type ImmutableActionRef,
  type Sha256,
} from "./action-release-identity";

const completeInventoryBrand: unique symbol = Symbol(
  "complete-live-action-reference-inventory-v1",
);
const predecessorRemovalBrand: unique symbol = Symbol(
  "predecessor-removal-proof",
);
const zeroPredecessorCaptureBrand: unique symbol = Symbol(
  "zero-predecessor-reference-capture",
);

export const LiveActionReferenceKind = Object.freeze({
  ActiveNamespaceWorkflow: "active_namespace_workflow",
  CompatibilitySource: "compatibility_source",
  PendingProvisioningWorkflow: "pending_provisioning_workflow",
  InFlightWorkflowRun: "in_flight_workflow_run",
  OAuthLeaseOrWriteback: "oauth_lease_or_writeback",
  HostedBindingOrGrant: "hosted_binding_or_grant",
  ReviewAuthorization: "review_authorization",
} as const);

export type LiveActionReferenceKind =
  (typeof LiveActionReferenceKind)[keyof typeof LiveActionReferenceKind];

export const LiveActionDurableSourceSchema = Object.freeze({
  CompatibilitySourceV1: "compatibility-source-v1",
  PendingProvisioningWorkflowV1: "pending-provisioning-workflow-v1",
  OAuthLeaseV1: "oauth-lease-v1",
  PendingWritebackV1: "pending-writeback-v1",
  HostedBindingV1: "hosted-binding-v1",
  InvocationGrantV1: "invocation-grant-v1",
  ReviewAuthorizationV1: "review-authorization-v1",
  ProducerReleaseV1: "producer-release-v1",
} as const);

export type LiveActionDurableSourceSchema =
  (typeof LiveActionDurableSourceSchema)[keyof typeof LiveActionDurableSourceSchema];

const DURABLE_SCHEMAS_BY_KIND: Readonly<
  Record<
    Exclude<
      LiveActionReferenceKind,
      | typeof LiveActionReferenceKind.ActiveNamespaceWorkflow
      | typeof LiveActionReferenceKind.InFlightWorkflowRun
    >,
    readonly LiveActionDurableSourceSchema[]
  >
> = Object.freeze({
  [LiveActionReferenceKind.CompatibilitySource]: Object.freeze([
    LiveActionDurableSourceSchema.CompatibilitySourceV1,
  ]),
  [LiveActionReferenceKind.PendingProvisioningWorkflow]: Object.freeze([
    LiveActionDurableSourceSchema.PendingProvisioningWorkflowV1,
  ]),
  [LiveActionReferenceKind.OAuthLeaseOrWriteback]: Object.freeze([
    LiveActionDurableSourceSchema.OAuthLeaseV1,
    LiveActionDurableSourceSchema.PendingWritebackV1,
  ]),
  [LiveActionReferenceKind.HostedBindingOrGrant]: Object.freeze([
    LiveActionDurableSourceSchema.HostedBindingV1,
    LiveActionDurableSourceSchema.InvocationGrantV1,
  ]),
  [LiveActionReferenceKind.ReviewAuthorization]: Object.freeze([
    LiveActionDurableSourceSchema.ReviewAuthorizationV1,
    LiveActionDurableSourceSchema.ProducerReleaseV1,
  ]),
});

export const LiveActionDatabaseCoverage = Object.freeze({
  ActiveNamespaceAttestations: "active_namespace_attestations",
  CompatibilitySources: "compatibility_sources",
  PendingProvisioningSources: "pending_provisioning_sources",
  OAuthLeasesAndWritebacks: "oauth_leases_and_writebacks",
  HostedBindingsAndGrants: "hosted_bindings_and_grants",
  ReviewAuthorizationsAndProducerReleases:
    "review_authorizations_and_producer_releases",
} as const);

export type LiveActionDatabaseCoverage =
  (typeof LiveActionDatabaseCoverage)[keyof typeof LiveActionDatabaseCoverage];

const COMPLETE_COVERAGE_V1 = Object.freeze(
  Object.values(LiveActionReferenceKind).sort(),
);
const COMPLETE_DATABASE_COVERAGE_V1 = Object.freeze(
  Object.values(LiveActionDatabaseCoverage).sort(),
);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/u;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]*$/u;
const FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GITHUB_APP_LOGIN_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})(?:\[bot\])?$/u;

function validTimestamp(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  )
    throw new Error(`${label}_invalid`);
  return milliseconds;
}

function identifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`${label}_invalid`);
}

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

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const exact = [...expected].sort();
  if (
    actual.length !== exact.length ||
    actual.some((key, index) => key !== exact[index])
  )
    throw new Error(`${label}_keys_invalid`);
}

function exactUniqueSorted(
  values: readonly string[],
  label: string,
): readonly string[] {
  if (values.some((value) => value.length === 0))
    throw new Error(`${label}_invalid`);
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length)
    throw new Error(`${label}_duplicate`);
  return Object.freeze(sorted);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactStringSetEquals(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function exactRefSetEquals(
  left: readonly ImmutableActionRef[],
  right: readonly ImmutableActionRef[],
): boolean {
  return exactStringSetEquals(
    left.map((ref) => ref.canonical),
    right.map((ref) => ref.canonical),
  );
}

function sameInstallerIdentity(
  left: ExactActionInstallerIdentity,
  right: ExactActionInstallerIdentity,
): boolean {
  return (
    left.version === right.version &&
    left.url === right.url &&
    left.sha256 === right.sha256
  );
}

interface LiveActionReferenceBase {
  readonly kind: LiveActionReferenceKind;
  readonly holderId: string;
  readonly actionRef: ImmutableActionRef;
  /** Numeric identity of the repository holding the reference. */
  readonly githubRepositoryId: string;
  readonly repositoryFullName: string;
  /** Exact source/workflow/lease/binding identity resolved by the adapter. */
  readonly sourceIdentityDigest: Sha256;
}

export type LiveActionReference =
  | (LiveActionReferenceBase & {
      readonly kind: typeof LiveActionReferenceKind.ActiveNamespaceWorkflow;
      readonly details: Readonly<{
        kind: "active_namespace";
        namespaceId: string;
        namespaceEpoch: bigint;
        workflowCommitSha: string;
        workflowBlobSha: string;
        workflowSemanticSha256: Sha256;
      }>;
    })
  | (LiveActionReferenceBase & {
      readonly kind: typeof LiveActionReferenceKind.InFlightWorkflowRun;
      readonly details: Readonly<{
        kind: "workflow_run";
        workflowPath: string;
        status: "queued" | "in_progress";
        runId: string;
        runAttempt: number;
        workflowCommitSha: string;
        workflowBlobSha: string;
        workflowSemanticSha256: Sha256;
      }>;
    })
  | (LiveActionReferenceBase & {
      readonly kind: Exclude<
        LiveActionReferenceKind,
        | typeof LiveActionReferenceKind.ActiveNamespaceWorkflow
        | typeof LiveActionReferenceKind.InFlightWorkflowRun
      >;
      readonly details: Readonly<{
        kind: "durable_reference";
        sourceSchema: LiveActionDurableSourceSchema;
        expiresAt: string | null;
      }>;
    });

export interface LiveActionReferenceInventoryCaptureV1 {
  readonly schemaVersion: 1;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly coverageVersion: 1;
  readonly coveredReferenceKinds: readonly LiveActionReferenceKind[];
  readonly unresolvedSources: readonly string[];
  readonly repositoryCohort: Readonly<{
    revision: bigint;
    githubRepositoryIds: readonly string[];
    digest: Sha256;
  }>;
  readonly policyRevision: bigint;
  readonly database: Readonly<{
    complete: boolean;
    serverTime: string;
    snapshotIdentity: string;
    coveredScopes: readonly LiveActionDatabaseCoverage[];
    coveredTables: readonly string[];
    rowCounts: Readonly<Record<string, number>>;
    digest: Sha256;
  }>;
  readonly github: Readonly<{
    complete: boolean;
    appId: string;
    appLogin: string;
    /** Provider-issued observation boundary for every page in this snapshot. */
    providerObservedAt: string;
    /** Immutable provider snapshot shared by every page in this capture. */
    snapshotIdentity: string;
    workflows: readonly string[];
    statuses: readonly ("queued" | "in_progress")[];
    pages: readonly Readonly<{
      repositoryId: string;
      workflow: string;
      status: "queued" | "in_progress";
      page: number;
      providerObservedAt: string;
      snapshotIdentity: string;
      responseDigest: Sha256;
      nextPage: number | null;
    }>[];
    paginationComplete: boolean;
    digest: Sha256;
  }>;
  readonly production: Readonly<{
    complete: boolean;
    serviceIds: readonly string[];
    deploymentIds: readonly string[];
    primaryRef: ImmutableActionRef;
    installerRef: ImmutableActionRef;
    reusableWorkflowRef: ImmutableActionRef;
    runtimeRef: ImmutableActionRef;
    refreshActionRef: ImmutableActionRef;
    interactionRuntimeRef: ImmutableActionRef;
    installer: Readonly<ExactActionInstallerIdentity>;
    allowlistedRefs: readonly ImmutableActionRef[];
    consensusDigest: Sha256;
  }>;
  readonly references: readonly LiveActionReference[];
  readonly capturedAt: string;
  readonly maximumQueueLeaseWindowMs: number;
}

export interface CompleteLiveActionReferenceInventoryV1 extends LiveActionReferenceInventoryCaptureV1 {
  readonly completeness: "complete";
  readonly inventoryDigest: Sha256;
  readonly [completeInventoryBrand]: true;
}

function canonicalActionRef(ref: ImmutableActionRef): Readonly<{
  repositoryId: string;
  repositoryFullName: string;
  commitSha: string;
}> {
  return {
    repositoryId: ref.repository.repositoryId,
    repositoryFullName: ref.repository.fullName,
    commitSha: ref.commitSha,
  };
}

function canonicalInventory(
  value: Omit<
    CompleteLiveActionReferenceInventoryV1,
    "inventoryDigest" | typeof completeInventoryBrand
  >,
): unknown {
  return {
    ...value,
    repositoryCohort: {
      ...value.repositoryCohort,
      revision: value.repositoryCohort.revision.toString(),
    },
    policyRevision: value.policyRevision.toString(),
    production: {
      ...value.production,
      primaryRef: canonicalActionRef(value.production.primaryRef),
      installerRef: canonicalActionRef(value.production.installerRef),
      reusableWorkflowRef: canonicalActionRef(
        value.production.reusableWorkflowRef,
      ),
      runtimeRef: canonicalActionRef(value.production.runtimeRef),
      refreshActionRef: canonicalActionRef(value.production.refreshActionRef),
      interactionRuntimeRef: canonicalActionRef(
        value.production.interactionRuntimeRef,
      ),
      allowlistedRefs: value.production.allowlistedRefs.map(canonicalActionRef),
    },
    references: value.references.map((reference) => ({
      ...reference,
      actionRef: canonicalActionRef(reference.actionRef),
      details:
        reference.kind === LiveActionReferenceKind.ActiveNamespaceWorkflow
          ? {
              ...reference.details,
              namespaceEpoch: reference.details.namespaceEpoch.toString(),
            }
          : reference.details,
    })),
  };
}

export function productionActionConfigurationConsensusDigest(input: {
  readonly serviceIds: readonly string[];
  readonly deploymentIds: readonly string[];
  readonly primaryRef: ImmutableActionRef;
  readonly installerRef: ImmutableActionRef;
  readonly reusableWorkflowRef: ImmutableActionRef;
  readonly runtimeRef: ImmutableActionRef;
  readonly refreshActionRef: ImmutableActionRef;
  readonly interactionRuntimeRef: ImmutableActionRef;
  readonly installer: Readonly<ExactActionInstallerIdentity>;
  readonly allowlistedRefs: readonly ImmutableActionRef[];
}): Sha256 {
  const allowlistedRefs = [...input.allowlistedRefs].sort((left, right) =>
    codeUnitCompare(left.canonical, right.canonical),
  );
  return sha256(
    `sha256:${sha256Canonical({
      serviceIds: [...input.serviceIds].sort(),
      deploymentIds: [...input.deploymentIds].sort(),
      primaryRef: canonicalActionRef(input.primaryRef),
      installerRef: canonicalActionRef(input.installerRef),
      reusableWorkflowRef: canonicalActionRef(input.reusableWorkflowRef),
      runtimeRef: canonicalActionRef(input.runtimeRef),
      refreshActionRef: canonicalActionRef(input.refreshActionRef),
      interactionRuntimeRef: canonicalActionRef(input.interactionRuntimeRef),
      installer: {
        version: input.installer.version,
        url: input.installer.url,
        sha256: input.installer.sha256,
      },
      allowlistedRefs: allowlistedRefs.map(canonicalActionRef),
    })}`,
    "inventory_production_consensus_digest",
  );
}

/**
 * Brands only a fully enumerated, provider-consistent capture. Adapters may
 * report partial/unknown observations to this boundary, but those can never
 * escape as a CompleteLiveActionReferenceInventoryV1.
 */
export function completeLiveActionReferenceInventory(
  input: LiveActionReferenceInventoryCaptureV1,
): CompleteLiveActionReferenceInventoryV1 {
  assertExactKeys(
    input,
    [
      "schemaVersion",
      "completeness",
      "coverageVersion",
      "coveredReferenceKinds",
      "unresolvedSources",
      "repositoryCohort",
      "policyRevision",
      "database",
      "github",
      "production",
      "references",
      "capturedAt",
      "maximumQueueLeaseWindowMs",
    ],
    "live_action_reference_inventory",
  );
  assertExactKeys(
    input.repositoryCohort,
    ["revision", "githubRepositoryIds", "digest"],
    "inventory_repository_cohort",
  );
  assertExactKeys(
    input.database,
    [
      "complete",
      "serverTime",
      "snapshotIdentity",
      "coveredScopes",
      "coveredTables",
      "rowCounts",
      "digest",
    ],
    "inventory_database",
  );
  assertExactKeys(
    input.github,
    [
      "complete",
      "appId",
      "appLogin",
      "providerObservedAt",
      "snapshotIdentity",
      "workflows",
      "statuses",
      "pages",
      "paginationComplete",
      "digest",
    ],
    "inventory_github",
  );
  assertExactKeys(
    input.production,
    [
      "complete",
      "serviceIds",
      "deploymentIds",
      "primaryRef",
      "installerRef",
      "reusableWorkflowRef",
      "runtimeRef",
      "refreshActionRef",
      "interactionRuntimeRef",
      "installer",
      "allowlistedRefs",
      "consensusDigest",
    ],
    "inventory_production",
  );
  assertExactKeys(
    input.production.installer,
    ["version", "url", "sha256"],
    "inventory_production_installer",
  );
  if (
    input.schemaVersion !== 1 ||
    input.coverageVersion !== 1 ||
    input.completeness !== "complete" ||
    input.unresolvedSources.length !== 0 ||
    !input.database.complete ||
    !input.github.complete ||
    !input.github.paginationComplete ||
    !input.production.complete
  )
    throw new Error("live_action_reference_inventory_incomplete");
  const coverage = [...input.coveredReferenceKinds].sort();
  if (
    coverage.length !== COMPLETE_COVERAGE_V1.length ||
    coverage.some((kind, index) => kind !== COMPLETE_COVERAGE_V1[index])
  )
    throw new Error("live_action_reference_inventory_coverage_incomplete");
  if (input.repositoryCohort.revision < 1n || input.policyRevision < 1n)
    throw new Error("live_action_reference_inventory_revision_invalid");
  const repositoryIds = exactUniqueSorted(
    input.repositoryCohort.githubRepositoryIds,
    "live_action_reference_repository_id",
  );
  if (
    repositoryIds.length === 0 ||
    repositoryIds.some((repositoryId) => !NUMERIC_ID_PATTERN.test(repositoryId))
  )
    throw new Error("live_action_reference_repository_cohort_invalid");
  sha256(input.repositoryCohort.digest, "repository_cohort_digest");
  validTimestamp(input.database.serverTime, "inventory_database_server_time");
  identifier(input.database.snapshotIdentity, "inventory_snapshot_identity");
  const coveredScopes = [...input.database.coveredScopes].sort();
  if (
    coveredScopes.length !== COMPLETE_DATABASE_COVERAGE_V1.length ||
    coveredScopes.some(
      (scope, index) => scope !== COMPLETE_DATABASE_COVERAGE_V1[index],
    )
  )
    throw new Error("inventory_database_coverage_incomplete");
  const coveredTables = exactUniqueSorted(
    input.database.coveredTables,
    "inventory_covered_table",
  );
  if (coveredTables.length === 0)
    throw new Error("inventory_covered_tables_empty");
  const rowCountKeys = Object.keys(input.database.rowCounts).sort();
  if (
    rowCountKeys.length !== coveredTables.length ||
    rowCountKeys.some((table, index) => table !== coveredTables[index]) ||
    Object.values(input.database.rowCounts).some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    )
  )
    throw new Error("inventory_row_counts_invalid");
  sha256(input.database.digest, "inventory_database_digest");
  if (!NUMERIC_ID_PATTERN.test(input.github.appId))
    throw new Error("inventory_github_app_id_invalid");
  if (!GITHUB_APP_LOGIN_PATTERN.test(input.github.appLogin))
    throw new Error("inventory_github_app_login_invalid");
  const githubProviderObservedAt = validTimestamp(
    input.github.providerObservedAt,
    "inventory_github_provider_observed_at",
  );
  identifier(
    input.github.snapshotIdentity,
    "inventory_github_snapshot_identity",
  );
  const workflows = exactUniqueSorted(
    input.github.workflows,
    "inventory_github_workflow",
  );
  const statuses = exactUniqueSorted(
    input.github.statuses,
    "inventory_github_status",
  ) as readonly ("queued" | "in_progress")[];
  if (
    workflows.length === 0 ||
    workflows.some(
      (workflow) =>
        !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(workflow),
    ) ||
    statuses.length !== 2 ||
    statuses[0] !== "in_progress" ||
    statuses[1] !== "queued" ||
    input.github.pages.length === 0
  )
    throw new Error("inventory_github_scope_incomplete");
  const pageKeys = new Set<string>();
  for (const page of input.github.pages) {
    assertExactKeys(
      page,
      [
        "repositoryId",
        "workflow",
        "status",
        "page",
        "providerObservedAt",
        "snapshotIdentity",
        "responseDigest",
        "nextPage",
      ],
      "inventory_github_page",
    );
    if (
      !repositoryIds.includes(page.repositoryId) ||
      !workflows.includes(page.workflow) ||
      !statuses.includes(page.status) ||
      !Number.isSafeInteger(page.page) ||
      page.page < 1 ||
      page.snapshotIdentity !== input.github.snapshotIdentity ||
      page.providerObservedAt !== input.github.providerObservedAt ||
      (page.nextPage !== null &&
        (!Number.isSafeInteger(page.nextPage) ||
          page.nextPage !== page.page + 1))
    )
      throw new Error("inventory_github_page_invalid");
    validTimestamp(
      page.providerObservedAt,
      "inventory_github_page_provider_observed_at",
    );
    sha256(page.responseDigest, "inventory_github_page_digest");
    const key = `${page.repositoryId}:${page.workflow}:${page.status}:${page.page}`;
    if (pageKeys.has(key)) throw new Error("inventory_github_page_duplicate");
    pageKeys.add(key);
  }
  for (const repositoryId of repositoryIds)
    for (const workflow of workflows)
      for (const status of statuses) {
        const pages = input.github.pages
          .filter(
            (page) =>
              page.repositoryId === repositoryId &&
              page.workflow === workflow &&
              page.status === status,
          )
          .sort((left, right) => left.page - right.page);
        if (
          pages.length === 0 ||
          pages[0]?.page !== 1 ||
          pages.at(-1)?.nextPage !== null ||
          pages.some(
            (page, index) =>
              index < pages.length - 1 &&
              page.nextPage !== pages[index + 1]?.page,
          )
        )
          throw new Error("inventory_github_pagination_incomplete");
      }
  sha256(input.github.digest, "inventory_github_digest");
  const serviceIds = exactUniqueSorted(
    input.production.serviceIds,
    "inventory_production_service_id",
  );
  const deploymentIds = exactUniqueSorted(
    input.production.deploymentIds,
    "inventory_production_deployment_id",
  );
  if (serviceIds.length === 0 || serviceIds.length !== deploymentIds.length)
    throw new Error("inventory_production_service_scope_invalid");
  const productionRefs = [
    input.production.primaryRef,
    input.production.installerRef,
    input.production.reusableWorkflowRef,
    input.production.runtimeRef,
    input.production.refreshActionRef,
    input.production.interactionRuntimeRef,
  ].map(assertImmutableActionRef);
  const installer = exactActionInstallerIdentity(
    input.production.installer,
    productionRefs[1]!,
  );
  const allowlistedRefs = input.production.allowlistedRefs
    .map(assertImmutableActionRef)
    .sort((left, right) => codeUnitCompare(left.canonical, right.canonical));
  if (
    new Set(allowlistedRefs.map((ref) => ref.canonical)).size !==
    allowlistedRefs.length
  )
    throw new Error("inventory_allowlisted_ref_duplicate");
  if (
    [...productionRefs, ...allowlistedRefs].some(
      (ref) => !sameActionRepository(productionRefs[0]!, ref),
    )
  )
    throw new Error("inventory_action_repository_mismatch");
  const expectedProductionConsensus =
    productionActionConfigurationConsensusDigest({
      serviceIds,
      deploymentIds,
      primaryRef: productionRefs[0]!,
      installerRef: productionRefs[1]!,
      reusableWorkflowRef: productionRefs[2]!,
      runtimeRef: productionRefs[3]!,
      refreshActionRef: productionRefs[4]!,
      interactionRuntimeRef: productionRefs[5]!,
      installer,
      allowlistedRefs,
    });
  if (input.production.consensusDigest !== expectedProductionConsensus)
    throw new Error("inventory_production_consensus_mismatch");
  const repositoryNames = new Map<string, string>();
  const references = input.references
    .map((reference) => {
      assertExactKeys(
        reference,
        [
          "kind",
          "holderId",
          "actionRef",
          "githubRepositoryId",
          "repositoryFullName",
          "sourceIdentityDigest",
          "details",
        ],
        "live_action_reference",
      );
      if (
        !Object.values(LiveActionReferenceKind).includes(reference.kind) ||
        !NUMERIC_ID_PATTERN.test(reference.githubRepositoryId) ||
        !repositoryIds.includes(reference.githubRepositoryId) ||
        !FULL_NAME_PATTERN.test(reference.repositoryFullName)
      )
        throw new Error("live_action_reference_invalid");
      const normalizedRepositoryName =
        reference.repositoryFullName.toLowerCase();
      const priorRepositoryName = repositoryNames.get(
        reference.githubRepositoryId,
      );
      if (
        priorRepositoryName !== undefined &&
        priorRepositoryName !== normalizedRepositoryName
      )
        throw new Error("live_action_reference_repository_identity_divergent");
      repositoryNames.set(
        reference.githubRepositoryId,
        normalizedRepositoryName,
      );
      identifier(reference.holderId, "live_action_reference_holder_id");
      assertImmutableActionRef(reference.actionRef);
      if (!sameActionRepository(productionRefs[0]!, reference.actionRef))
        throw new Error("inventory_action_repository_mismatch");
      sha256(
        reference.sourceIdentityDigest,
        "live_action_reference_source_identity_digest",
      );
      if (reference.kind === LiveActionReferenceKind.ActiveNamespaceWorkflow) {
        assertExactKeys(
          reference.details,
          [
            "kind",
            "namespaceId",
            "namespaceEpoch",
            "workflowCommitSha",
            "workflowBlobSha",
            "workflowSemanticSha256",
          ],
          "live_action_namespace_reference",
        );
        if (
          reference.details.kind !== "active_namespace" ||
          reference.details.namespaceEpoch < 1n
        )
          throw new Error("live_action_namespace_reference_invalid");
        identifier(reference.details.namespaceId, "live_action_namespace_id");
        commitSha(
          reference.details.workflowCommitSha,
          "live_action_namespace_workflow_commit",
        );
        commitSha(
          reference.details.workflowBlobSha,
          "live_action_namespace_workflow_blob",
        );
        sha256(
          reference.details.workflowSemanticSha256,
          "live_action_namespace_workflow_semantic",
        );
      } else if (
        reference.kind === LiveActionReferenceKind.InFlightWorkflowRun
      ) {
        assertExactKeys(
          reference.details,
          [
            "kind",
            "workflowPath",
            "status",
            "runId",
            "runAttempt",
            "workflowCommitSha",
            "workflowBlobSha",
            "workflowSemanticSha256",
          ],
          "live_action_workflow_run_reference",
        );
        if (
          reference.details.kind !== "workflow_run" ||
          !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(
            reference.details.workflowPath,
          ) ||
          !workflows.includes(reference.details.workflowPath) ||
          !statuses.includes(reference.details.status) ||
          !NUMERIC_ID_PATTERN.test(reference.details.runId) ||
          !Number.isSafeInteger(reference.details.runAttempt) ||
          reference.details.runAttempt < 1
        )
          throw new Error("live_action_workflow_run_reference_invalid");
        commitSha(
          reference.details.workflowCommitSha,
          "live_action_run_workflow_commit",
        );
        commitSha(
          reference.details.workflowBlobSha,
          "live_action_run_workflow_blob",
        );
        sha256(
          reference.details.workflowSemanticSha256,
          "live_action_run_workflow_semantic",
        );
      } else {
        assertExactKeys(
          reference.details,
          ["kind", "sourceSchema", "expiresAt"],
          "live_action_durable_reference",
        );
        if (reference.details.kind !== "durable_reference")
          throw new Error("live_action_durable_reference_invalid");
        if (
          !DURABLE_SCHEMAS_BY_KIND[reference.kind].includes(
            reference.details.sourceSchema,
          )
        )
          throw new Error("live_action_durable_source_schema_unknown");
        if (reference.details.expiresAt !== null)
          validTimestamp(
            reference.details.expiresAt,
            "live_action_durable_expiry",
          );
      }
      return Object.freeze({
        ...reference,
        repositoryFullName: normalizedRepositoryName,
        details: Object.freeze({ ...reference.details }),
      }) as unknown as LiveActionReference;
    })
    .sort((left, right) =>
      codeUnitCompare(
        `${left.kind}:${left.holderId}`,
        `${right.kind}:${right.holderId}`,
      ),
    );
  if (
    new Set(
      references.map((reference) => `${reference.kind}:${reference.holderId}`),
    ).size !== references.length
  )
    throw new Error("live_action_reference_holder_duplicate");
  const capturedAt = validTimestamp(input.capturedAt, "inventory_capture_time");
  if (
    validTimestamp(
      input.database.serverTime,
      "inventory_database_server_time",
    ) > capturedAt
  )
    throw new Error("inventory_database_snapshot_after_capture");
  if (
    githubProviderObservedAt > capturedAt ||
    input.github.pages.some(
      (page) =>
        validTimestamp(
          page.providerObservedAt,
          "inventory_github_page_provider_observed_at",
        ) > capturedAt,
    )
  )
    throw new Error("inventory_github_snapshot_after_capture");
  if (
    !Number.isSafeInteger(input.maximumQueueLeaseWindowMs) ||
    input.maximumQueueLeaseWindowMs < 1
  )
    throw new Error("inventory_queue_lease_window_invalid");

  const unsigned = Object.freeze({
    ...input,
    completeness: "complete" as const,
    coveredReferenceKinds: Object.freeze(coverage),
    unresolvedSources: Object.freeze([]),
    repositoryCohort: Object.freeze({
      ...input.repositoryCohort,
      githubRepositoryIds: repositoryIds,
    }),
    database: Object.freeze({
      ...input.database,
      coveredScopes: Object.freeze(coveredScopes),
      coveredTables,
      rowCounts: Object.freeze(
        Object.fromEntries(
          rowCountKeys.map((table) => [
            table,
            input.database.rowCounts[table]!,
          ]),
        ),
      ),
    }),
    github: Object.freeze({
      ...input.github,
      workflows,
      statuses,
      pages: Object.freeze(
        input.github.pages
          .map((page) => Object.freeze({ ...page }))
          .sort((left, right) =>
            codeUnitCompare(
              `${left.repositoryId}:${left.workflow}:${left.status}:${left.page}`,
              `${right.repositoryId}:${right.workflow}:${right.status}:${right.page}`,
            ),
          ),
      ),
    }),
    production: Object.freeze({
      ...input.production,
      serviceIds,
      deploymentIds,
      primaryRef: productionRefs[0]!,
      installerRef: productionRefs[1]!,
      reusableWorkflowRef: productionRefs[2]!,
      runtimeRef: productionRefs[3]!,
      refreshActionRef: productionRefs[4]!,
      interactionRuntimeRef: productionRefs[5]!,
      installer,
      allowlistedRefs: Object.freeze(allowlistedRefs),
      consensusDigest: expectedProductionConsensus,
    }),
    references: Object.freeze(references),
  });
  return freezeWithRuntimeBrand(
    {
      ...unsigned,
      inventoryDigest: sha256(
        `sha256:${sha256Canonical(canonicalInventory(unsigned))}`,
        "live_action_reference_inventory_digest",
      ),
    },
    completeInventoryBrand,
  ) as unknown as CompleteLiveActionReferenceInventoryV1;
}

export function assertCompleteLiveActionReferenceInventory(
  inventory: CompleteLiveActionReferenceInventoryV1,
): CompleteLiveActionReferenceInventoryV1 {
  const { inventoryDigest, ...unsigned } = inventory;
  const expected = sha256(
    `sha256:${sha256Canonical(canonicalInventory(unsigned))}`,
    "live_action_reference_inventory_digest",
  );
  if (
    inventory[completeInventoryBrand] !== true ||
    inventoryDigest !== expected
  )
    throw new Error("live_action_reference_inventory_digest_mismatch");
  return inventory;
}

function completeInventoryScopeDigest(
  inventory: CompleteLiveActionReferenceInventoryV1,
): Sha256 {
  return sha256(
    `sha256:${sha256Canonical({
      schemaVersion: inventory.schemaVersion,
      coverageVersion: inventory.coverageVersion,
      coveredReferenceKinds: inventory.coveredReferenceKinds,
      repositoryCohort: {
        revision: inventory.repositoryCohort.revision.toString(),
        githubRepositoryIds: inventory.repositoryCohort.githubRepositoryIds,
        digest: inventory.repositoryCohort.digest,
      },
      policyRevision: inventory.policyRevision.toString(),
      database: {
        coveredScopes: inventory.database.coveredScopes,
        coveredTables: inventory.database.coveredTables,
      },
      github: {
        appId: inventory.github.appId,
        appLogin: inventory.github.appLogin,
        workflows: inventory.github.workflows,
        statuses: inventory.github.statuses,
      },
      production: {
        serviceIds: inventory.production.serviceIds,
      },
      maximumQueueLeaseWindowMs: inventory.maximumQueueLeaseWindowMs,
    })}`,
    "live_action_reference_inventory_scope_digest",
  );
}

/** Exact enumeration scope that must remain stable across drain captures. */
export function liveActionReferenceInventoryScopeDigest(
  inventory: CompleteLiveActionReferenceInventoryV1,
): Sha256 {
  return completeInventoryScopeDigest(
    assertCompleteLiveActionReferenceInventory(inventory),
  );
}

export function inventoryReferencesAction(
  inventory: CompleteLiveActionReferenceInventoryV1,
  actionRef: ImmutableActionRef,
): boolean {
  assertCompleteLiveActionReferenceInventory(inventory);
  return inventory.references.some((reference) =>
    sameActionRef(reference.actionRef, actionRef),
  );
}

export function exactInventoryActionRefs(
  inventory: CompleteLiveActionReferenceInventoryV1,
): readonly ImmutableActionRef[] {
  assertCompleteLiveActionReferenceInventory(inventory);
  const byCanonical = new Map<string, ImmutableActionRef>();
  for (const reference of inventory.references)
    byCanonical.set(reference.actionRef.canonical, reference.actionRef);
  return Object.freeze(
    [...byCanonical.values()].sort((left, right) =>
      codeUnitCompare(left.canonical, right.canonical),
    ),
  );
}

export interface PredecessorAdmissionFence {
  readonly fenceId: string;
  readonly epoch: bigint;
  readonly predecessorRef: ImmutableActionRef;
  readonly repositoryCohortRevision: bigint;
  readonly repositoryCohortDigest: Sha256;
  readonly githubRepositoryIds: readonly string[];
  readonly policyRevision: bigint;
  readonly inventoryScopeDigest: Sha256;
  readonly requiredWindowMs: number;
  readonly authorityEstablishedAt: string;
  readonly closedAt: string;
}

export function predecessorAdmissionFence(
  input: PredecessorAdmissionFence,
): Readonly<PredecessorAdmissionFence> {
  identifier(input.fenceId, "predecessor_admission_fence_id");
  if (
    input.epoch < 1n ||
    input.repositoryCohortRevision < 1n ||
    input.policyRevision < 1n
  )
    throw new Error("predecessor_admission_fence_revision_invalid");
  assertImmutableActionRef(input.predecessorRef);
  sha256(input.repositoryCohortDigest, "predecessor_fence_cohort_digest");
  sha256(
    input.inventoryScopeDigest,
    "predecessor_fence_inventory_scope_digest",
  );
  const githubRepositoryIds = exactUniqueSorted(
    input.githubRepositoryIds,
    "predecessor_fence_repository_id",
  );
  if (
    githubRepositoryIds.length === 0 ||
    githubRepositoryIds.some(
      (repositoryId) => !NUMERIC_ID_PATTERN.test(repositoryId),
    )
  )
    throw new Error("predecessor_admission_fence_cohort_invalid");
  const authorityEstablishedAt = validTimestamp(
    input.authorityEstablishedAt,
    "predecessor_authority_established_time",
  );
  const closedAt = validTimestamp(
    input.closedAt,
    "predecessor_admission_fence_time",
  );
  if (
    !Number.isSafeInteger(input.requiredWindowMs) ||
    input.requiredWindowMs < 1 ||
    closedAt < authorityEstablishedAt
  )
    throw new Error("predecessor_admission_fence_window_invalid");
  return Object.freeze({ ...input, githubRepositoryIds });
}

export interface ZeroPredecessorReferenceCapture {
  readonly fenceId: string;
  readonly fenceEpoch: bigint;
  readonly inventoryDigest: Sha256;
  readonly captureDigest: Sha256;
  readonly capturedAt: string;
  readonly databaseSnapshotIdentity: string;
  readonly databaseServerTime: string;
  readonly githubSnapshotIdentity: string;
  readonly githubProviderObservedAt: string;
  readonly successorRef: ImmutableActionRef;
  readonly repositoryCohortRevision: bigint;
  readonly repositoryCohortDigest: Sha256;
  readonly githubRepositoryIds: readonly string[];
  readonly policyRevision: bigint;
  readonly inventoryScopeDigest: Sha256;
  readonly exactRefs: readonly ImmutableActionRef[];
  readonly productionServiceIds: readonly string[];
  readonly productionDeploymentIds: readonly string[];
  readonly productionConsensusDigest: Sha256;
  readonly productionInstaller: Readonly<ExactActionInstallerIdentity>;
  readonly maximumQueueLeaseWindowMs: number;
  readonly requiredWindowMs: number;
  readonly [zeroPredecessorCaptureBrand]: true;
}

function zeroPredecessorCaptureDigest(
  capture: Omit<
    ZeroPredecessorReferenceCapture,
    "captureDigest" | typeof zeroPredecessorCaptureBrand
  >,
): Sha256 {
  return sha256(
    `sha256:${sha256Canonical({
      ...capture,
      fenceEpoch: capture.fenceEpoch.toString(),
      repositoryCohortRevision: capture.repositoryCohortRevision.toString(),
      policyRevision: capture.policyRevision.toString(),
      successorRef: canonicalActionRef(capture.successorRef),
      exactRefs: capture.exactRefs.map(canonicalActionRef),
    })}`,
    "predecessor_zero_capture_digest",
  );
}

export function zeroPredecessorReferenceCapture(input: {
  readonly inventory: CompleteLiveActionReferenceInventoryV1;
  readonly predecessorRef: ImmutableActionRef;
  readonly successorRef: ImmutableActionRef;
  readonly additionalTrustedRefs?: readonly ImmutableActionRef[];
  readonly expectedInstaller: Readonly<ExactActionInstallerIdentity>;
  readonly expectedServiceIds: readonly string[];
  readonly fence: PredecessorAdmissionFence;
  readonly observedNow: string;
  readonly maximumCaptureAgeMs: number;
}): Readonly<ZeroPredecessorReferenceCapture> | null {
  const inventory = assertCompleteLiveActionReferenceInventory(input.inventory);
  const fence = predecessorAdmissionFence(input.fence);
  const capturedAt = validTimestamp(
    inventory.capturedAt,
    "inventory_capture_time",
  );
  const now = validTimestamp(input.observedNow, "inventory_observation_time");
  const closedAt = validTimestamp(fence.closedAt, "predecessor_fence_time");
  const databaseServerTime = validTimestamp(
    inventory.database.serverTime,
    "predecessor_database_snapshot_time",
  );
  const githubProviderObservedAt = validTimestamp(
    inventory.github.providerObservedAt,
    "predecessor_github_provider_observation_time",
  );
  const inventoryScopeDigest = completeInventoryScopeDigest(inventory);
  if (
    !Number.isSafeInteger(input.maximumCaptureAgeMs) ||
    input.maximumCaptureAgeMs < 1 ||
    capturedAt < closedAt ||
    databaseServerTime < closedAt ||
    githubProviderObservedAt < closedAt ||
    capturedAt > now ||
    now - capturedAt > input.maximumCaptureAgeMs ||
    now - databaseServerTime > input.maximumCaptureAgeMs ||
    now - githubProviderObservedAt > input.maximumCaptureAgeMs
  )
    throw new Error("predecessor_inventory_capture_stale");
  if (
    !sameActionRef(fence.predecessorRef, input.predecessorRef) ||
    inventory.repositoryCohort.revision !== fence.repositoryCohortRevision ||
    inventory.repositoryCohort.digest !== fence.repositoryCohortDigest ||
    inventory.repositoryCohort.githubRepositoryIds.join("\n") !==
      fence.githubRepositoryIds.join("\n") ||
    inventory.policyRevision !== fence.policyRevision ||
    inventoryScopeDigest !== fence.inventoryScopeDigest
  )
    throw new Error("predecessor_inventory_fence_binding_mismatch");
  const successorRef = assertImmutableActionRef(input.successorRef);
  const expectedInstaller = exactActionInstallerIdentity(
    input.expectedInstaller,
    successorRef,
  );
  const additionalTrustedRefs = (input.additionalTrustedRefs ?? []).map(
    assertImmutableActionRef,
  );
  if (
    additionalTrustedRefs.some(
      (ref) => !sameActionRepository(ref, successorRef),
    )
  )
    throw new Error("predecessor_inventory_trusted_ref_mismatch");
  const productionRefs = [
    inventory.production.primaryRef,
    inventory.production.installerRef,
    inventory.production.reusableWorkflowRef,
    inventory.production.runtimeRef,
    inventory.production.refreshActionRef,
    inventory.production.interactionRuntimeRef,
  ];
  const expectedAllowlistedRefs = [
    ...new Map(
      [
        successorRef,
        input.predecessorRef,
        ...additionalTrustedRefs,
        ...exactInventoryActionRefs(inventory),
      ].map((ref) => [ref.canonical, ref]),
    ).values(),
  ];
  if (
    sameActionRef(successorRef, input.predecessorRef) ||
    !sameActionRepository(successorRef, input.predecessorRef) ||
    productionRefs.some((ref) => !sameActionRef(ref, successorRef)) ||
    !sameInstallerIdentity(inventory.production.installer, expectedInstaller) ||
    !exactStringSetEquals(
      inventory.production.serviceIds,
      input.expectedServiceIds,
    ) ||
    !exactRefSetEquals(
      inventory.production.allowlistedRefs,
      expectedAllowlistedRefs,
    )
  )
    throw new Error("predecessor_inventory_successor_binding_mismatch");
  if (inventoryReferencesAction(inventory, input.predecessorRef)) return null;
  const unsigned = Object.freeze({
    fenceId: fence.fenceId,
    fenceEpoch: fence.epoch,
    inventoryDigest: inventory.inventoryDigest,
    capturedAt: inventory.capturedAt,
    databaseSnapshotIdentity: inventory.database.snapshotIdentity,
    databaseServerTime: inventory.database.serverTime,
    githubSnapshotIdentity: inventory.github.snapshotIdentity,
    githubProviderObservedAt: inventory.github.providerObservedAt,
    successorRef,
    repositoryCohortRevision: inventory.repositoryCohort.revision,
    repositoryCohortDigest: inventory.repositoryCohort.digest,
    githubRepositoryIds: inventory.repositoryCohort.githubRepositoryIds,
    policyRevision: inventory.policyRevision,
    inventoryScopeDigest,
    exactRefs: exactInventoryActionRefs(inventory),
    productionServiceIds: inventory.production.serviceIds,
    productionDeploymentIds: inventory.production.deploymentIds,
    productionConsensusDigest: inventory.production.consensusDigest,
    productionInstaller: expectedInstaller,
    maximumQueueLeaseWindowMs: inventory.maximumQueueLeaseWindowMs,
    requiredWindowMs: Math.max(
      fence.requiredWindowMs,
      inventory.maximumQueueLeaseWindowMs,
    ),
  });
  return freezeWithRuntimeBrand(
    {
      ...unsigned,
      captureDigest: zeroPredecessorCaptureDigest(unsigned),
    },
    zeroPredecessorCaptureBrand,
  ) as ZeroPredecessorReferenceCapture;
}

export interface PredecessorRemovalProof {
  readonly predecessorRef: ImmutableActionRef;
  readonly successorRef: ImmutableActionRef;
  readonly fenceId: string;
  readonly fenceEpoch: bigint;
  readonly first: Readonly<ZeroPredecessorReferenceCapture>;
  readonly second: Readonly<ZeroPredecessorReferenceCapture>;
  readonly requiredWindowMs: number;
  readonly proofDigest: Sha256;
  readonly [predecessorRemovalBrand]: true;
}

export function assertZeroPredecessorReferenceCapture(
  capture: ZeroPredecessorReferenceCapture,
  fence: PredecessorAdmissionFence,
): ZeroPredecessorReferenceCapture {
  const exactFence = predecessorAdmissionFence(fence);
  const { captureDigest, ...unsigned } = capture;
  if (
    capture[zeroPredecessorCaptureBrand] !== true ||
    captureDigest !== zeroPredecessorCaptureDigest(unsigned) ||
    capture.fenceId !== exactFence.fenceId ||
    capture.fenceEpoch !== exactFence.epoch ||
    capture.repositoryCohortRevision !== exactFence.repositoryCohortRevision ||
    capture.repositoryCohortDigest !== exactFence.repositoryCohortDigest ||
    capture.githubRepositoryIds.join("\n") !==
      exactFence.githubRepositoryIds.join("\n") ||
    capture.policyRevision !== exactFence.policyRevision ||
    capture.inventoryScopeDigest !== exactFence.inventoryScopeDigest ||
    !Number.isSafeInteger(capture.maximumQueueLeaseWindowMs) ||
    capture.maximumQueueLeaseWindowMs < 1 ||
    !Number.isSafeInteger(capture.requiredWindowMs) ||
    capture.requiredWindowMs !==
      Math.max(
        exactFence.requiredWindowMs,
        capture.maximumQueueLeaseWindowMs,
      ) ||
    validTimestamp(capture.capturedAt, "predecessor_capture_time") <
      validTimestamp(exactFence.closedAt, "predecessor_fence_time") ||
    validTimestamp(
      capture.databaseServerTime,
      "predecessor_database_snapshot_time",
    ) < validTimestamp(exactFence.closedAt, "predecessor_fence_time") ||
    validTimestamp(
      capture.databaseServerTime,
      "predecessor_database_snapshot_time",
    ) > validTimestamp(capture.capturedAt, "predecessor_capture_time") ||
    validTimestamp(
      capture.githubProviderObservedAt,
      "predecessor_github_provider_observation_time",
    ) < validTimestamp(exactFence.closedAt, "predecessor_fence_time") ||
    validTimestamp(
      capture.githubProviderObservedAt,
      "predecessor_github_provider_observation_time",
    ) > validTimestamp(capture.capturedAt, "predecessor_capture_time")
  )
    throw new Error("predecessor_zero_capture_binding_invalid");
  sha256(capture.inventoryDigest, "predecessor_capture_inventory_digest");
  sha256(
    capture.repositoryCohortDigest,
    "predecessor_capture_repository_cohort_digest",
  );
  sha256(
    capture.inventoryScopeDigest,
    "predecessor_capture_inventory_scope_digest",
  );
  sha256(
    capture.productionConsensusDigest,
    "predecessor_capture_production_consensus_digest",
  );
  identifier(
    capture.databaseSnapshotIdentity,
    "predecessor_database_snapshot_identity",
  );
  identifier(
    capture.githubSnapshotIdentity,
    "predecessor_github_snapshot_identity",
  );
  const exactCanonicalRefs = capture.exactRefs.map((ref) => ref.canonical);
  if (
    capture.githubRepositoryIds.length === 0 ||
    new Set(capture.githubRepositoryIds).size !==
      capture.githubRepositoryIds.length ||
    capture.githubRepositoryIds.some(
      (repositoryId) => !NUMERIC_ID_PATTERN.test(repositoryId),
    ) ||
    capture.productionServiceIds.length === 0 ||
    capture.productionServiceIds.length !==
      capture.productionDeploymentIds.length ||
    new Set(capture.productionServiceIds).size !==
      capture.productionServiceIds.length ||
    new Set(capture.productionDeploymentIds).size !==
      capture.productionDeploymentIds.length ||
    capture.productionServiceIds.some(
      (serviceId) => !IDENTIFIER_PATTERN.test(serviceId),
    ) ||
    capture.productionDeploymentIds.some(
      (deploymentId) => !IDENTIFIER_PATTERN.test(deploymentId),
    ) ||
    capture.productionServiceIds.join("\n") !==
      [...capture.productionServiceIds].sort().join("\n") ||
    capture.productionDeploymentIds.join("\n") !==
      [...capture.productionDeploymentIds].sort().join("\n") ||
    new Set(exactCanonicalRefs).size !== exactCanonicalRefs.length ||
    exactCanonicalRefs.join("\n") !== [...exactCanonicalRefs].sort().join("\n")
  )
    throw new Error("predecessor_zero_capture_scope_invalid");
  capture.exactRefs.forEach(assertImmutableActionRef);
  assertImmutableActionRef(capture.successorRef);
  if (
    sameActionRef(capture.successorRef, exactFence.predecessorRef) ||
    !sameActionRepository(capture.successorRef, exactFence.predecessorRef) ||
    capture.exactRefs.some((ref) =>
      sameActionRef(ref, exactFence.predecessorRef),
    )
  )
    throw new Error("predecessor_zero_capture_successor_invalid");
  exactActionInstallerIdentity(
    capture.productionInstaller,
    capture.successorRef,
  );
  return capture;
}

/** @internal Revalidates and rebrands a trusted persisted zero capture. */
export function hydrateZeroPredecessorReferenceCapture(
  snapshot: ZeroPredecessorReferenceCapture,
  fence: PredecessorAdmissionFence,
): ZeroPredecessorReferenceCapture {
  const successorRef = hydrateImmutableActionRef(snapshot.successorRef);
  const exactRefs = Object.freeze(
    snapshot.exactRefs.map(hydrateImmutableActionRef),
  );
  const productionInstaller = exactActionInstallerIdentity(
    snapshot.productionInstaller,
    successorRef,
  );
  const unsigned = Object.freeze({
    fenceId: snapshot.fenceId,
    fenceEpoch: snapshot.fenceEpoch,
    inventoryDigest: snapshot.inventoryDigest,
    capturedAt: snapshot.capturedAt,
    databaseSnapshotIdentity: snapshot.databaseSnapshotIdentity,
    databaseServerTime: snapshot.databaseServerTime,
    githubSnapshotIdentity: snapshot.githubSnapshotIdentity,
    githubProviderObservedAt: snapshot.githubProviderObservedAt,
    successorRef,
    repositoryCohortRevision: snapshot.repositoryCohortRevision,
    repositoryCohortDigest: snapshot.repositoryCohortDigest,
    githubRepositoryIds: Object.freeze([...snapshot.githubRepositoryIds]),
    policyRevision: snapshot.policyRevision,
    inventoryScopeDigest: snapshot.inventoryScopeDigest,
    exactRefs,
    productionServiceIds: Object.freeze([...snapshot.productionServiceIds]),
    productionDeploymentIds: Object.freeze([
      ...snapshot.productionDeploymentIds,
    ]),
    productionConsensusDigest: snapshot.productionConsensusDigest,
    productionInstaller,
    maximumQueueLeaseWindowMs: snapshot.maximumQueueLeaseWindowMs,
    requiredWindowMs: snapshot.requiredWindowMs,
  });
  const expectedCaptureDigest = zeroPredecessorCaptureDigest(unsigned);
  if (snapshot.captureDigest !== expectedCaptureDigest)
    throw new Error("predecessor_zero_capture_persisted_digest_mismatch");
  const hydrated = freezeWithRuntimeBrand(
    { ...unsigned, captureDigest: expectedCaptureDigest },
    zeroPredecessorCaptureBrand,
  ) as ZeroPredecessorReferenceCapture;
  return assertZeroPredecessorReferenceCapture(hydrated, fence);
}

export function predecessorRemovalProof(input: {
  readonly predecessorRef: ImmutableActionRef;
  readonly successorRef: ImmutableActionRef;
  readonly fence: PredecessorAdmissionFence;
  readonly first: ZeroPredecessorReferenceCapture;
  readonly second: ZeroPredecessorReferenceCapture;
}): PredecessorRemovalProof {
  const fence = predecessorAdmissionFence(input.fence);
  assertZeroPredecessorReferenceCapture(input.first, fence);
  assertZeroPredecessorReferenceCapture(input.second, fence);
  if (!sameActionRef(input.predecessorRef, fence.predecessorRef))
    throw new Error("predecessor_removal_fence_ref_mismatch");
  if (
    !sameActionRef(input.first.successorRef, input.successorRef) ||
    !sameActionRef(input.second.successorRef, input.successorRef)
  )
    throw new Error("predecessor_removal_successor_ref_mismatch");
  const firstObservationBoundary = Math.max(
    validTimestamp(
      input.first.databaseServerTime,
      "predecessor_first_database_snapshot_time",
    ),
    validTimestamp(
      input.first.githubProviderObservedAt,
      "predecessor_first_github_provider_observation_time",
    ),
  );
  const secondObservationBoundary = Math.min(
    validTimestamp(
      input.second.databaseServerTime,
      "predecessor_second_database_snapshot_time",
    ),
    validTimestamp(
      input.second.githubProviderObservedAt,
      "predecessor_second_github_provider_observation_time",
    ),
  );
  const requiredWindowMs = Math.max(
    fence.requiredWindowMs,
    input.first.requiredWindowMs,
    input.second.requiredWindowMs,
  );
  if (
    input.first[zeroPredecessorCaptureBrand] !== true ||
    input.second[zeroPredecessorCaptureBrand] !== true ||
    input.first.fenceId !== fence.fenceId ||
    input.second.fenceId !== fence.fenceId ||
    input.first.fenceEpoch !== fence.epoch ||
    input.second.fenceEpoch !== fence.epoch ||
    input.first.inventoryDigest === input.second.inventoryDigest ||
    input.first.databaseSnapshotIdentity ===
      input.second.databaseSnapshotIdentity ||
    input.first.githubSnapshotIdentity ===
      input.second.githubSnapshotIdentity ||
    input.first.repositoryCohortRevision !==
      input.second.repositoryCohortRevision ||
    input.first.repositoryCohortDigest !==
      input.second.repositoryCohortDigest ||
    input.first.githubRepositoryIds.join("\n") !==
      input.second.githubRepositoryIds.join("\n") ||
    input.first.policyRevision !== input.second.policyRevision ||
    input.first.inventoryScopeDigest !== input.second.inventoryScopeDigest ||
    input.first.productionServiceIds.join("\n") !==
      input.second.productionServiceIds.join("\n") ||
    input.first.productionDeploymentIds.join("\n") !==
      input.second.productionDeploymentIds.join("\n") ||
    input.first.productionConsensusDigest !==
      input.second.productionConsensusDigest ||
    !sameInstallerIdentity(
      input.first.productionInstaller,
      input.second.productionInstaller,
    ) ||
    input.first.repositoryCohortRevision !== fence.repositoryCohortRevision ||
    input.first.policyRevision !== fence.policyRevision ||
    secondObservationBoundary - firstObservationBoundary < requiredWindowMs
  )
    throw new Error("predecessor_two_capture_window_unproven");
  const digestInput = {
    predecessorRef: canonicalActionRef(input.predecessorRef),
    successorRef: canonicalActionRef(input.successorRef),
    fenceId: fence.fenceId,
    fenceEpoch: fence.epoch.toString(),
    first: {
      ...input.first,
      fenceEpoch: input.first.fenceEpoch.toString(),
      repositoryCohortRevision: input.first.repositoryCohortRevision.toString(),
      policyRevision: input.first.policyRevision.toString(),
    },
    second: {
      ...input.second,
      fenceEpoch: input.second.fenceEpoch.toString(),
      repositoryCohortRevision:
        input.second.repositoryCohortRevision.toString(),
      policyRevision: input.second.policyRevision.toString(),
    },
    requiredWindowMs,
  };
  return freezeWithRuntimeBrand(
    {
      predecessorRef: input.predecessorRef,
      successorRef: input.successorRef,
      fenceId: fence.fenceId,
      fenceEpoch: fence.epoch,
      first: input.first,
      second: input.second,
      requiredWindowMs,
      proofDigest: sha256(
        `sha256:${sha256Canonical(digestInput)}`,
        "predecessor_removal_proof_digest",
      ),
    },
    predecessorRemovalBrand,
  ) as PredecessorRemovalProof;
}

export function assertPredecessorRemovalProof(
  proof: PredecessorRemovalProof,
  predecessorRef: ImmutableActionRef,
  successorRef: ImmutableActionRef,
  fence: PredecessorAdmissionFence,
): void {
  if (
    !sameActionRef(proof.predecessorRef, predecessorRef) ||
    !sameActionRef(proof.successorRef, successorRef) ||
    proof.fenceId !== fence.fenceId ||
    proof.fenceEpoch !== fence.epoch
  )
    throw new Error("predecessor_removal_proof_binding_mismatch");
  const rebuilt = predecessorRemovalProof({
    predecessorRef,
    successorRef,
    fence,
    first: proof.first,
    second: proof.second,
  });
  if (
    proof[predecessorRemovalBrand] !== true ||
    proof.proofDigest !== rebuilt.proofDigest
  )
    throw new Error("predecessor_removal_proof_digest_mismatch");
}

/** @internal Revalidates and rebrands a trusted persisted removal proof. */
export function hydratePredecessorRemovalProof(
  snapshot: PredecessorRemovalProof,
  predecessorRef: ImmutableActionRef,
  successorRef: ImmutableActionRef,
  fence: PredecessorAdmissionFence,
): PredecessorRemovalProof {
  const persistedPredecessor = hydrateImmutableActionRef(
    snapshot.predecessorRef,
  );
  const persistedSuccessor = hydrateImmutableActionRef(snapshot.successorRef);
  if (
    !sameActionRef(persistedPredecessor, predecessorRef) ||
    !sameActionRef(persistedSuccessor, successorRef)
  )
    throw new Error("predecessor_removal_persisted_ref_mismatch");
  const first = hydrateZeroPredecessorReferenceCapture(snapshot.first, fence);
  const second = hydrateZeroPredecessorReferenceCapture(snapshot.second, fence);
  const rebuilt = predecessorRemovalProof({
    predecessorRef,
    successorRef,
    fence,
    first,
    second,
  });
  if (
    snapshot.proofDigest !== rebuilt.proofDigest ||
    snapshot.requiredWindowMs !== rebuilt.requiredWindowMs ||
    snapshot.fenceId !== rebuilt.fenceId ||
    snapshot.fenceEpoch !== rebuilt.fenceEpoch
  )
    throw new Error("predecessor_removal_persisted_digest_mismatch");
  return rebuilt;
}
