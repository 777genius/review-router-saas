const conflictMessages = new Set([
  "release rollout claim identity conflict",
  "release authority activation identity conflict",
  "release authority activation replay conflict",
  "release authority activation receipt conflict",
  "provider authority replay conflict",
  "release runner intent identity conflict",
  "release runner duplicate effects unsafe for activation",
  "release source freeze binding invalid",
  "release source freeze replay conflict",
  "release source freeze inventory conflict",
  "release source freeze completion binding invalid",
  "release source freeze completion replay conflict",
  "release source resume lacks rollout suspension evidence",
  "release target service transition incomplete",
  "release source recovery manifest mismatch",
  "release source service recovery incomplete",
  "release service transition intent conflict",
  "release service transition recovery intent missing",
  "release service transition checkpoint conflict",
  "release service transition checkpoint replay conflict",
  "release service transition checkpoint out of order",
  "release service transition source verification incomplete",
  "release service transition source acl not restored",
  "release source recovery runner effects unsafe",
]);

export class ReleaseAuthorityAdapterConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("release_authority_conflict");
    this.name = "ReleaseAuthorityAdapterConflictError";
  }
}

export class ReleaseAuthorityAdapterUnexpectedError extends Error {
  readonly statusCode = 500;

  constructor(cause: unknown) {
    super("release_authority_adapter_failure", { cause });
    this.name = "ReleaseAuthorityAdapterUnexpectedError";
  }
}

export const normalizeReleaseAuthorityRoutineError = (
  error: unknown,
): never => {
  const value =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          message?: unknown;
          meta?: { code?: unknown; message?: unknown };
        })
      : undefined;
  const databaseCode = value?.meta?.code ?? value?.code;
  const detail = String(value?.meta?.message ?? value?.message ?? "");
  if (
    databaseCode === "P0002" ||
    (databaseCode === "P0001" && conflictMessages.has(detail))
  )
    throw new ReleaseAuthorityAdapterConflictError();
  throw new ReleaseAuthorityAdapterUnexpectedError(error);
};
