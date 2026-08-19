import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const release = readFileSync(".github/workflows/release.yml", "utf8");
const rollout = readFileSync(
  ".github/workflows/private-network-pg17-rollout.yml",
  "utf8",
);
const authorityMigration = readFileSync(
  ".github/workflows/release-authority-migration.yml",
  "utf8",
);
const sha = "13165687d30af3b9fbb043f0e294744de612a6a0";

function jobs(source: string): string[] {
  return source
    .slice(source.indexOf("\njobs:\n") + "\njobs:\n".length)
    .split(/^ {2}(?=[a-z][a-z0-9-]+:\n)/mu)
    .slice(1)
    .map((block) => `  ${block}`);
}

function inlineBootstrap(source: string): string {
  const match =
    /\/\/ trust-bootstrap-node:start\n([\s\S]*?)\n\s*\/\/ trust-bootstrap-node:end/u.exec(
      source,
    );
  if (!match?.[1]) throw new Error("inline_trust_bootstrap_missing");
  return match[1];
}

type Fixture = Readonly<Record<string, unknown>>;

function executeBootstrap(
  source: string,
  environment: Readonly<Record<string, string>>,
  fixture: Fixture,
) {
  const directory = mkdtempSync(join(tmpdir(), "rr-workflow-trust-"));
  const output = join(directory, "output");
  const program = `
globalThis.fetch = async (url) => {
  const fixture = JSON.parse(process.env.TRUST_TEST_FIXTURE_JSON);
  const path = new URL(String(url)).pathname;
  if (!(path in fixture)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => fixture[path] };
};
${inlineBootstrap(source)}
`;
  const result = spawnSync(process.execPath, ["-e", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      GITHUB_OUTPUT: output,
      TRUST_TEST_FIXTURE_JSON: JSON.stringify(fixture),
    },
  });
  const githubOutput =
    result.status === 0 ? readFileSync(output, "utf8") : undefined;
  rmSync(directory, { recursive: true, force: true });
  return { ...result, githubOutput };
}

const protectedEnvironment = {
  protection_rules: [
    {
      type: "required_reviewers",
      prevent_self_review: false,
      reviewers: [{ type: "Team", id: 1 }],
    },
    { type: "branch_policy" },
  ],
  deployment_branch_policy: {
    protected_branches: true,
    custom_branch_policies: false,
  },
};

const releaseEnvironment = {
  GITHUB_REPOSITORY: "777genius/review-router-saas",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: sha,
  GH_TOKEN: "read-only-test-token",
  REQUIRED_ENVIRONMENT: "production-release",
  REVIEW_ROUTER_RELEASE_APPROVAL_MODE: "solo_owner",
};
const releaseFixture: Fixture = {
  "/repos/777genius/review-router-saas/branches/main": {
    protected: true,
    commit: { sha },
  },
  "/repos/777genius/review-router-saas/environments/production-release":
    protectedEnvironment,
};

const authorityMigrationEnvironment = {
  ...releaseEnvironment,
  EXPECTED_SHA: sha,
  REQUIRED_ENVIRONMENT: "production-release-authority-migration",
};
const authorityMigrationFixture: Fixture = {
  "/repos/777genius/review-router-saas/branches/main": {
    protected: true,
    commit: { sha },
  },
  "/repos/777genius/review-router-saas/environments/production-release-authority-migration":
    protectedEnvironment,
};

