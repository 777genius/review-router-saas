const reviewOnlyPermissions = Object.freeze({
  actions: "read",
  checks: "write",
  contents: "read",
  issues: "write",
  pull_requests: "write",
  statuses: "write",
  metadata: "read",
});

const managedReviewPermissions = Object.freeze({
  ...reviewOnlyPermissions,
  actions: "write",
});

const provisioningPermissions = Object.freeze({
  ...managedReviewPermissions,
  contents: "write",
  workflows: "write",
  secrets: "write",
  organization_secrets: "read",
  organization_plan: "read",
});

const reviewOnlyEvents = Object.freeze([
  "check_run",
  "issue_comment",
  "pull_request",
  "repository",
  "status",
  "workflow_run",
]);

const managedReviewEvents = Object.freeze([
  "check_run",
  "issue_comment",
  "pull_request",
  "push",
  "repository",
  "status",
  "workflow_job",
  "workflow_run",
]);

const profiles = Object.freeze({
  "review-only": Object.freeze({
    name: "review-only",
    description:
      "Manual/customer-managed workflows. No server-side workflow dispatch, workflow edits, or secret provisioning.",
    permissions: reviewOnlyPermissions,
    events: reviewOnlyEvents,
  }),
  "managed-review": Object.freeze({
    name: "managed-review",
    description:
      "ReviewRouter-managed durable review dispatch and cancellation. Workflow files and provider secrets are still managed outside the control plane.",
    permissions: managedReviewPermissions,
    events: managedReviewEvents,
  }),
  provisioning: Object.freeze({
    name: "provisioning",
    description:
      "Dashboard setup PRs, workflow file updates, and GitHub Actions secret provisioning.",
    permissions: provisioningPermissions,
    events: managedReviewEvents,
  }),
  "org-ruleset": Object.freeze({
    name: "org-ruleset",
    description:
      "Provisioning profile plus organization ruleset administration.",
    permissions: Object.freeze({
      ...provisioningPermissions,
      organization_administration: "write",
    }),
    events: managedReviewEvents,
  }),
});

const aliases = Object.freeze({
  standard: "provisioning",
});

export const githubAppPermissionProfileNames = Object.freeze([
  "review-only",
  "managed-review",
  "provisioning",
  "standard",
  "org-ruleset",
]);

export const githubAppPermissionNames = Object.freeze([
  ...new Set(
    Object.values(profiles).flatMap((profile) =>
      Object.keys(profile.permissions),
    ),
  ),
]);

export function normalizeGitHubAppPermissionProfile(value) {
  const normalized = String(value ?? "").trim() || "standard";
  const canonical = aliases[normalized] ?? normalized;
  if (canonical in profiles) return canonical;
  throw new Error(
    `GitHub App permission profile must be one of: ${githubAppPermissionProfileNames.join(", ")}`,
  );
}

export function getGitHubAppPermissionProfile(value) {
  return profiles[normalizeGitHubAppPermissionProfile(value)];
}

export function manifestPermissionsForProfile(profile) {
  const permissions = {};
  for (const [permission, access] of Object.entries(profile.permissions)) {
    if (permission === "metadata") continue;
    permissions[permission] = access;
  }
  return permissions;
}
