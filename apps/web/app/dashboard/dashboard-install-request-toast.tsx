"use client";

import { useEffect, useState } from "react";
import { ActionToast } from "../action-toast";

type PendingOrganizationInstallRequest = {
  readonly accountLogin: string;
};

const githubAppRequestQueryKeys = [
  "setup_action",
  "account_login",
  "account",
  "target_login",
  "organization",
  "org",
] as const;

export function DashboardInstallRequestToast({
  request,
}: {
  readonly request: PendingOrganizationInstallRequest | null;
}): React.ReactElement | null {
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    if (!request) return;

    const fromGitHub = isLikelyGitHubRedirect();
    removeGitHubAppRequestParamsFromUrl();
    if (!fromGitHub) return;

    const key = `reviewrouter:github-app-request-flash:${request.accountLogin}`;
    try {
      if (window.sessionStorage.getItem(key) === "1") return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // Storage can be blocked. URL cleanup still prevents stale repeats.
    }

    setShowToast(true);
  }, [request]);

  if (!showToast) return null;

  return (
    <ActionToast
      tone="warning"
      title="Organization request sent"
      body="GitHub sent the install request to the organization owners. ReviewRouter will show the organization as a workspace after an owner approves the request."
    />
  );
}

function isLikelyGitHubRedirect(): boolean {
  try {
    const referrer = new URL(document.referrer);
    return (
      referrer.hostname === "github.com" ||
      referrer.hostname.endsWith(".github.com")
    );
  } catch {
    return false;
  }
}

function removeGitHubAppRequestParamsFromUrl(): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of githubAppRequestQueryKeys) {
    changed = url.searchParams.delete(key) || changed;
  }
  if (!changed) return;

  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}
