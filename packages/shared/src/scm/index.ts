export const scmProviders = ["github", "gitlab"] as const;

export type ScmProvider = (typeof scmProviders)[number];

export const ciProviders = ["github-actions", "gitlab-ci"] as const;

export type CiProvider = (typeof ciProviders)[number];

export type ScmRepositoryIdentity = {
  readonly provider: ScmProvider;
  readonly externalRepositoryId: string;
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
};

export type CiRunIdentity = {
  readonly provider: CiProvider;
  readonly externalRepositoryId: string;
  readonly runId: string;
  readonly runAttempt?: string | undefined;
  readonly actorLogin?: string | null | undefined;
};

export function isScmProvider(value: string): value is ScmProvider {
  return (scmProviders as readonly string[]).includes(value);
}

export function isCiProvider(value: string): value is CiProvider {
  return (ciProviders as readonly string[]).includes(value);
}

export function scmRepositoryIdentityKey(
  identity: Pick<ScmRepositoryIdentity, "provider" | "externalRepositoryId">,
): string {
  const externalRepositoryId = identity.externalRepositoryId.trim();
  if (!externalRepositoryId) {
    throw new Error("scm_repository_external_id_required");
  }
  return `${identity.provider}:${externalRepositoryId}`;
}

export function ciRunIdentityKey(
  identity: Pick<
    CiRunIdentity,
    "provider" | "externalRepositoryId" | "runId" | "runAttempt"
  >,
): string {
  const repositoryKey = scmRepositoryIdentityKey({
    provider: ciProviderToScmProvider(identity.provider),
    externalRepositoryId: identity.externalRepositoryId,
  });
  const runId = identity.runId.trim();
  if (!runId) {
    throw new Error("ci_run_id_required");
  }
  const runAttempt = identity.runAttempt?.trim();
  return runAttempt
    ? `${repositoryKey}:${identity.provider}:${runId}:${runAttempt}`
    : `${repositoryKey}:${identity.provider}:${runId}`;
}

export function ciProviderToScmProvider(provider: CiProvider): ScmProvider {
  switch (provider) {
    case "github-actions":
      return "github";
    case "gitlab-ci":
      return "gitlab";
  }
}