const rolloutEnvironment = {
  ...releaseEnvironment,
  GITHUB_RUN_ATTEMPT: "1",
  EXPECTED_SHA: sha,
  RELEASE_RUN_ID: "7001",
  RELEASE_ARTIFACT_ID: "8001",
  EXPECTED_ORGANIZATION: "777genius",
  EXPECTED_REPOSITORY: "777genius/review-router-saas",
  REVIEW_ROUTER_RELEASE_APPROVAL_MODE: "solo_owner",
  REQUIRED_ENVIRONMENTS_JSON: JSON.stringify([
    "production-release-preflight",
    "production-runner-control",
    "production-role-bootstrap",
    "production-runner-ledger-read",
    "production",
    "production-service-switch",
  ]),
};
const rolloutFixture: Fixture = {
  "/repos/777genius/review-router-saas/branches/main": {
    protected: true,
    commit: { sha },
  },
  "/repos/777genius/review-router-saas/actions/runs/7001": {
    id: 7001,
    event: "workflow_dispatch",
    path: ".github/workflows/release.yml",
    head_branch: "main",
    head_sha: sha,
    run_attempt: 1,
    conclusion: "success",
  },
  "/repos/777genius/review-router-saas/actions/artifacts/8001": {
    id: 8001,
    expired: false,
    name: "hosted-runtime-image-v1.2.3",
    workflow_run: { id: 7001, head_sha: sha },
  },
  ...Object.fromEntries(
    JSON.parse(rolloutEnvironment.REQUIRED_ENVIRONMENTS_JSON).map(
      (name: string) => [
        `/repos/777genius/review-router-saas/environments/${name}`,
        protectedEnvironment,
      ],
    ),
  ),
};

describe("release workflow immutable trust bootstrap", () => {
  it("accepts only current protected main behind a protected environment", () => {
    const result = executeBootstrap(
      release,
      releaseEnvironment,
      releaseFixture,
    );
    expect(result.status).toBe(0);
    expect(result.githubOutput).toBe(`trusted_sha=${sha}\n`);
  });

  it.each([
    [
      "a malicious non-main dispatch",
      { GITHUB_REF: "refs/heads/attacker" },
      releaseFixture,
    ],
    [
      "stale main",
      {},
      {
        ...releaseFixture,
        "/repos/777genius/review-router-saas/branches/main": {
          protected: true,
          commit: { sha: "a".repeat(40) },
        },
      },
    ],
    [
      "a missing environment gate",
      {},
      {
        ...releaseFixture,
        "/repos/777genius/review-router-saas/environments/production-release": {
          protection_rules: [],
          deployment_branch_policy: { protected_branches: false },
        },
      },
    ],
  ])("rejects %s before checkout", (_name, override, fixture) => {
    const result = executeBootstrap(
      release,
      { ...releaseEnvironment, ...override },
      fixture,
    );
    expect(result.status).not.toBe(0);
    expect(result.githubOutput).toBeUndefined();
  });
});

