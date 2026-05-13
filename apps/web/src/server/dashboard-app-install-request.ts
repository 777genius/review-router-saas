export type DashboardSearchParams = Record<
  string,
  string | string[] | undefined
>;

export type PendingOrganizationInstallRequest = {
  readonly id: string;
  readonly accountLogin: string;
};

const pendingOrganizationInstallRequestId =
  "github-app-organization-request-pending";

export function buildPendingOrganizationInstallRequest(
  params: DashboardSearchParams,
): PendingOrganizationInstallRequest | null {
  if (readParam(params.setup_action).trim() !== "request") return null;

  return {
    id: pendingOrganizationInstallRequestId,
    accountLogin:
      readPendingOrganizationInstallAccount(params) || "Organization request",
  };
}

function readPendingOrganizationInstallAccount(
  params: DashboardSearchParams,
): string {
  for (const key of [
    "account_login",
    "account",
    "target_login",
    "organization",
    "org",
  ]) {
    const value = readParam(params[key]).trim();
    if (/^[A-Za-z0-9_.-]+$/.test(value)) return value;
  }
  return "";
}

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
