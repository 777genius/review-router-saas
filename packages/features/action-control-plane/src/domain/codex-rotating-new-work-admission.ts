export type CodexRotatingNewWorkAdmission = Readonly<{
  enabledValue: string | undefined;
  approvedRepositories: readonly string[];
  repositoryFullName: string;
}>;

export function assertCodexRotatingNewWorkAdmitted(
  input: CodexRotatingNewWorkAdmission,
): void {
  if (input.enabledValue !== "1") {
    throw new Error("codex_rotating_new_work_admission_closed");
  }
  const approved = normalizeApprovedRepositories(input.approvedRepositories);
  if (approved.length === 0) {
    throw new Error("codex_rotating_new_work_cohort_required");
  }
  if (!approved.includes(input.repositoryFullName.trim().toLowerCase())) {
    throw new Error("codex_rotating_new_work_repository_not_approved");
  }
}

export function normalizeApprovedRepositories(
  values: readonly string[],
): readonly string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].filter(
    Boolean,
  );
}
