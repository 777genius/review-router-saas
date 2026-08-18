const conflictMessages = new Set([
  "release rollout claim identity conflict",
  "release authority activation identity conflict",
  "release authority activation replay conflict",
  "release authority activation receipt conflict",
  "provider authority binding denied",
  "provider authority receipt denied",
  "provider authority state denied",
  "provider authority replay conflict",
  "provider authority runner effects changed during compensation",
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
  "release recovery effect intent invalid",
  "release recovery effect intent denied",
  "release recovery effect service scope denied",
  "release recovery effect intent replay conflict",
  "release recovery effect claim invalid",
  "release recovery effect claim binding conflict",
  "release recovery effect claim denied",
  "release recovery effect already claimed",
  "release recovery effect permit invalid",
  "release recovery effect permit binding conflict",
  "release recovery effect permit replay conflict",
  "release recovery effect permit denied",
  "release recovery effect execution validation invalid",
  "release recovery effect execution fence conflict",
  "release recovery effect execution denied",
  "release recovery effect observation invalid",
  "release recovery effect observation binding conflict",
  "release recovery effect completion binding conflict",
  "release recovery effect completion fence conflict",
  "release recovery effect completion replay conflict",
  "release recovery effect forward observation conflict",
  "release recovery effect was not consumed",
  "release recovery effect execution not authorized",
  "release recovery effect reconciliation invalid",
  "release recovery effect reconciliation fence conflict",
  "release recovery checkpoint permit completion missing",
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
  const detail = String(value?.meta?.message ?? value?.message ?? "");
  const prismaFailure =
    value?.code === "P2010"
      ? /(?:^|\n)Raw query failed\. Code: `(P\d{4})`\. Message: `([^`\r\n]+)`$/u.exec(
          detail,
        )
      : null;
  const postgresFailure = /^ERROR: ([^\r\n]+)(?:\r?\nCONTEXT:[\s\S]*)?$/u.exec(
    detail,
  );
  const databaseCode = value?.meta?.code ?? prismaFailure?.[1] ?? value?.code;
  const routineMessage = prismaFailure?.[2] ?? postgresFailure?.[1] ?? detail;
  if (
    databaseCode === "P0002" ||
    (databaseCode === "P0001" && conflictMessages.has(routineMessage))
  )
    throw new ReleaseAuthorityAdapterConflictError();
  throw new ReleaseAuthorityAdapterUnexpectedError(error);
};
