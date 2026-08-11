export function assertDisposableRepositoryProvenance(input: {
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly expectedExistingRepositoryId?: string;
}): void {
  if (!/^[1-9][0-9]*$/u.test(input.repositoryId)) {
    throw new Error(
      `codex_rotating_e2e_repository_numeric_id_required:${input.repositoryFullName}`,
    );
  }
  const expectedRepositoryId = input.expectedExistingRepositoryId?.trim();
  if (!expectedRepositoryId || !/^[1-9][0-9]*$/u.test(expectedRepositoryId)) {
    throw new Error(
      `codex_rotating_e2e_existing_repository_provenance_required:${input.repositoryFullName}`,
    );
  }
  if (expectedRepositoryId !== input.repositoryId) {
    throw new Error(
      `codex_rotating_e2e_existing_repository_id_mismatch:${input.repositoryFullName}`,
    );
  }
}