describe("release-authority migration protected environment bootstrap", () => {
  it("accepts the exact protected main SHA only with the dedicated protected environment", () => {
    const result = executeBootstrap(
      authorityMigration,
      authorityMigrationEnvironment,
      authorityMigrationFixture,
    );
    expect(result.status).toBe(0);
    expect(result.githubOutput).toBe(`trusted_sha=${sha}\n`);
  });

  it.each([
    [
      "missing required reviewers",
      {
        protection_rules: [{ type: "branch_policy" }],
        deployment_branch_policy: { protected_branches: true },
      },
    ],
    [
      "missing self-review policy fact",
      {
        protection_rules: [
          { type: "required_reviewers", reviewers: [{ type: "Team", id: 1 }] },
          { type: "branch_policy" },
        ],
        deployment_branch_policy: { protected_branches: true },
      },
    ],
    [
      "unprotected branches",
      {
        ...protectedEnvironment,
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      },
    ],
  ])(
    "rejects %s before owner credentials can be exposed",
    (_name, environment) => {
      const result = executeBootstrap(
        authorityMigration,
        authorityMigrationEnvironment,
        {
          ...authorityMigrationFixture,
          "/repos/777genius/review-router-saas/environments/production-release-authority-migration":
            environment,
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.githubOutput).toBeUndefined();
      expect(result.stderr).toContain(
        "authority_migration_trust_rejected:environment_unprotected",
      );
    },
  );

  it("requires self-review prevention only in explicit independent mode", () => {
    const result = executeBootstrap(
      authorityMigration,
      {
        ...authorityMigrationEnvironment,
        REVIEW_ROUTER_RELEASE_APPROVAL_MODE: "independent",
      },
      authorityMigrationFixture,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "authority_migration_trust_rejected:environment_unprotected",
    );
  });

  it("fails closed and redacts credentials when the GitHub environment API fails", () => {
    const ownerCredential = "owner-database-credential-must-not-appear";
    const token = "github-token-must-not-appear";
    const result = executeBootstrap(
      authorityMigration,
      {
        ...authorityMigrationEnvironment,
        GH_TOKEN: token,
        REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL: ownerCredential,
      },
      {
        "/repos/777genius/review-router-saas/branches/main": {
          protected: true,
          commit: { sha },
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.githubOutput).toBeUndefined();
    expect(`${result.stdout}${result.stderr}`).toContain(
      "authority_migration_trust_rejected:github_api_404",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(`${result.stdout}${result.stderr}`).not.toContain(ownerCredential);
  });
});

describe("PG17 workflow immutable trust bootstrap", () => {
  it("binds expected SHA and exact release coordinates to protected main", () => {
    const result = executeBootstrap(
      rollout,
      rolloutEnvironment,
      rolloutFixture,
    );
    expect(result.status).toBe(0);
    expect(result.githubOutput).toBe(
      `trusted_sha=${sha}\nrelease_run_id=7001\nrelease_artifact_id=8001\n`,
    );
  });

  it.each([
    [
      "a malicious non-main workflow ref",
      { GITHUB_REF: "refs/heads/attacker" },
      rolloutFixture,
    ],
    [
      "a mismatched expected SHA",
      { EXPECTED_SHA: "b".repeat(40) },
      rolloutFixture,
    ],
    [
      "stale protected main",
      {},
      {
        ...rolloutFixture,
        "/repos/777genius/review-router-saas/branches/main": {
          protected: true,
          commit: { sha: "c".repeat(40) },
        },
      },
    ],
    [
      "a release artifact from another SHA",
      {},
      {
        ...rolloutFixture,
        "/repos/777genius/review-router-saas/actions/artifacts/8001": {
          id: 8001,
          expired: false,
          name: "hosted-runtime-image-v1.2.3",
          workflow_run: { id: 7001, head_sha: "d".repeat(40) },
        },
      },
    ],
  ])("rejects %s before checkout", (_name, override, fixture) => {
    const result = executeBootstrap(
      rollout,
      { ...rolloutEnvironment, ...override },
      fixture,
    );
    expect(result.status).not.toBe(0);
    expect(result.githubOutput).toBeUndefined();
  });
});

describe("privileged workflow structure", () => {
  it("keeps trust jobs repository-independent and permissions read-only", () => {
    for (const source of [release, rollout, authorityMigration]) {
      const trust = jobs(source).find((job) =>
        job.startsWith("  trust-bootstrap:"),
      );
      expect(trust).toBeDefined();
      expect(trust).toContain("contents: read");
      expect(trust).not.toMatch(
        /(?:contents|actions|packages|attestations|id-token): write/u,
      );
      expect(trust).not.toContain("actions/checkout@");
      expect(trust).not.toContain("uses:");
      expect(trust).not.toContain("secrets.");
      expect(trust).not.toMatch(/pnpm|scripts\//u);
    }
  });

  it("keeps migration owner credentials exclusively after the trust dependency", () => {
    const authorityJobs = jobs(authorityMigration);
    const trust = authorityJobs.find((job) =>
      job.startsWith("  trust-bootstrap:"),
    );
    const mutation = authorityJobs.find((job) =>
      job.startsWith("  trusted-release-authority-migration:"),
    );
    expect(trust).not.toContain("secrets.");
    expect(trust).not.toContain(
      "REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL",
    );
    expect(mutation).toContain(
      "needs: [trust-bootstrap, verify-release-gate-evidence]",
    );
    expect(mutation).toContain(
      "secrets.REVIEW_ROUTER_RELEASE_AUTHORITY_BOOTSTRAP_DATABASE_URL",
    );
    expect(mutation).toContain(
      "secrets.REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL",
    );
    expect(mutation).not.toContain(
      "secrets.REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL",
    );
  });

  it("checks out only verified output SHAs without persisted credentials", () => {
    for (const source of [release, rollout]) {
      const checkoutCount =
        source.match(/uses: actions\/checkout@/gu)?.length ?? 0;
      expect(source.match(/persist-credentials: false/gu)?.length).toBe(
        checkoutCount,
      );
      expect(
        source.match(/ref: .*needs\.trust-bootstrap\.outputs\.trusted_sha/gu)
          ?.length,
      ).toBe(checkoutCount);
    }
    expect(rollout.match(/ref:.*inputs\.expected_sha/gu)).toBeNull();
  });

  it("gates every post-bootstrap job and grants permissions per job", () => {
    for (const source of [release, rollout]) {
      expect(source).toContain("permissions: {}");
      for (const job of jobs(source).filter(
        (block) => !block.startsWith("  trust-bootstrap:"),
      )) {
        expect(job).toContain("environment: production");
        expect(job).toContain("needs:");
        expect(job).toContain("trust-bootstrap");
        expect(job).toContain("permissions:");
      }
    }
  });

  it("limits write, package, and OIDC authority to dedicated release jobs", () => {
    const releaseJobs = jobs(release);
    expect(
      releaseJobs
        .filter((job) => job.includes("contents: write"))
        .map((job) => /^ {2}([a-z0-9-]+):/u.exec(job)?.[1]),
    ).toEqual(["release"]);
    expect(
      releaseJobs
        .filter((job) => job.includes("packages: write"))
        .map((job) => /^ {2}([a-z0-9-]+):/u.exec(job)?.[1]),
    ).toEqual(["publish-runtime"]);
    expect(
      releaseJobs
        .filter((job) => job.includes("id-token: write"))
        .map((job) => /^ {2}([a-z0-9-]+):/u.exec(job)?.[1]),
    ).toEqual(["attest-runtime"]);
    expect(rollout).not.toMatch(
      /(?:actions|attestations|contents|id-token|packages): write/u,
    );
  });

  it("keeps production secrets on their exact post-trust execution steps", () => {
    const prepare = jobs(release).find((job) =>
      job.startsWith("  prepare-release:"),
    );
    const runtime = jobs(release).find((job) =>
      job.startsWith("  publish-runtime:"),
    );
    const attestation = jobs(release).find((job) =>
      job.startsWith("  attest-runtime:"),
    );
    const publication = jobs(release).find((job) =>
      job.startsWith("  release:"),
    );
    expect(prepare).not.toContain("secrets.");
    expect(attestation).not.toContain("secrets.");
    expect(
      runtime?.match(/secrets\.SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64/gu),
    ).toHaveLength(1);
    expect(publication?.match(/secrets\.RENDER_API_KEY/gu)).toHaveLength(2);
  });

  it("consumes raw SHA and release coordinates only inside rollout trust", () => {
    const trust = jobs(rollout).find((job) =>
      job.startsWith("  trust-bootstrap:"),
    );
    expect(rollout.match(/inputs\.expected_sha/gu)).toHaveLength(1);
    expect(rollout.match(/inputs\.release_run_id/gu)).toHaveLength(1);
    expect(rollout.match(/inputs\.release_artifact_id/gu)).toHaveLength(1);
    expect(trust).toContain("EXPECTED_SHA: ${{ inputs.expected_sha }}");
    expect(trust).toContain("RELEASE_RUN_ID: ${{ inputs.release_run_id }}");
    expect(trust).toContain(
      "RELEASE_ARTIFACT_ID: ${{ inputs.release_artifact_id }}",
    );
  });

  it("runs reconciliation only after successful trust and protected preflight", () => {
    const reconcile = jobs(rollout).find((job) =>
      job.startsWith("  always-reconcile:"),
    );
    expect(reconcile).toContain("needs.trust-bootstrap.result == 'success'");
    expect(reconcile).toContain(
      "needs.protected-preflight.result == 'success'",
    );
    const eligible = (trust: string, preflight: string) =>
      trust === "success" && preflight === "success";
    expect(eligible("failure", "skipped")).toBe(false);
    expect(eligible("success", "failure")).toBe(false);
    expect(eligible("success", "skipped")).toBe(false);
    expect(eligible("success", "success")).toBe(true);
  });
});
