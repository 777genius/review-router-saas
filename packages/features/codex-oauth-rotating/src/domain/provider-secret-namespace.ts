import { createHash, randomBytes } from "node:crypto";

export const githubSecretNameMaxLength = 255;
export const legacyCodexRotatingSecretName =
  "REVIEWROUTER_CODEX_AUTH_JSON" as const;

export enum ProviderSecretNamespaceMode {
  LegacyFixedName = "legacy_fixed_name",
  VersionedNeverReused = "versioned_never_reused",
}

export type ProviderNamespaceEpoch = bigint;
export type RepositoryProviderScope = Readonly<{
  repositoryId: string;
  providerInstanceId: string;
}>;
export type LegacyProviderSecretNamespace = Readonly<{
  mode: ProviderSecretNamespaceMode.LegacyFixedName;
  scope: RepositoryProviderScope;
  name: typeof legacyCodexRotatingSecretName;
}>;
export type VersionedProviderSecretNamespace = Readonly<{
  mode: ProviderSecretNamespaceMode.VersionedNeverReused;
  scope: RepositoryProviderScope;
  namespaceId: string;
  name: string;
  epoch: ProviderNamespaceEpoch;
}>;
export type ProviderSecretNamespace =
  | LegacyProviderSecretNamespace
  | VersionedProviderSecretNamespace;

const githubSecretNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const namespaceIdPattern = /^[A-Za-z0-9._:-]{8,200}$/;
const providerInstanceIdPattern = /^[A-Za-z0-9_.:-]{8,160}$/;
export const versionedProviderSecretNamePattern =
  /^REVIEWROUTER_CODEX_AUTH_JSON_R([1-9][0-9]*)_P([a-f0-9]{16})_E([1-9][0-9]*)_([a-f0-9]{32})$/;

export type VersionedProviderSecretName = Readonly<{
  repositoryId: string;
  providerScopeHash: string;
  epoch: ProviderNamespaceEpoch;
  entropy: string;
  name: string;
}>;

export function createLegacyProviderSecretNamespace(
  scope: RepositoryProviderScope,
): LegacyProviderSecretNamespace {
  return Object.freeze({
    mode: ProviderSecretNamespaceMode.LegacyFixedName,
    scope: validateScope(scope),
    name: legacyCodexRotatingSecretName,
  });
}

export function createVersionedProviderSecretNamespace(input: {
  readonly scope: RepositoryProviderScope;
  readonly namespaceId: string;
  readonly name: string;
  readonly epoch: bigint | number | string;
}): VersionedProviderSecretNamespace {
  const scope = validateScope(input.scope);
  const epoch = parseProviderNamespaceEpoch(input.epoch);
  if (!namespaceIdPattern.test(input.namespaceId)) {
    throw new Error("provider_secret_namespace_id_invalid");
  }
  const parsedName = parseVersionedProviderSecretName(input.name);
  if (
    parsedName.repositoryId !== scope.repositoryId ||
    parsedName.providerScopeHash !== providerScopeHash(scope.providerInstanceId)
  ) {
    throw new Error("provider_secret_namespace_scope_mismatch");
  }
  if (parsedName.epoch !== epoch) {
    throw new Error("provider_secret_namespace_epoch_mismatch");
  }
  return Object.freeze({
    mode: ProviderSecretNamespaceMode.VersionedNeverReused,
    scope,
    namespaceId: input.namespaceId,
    name: input.name,
    epoch,
  });
}

export function allocateVersionedProviderSecretNamespace(input: {
  readonly scope: RepositoryProviderScope;
  readonly epoch: bigint | number | string;
  readonly randomBytes?: (size: number) => Uint8Array;
}): VersionedProviderSecretNamespace {
  const scope = validateScope(input.scope);
  const epoch = parseProviderNamespaceEpoch(input.epoch);
  const entropy = Buffer.from((input.randomBytes ?? randomBytes)(16)).toString(
    "hex",
  );
  if (entropy.length !== 32) {
    throw new Error("provider_secret_namespace_randomness_invalid");
  }
  return createVersionedProviderSecretNamespace({
    scope,
    epoch,
    namespaceId: `sns_${entropy}`,
    name: `${versionedNamespacePrefix(scope, epoch)}${entropy}`,
  });
}

export function parseVersionedProviderSecretName(
  name: string,
): VersionedProviderSecretName {
  assertGitHubSecretName(name);
  const match = versionedProviderSecretNamePattern.exec(name);
  if (!match) throw new Error("provider_secret_namespace_name_invalid");
  return Object.freeze({
    repositoryId: match[1]!,
    providerScopeHash: match[2]!,
    epoch: parseProviderNamespaceEpoch(match[3]!),
    entropy: match[4]!,
    name,
  });
}

export type ActiveProviderSecretNamespaceRow = Readonly<{
  activeSecretNamespaceId: string | null;
  activeSecretNamespaceEpoch: bigint | null;
  activeSecretNamespace: Readonly<{
    id: string;
    githubRepositoryId: string;
    namespaceEpoch: bigint;
    secretName: string;
    status: string;
  }> | null;
}>;

