import { describe, expect, it } from "vitest";
import { buildPendingOrganizationInstallRequest } from "./dashboard-app-install-request";

describe("GitHub App organization install request helpers", () => {
  it("builds a pending workspace tab model from safe account params", () => {
    expect(
      buildPendingOrganizationInstallRequest({
        setup_action: "request",
        organization: "Padelapp-Club",
      }),
    ).toEqual({
      id: "github-app-organization-request-pending",
      accountLogin: "Padelapp-Club",
    });
  });

  it("falls back when GitHub does not include a usable organization login", () => {
    expect(
      buildPendingOrganizationInstallRequest({
        setup_action: "request",
        organization: "../bad",
      }),
    ).toEqual({
      id: "github-app-organization-request-pending",
      accountLogin: "Organization request",
    });
    expect(buildPendingOrganizationInstallRequest({ setup_action: "install" }))
      .toBeNull();
  });
});