export function mapActiveVersionedProviderSecretNamespace(input: {
  readonly scope: RepositoryProviderScope;
  readonly row: ActiveProviderSecretNamespaceRow;
}): VersionedProviderSecretNamespace {
  const relation = input.row.activeSecretNamespace;
  if (
    !input.row.activeSecretNamespaceId ||
    input.row.activeSecretNamespaceEpoch === null ||
    !relation ||
    relation.status !== "active" ||
    relation.id !== input.row.activeSecretNamespaceId ||
    relation.namespaceEpoch !== input.row.activeSecretNamespaceEpoch ||
    relation.githubRepositoryId !== input.scope.repositoryId
  ) {
    throw new Error("codex_rotating_active_secret_namespace_required");
  }
  return createVersionedProviderSecretNamespace({
    scope: input.scope,
    namespaceId: relation.id,
    epoch: relation.namespaceEpoch,
    name: relation.secretName,
  });
}

export function serializeVersionedProviderSecretNamespaceMetadata(
  namespace: VersionedProviderSecretNamespace,
): string {
  const canonical = createVersionedProviderSecretNamespace(namespace);
  return `namespace=${canonical.namespaceId};epoch=${canonical.epoch};secret=${canonical.name}`;
}

export function parseVersionedProviderSecretNamespaceMetadata(input: {
  readonly metadata: string;
  readonly providerInstanceId: string;
}): VersionedProviderSecretNamespace {
  const entries = Object.fromEntries(
    input.metadata.split(";").map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        throw new Error("provider_secret_namespace_metadata_invalid");
      }
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  if (
    Object.keys(entries).length !== 3 ||
    !entries.namespace ||
    !entries.epoch ||
    !entries.secret
  ) {
    throw new Error("provider_secret_namespace_metadata_invalid");
  }
  const parsedName = parseVersionedProviderSecretName(entries.secret);
  return createVersionedProviderSecretNamespace({
    scope: {
      repositoryId: parsedName.repositoryId,
      providerInstanceId: input.providerInstanceId,
    },
    namespaceId: entries.namespace,
    epoch: entries.epoch,
    name: entries.secret,
  });
}

export function serializeProviderNamespaceEpoch(
  epoch: ProviderNamespaceEpoch,
): string {
  return parseProviderNamespaceEpoch(epoch).toString(10);
}

export function assertSameVersionedProviderSecretNamespace(input: {
  readonly expected: VersionedProviderSecretNamespace;
  readonly actual: VersionedProviderSecretNamespace;
}): void {
  const expected = createVersionedProviderSecretNamespace(input.expected);
  const actual = createVersionedProviderSecretNamespace(input.actual);
  if (expected.scope.repositoryId !== actual.scope.repositoryId)
    throw new Error("provider_secret_namespace_repository_mismatch");
  if (expected.scope.providerInstanceId !== actual.scope.providerInstanceId)
    throw new Error("provider_secret_namespace_provider_mismatch");
  if (expected.epoch !== actual.epoch)
    throw new Error("provider_secret_namespace_epoch_mismatch");
  if (expected.namespaceId !== actual.namespaceId)
    throw new Error("provider_secret_namespace_id_mismatch");
  if (expected.name !== actual.name)
    throw new Error("provider_secret_namespace_name_mismatch");
}

function validateScope(
  scope: RepositoryProviderScope,
): RepositoryProviderScope {
  if (!/^[1-9][0-9]*$/.test(scope.repositoryId))
    throw new Error("provider_secret_namespace_repository_id_invalid");
  if (!providerInstanceIdPattern.test(scope.providerInstanceId))
    throw new Error("provider_secret_namespace_provider_id_invalid");
  return Object.freeze({ ...scope });
}

function parseProviderNamespaceEpoch(
  value: bigint | number | string,
): ProviderNamespaceEpoch {
  let epoch: bigint;
  try {
    epoch = BigInt(value);
  } catch {
    throw new Error("provider_secret_namespace_epoch_invalid");
  }
  if (epoch <= 0n || epoch > 9_223_372_036_854_775_807n)
    throw new Error("provider_secret_namespace_epoch_invalid");
  return epoch;
}

function versionedNamespacePrefix(
  scope: RepositoryProviderScope,
  epoch: ProviderNamespaceEpoch,
): string {
  return `REVIEWROUTER_CODEX_AUTH_JSON_R${scope.repositoryId}_P${providerScopeHash(scope.providerInstanceId)}_E${epoch}_`;
}

function providerScopeHash(providerInstanceId: string): string {
  return createHash("sha256")
    .update(providerInstanceId, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function assertGitHubSecretName(name: string): void {
  if (
    name.length > githubSecretNameMaxLength ||
    !githubSecretNamePattern.test(name) ||
    name.toUpperCase().startsWith("GITHUB_")
  ) {
    throw new Error("provider_secret_namespace_name_invalid");
  }
}
