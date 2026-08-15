import { describe, expect, it } from "vitest";
import {
  activateInvocationBackup,
  admitRelayRequest,
  bindRepositoryToHostedPool,
  classifyFailoverEligibility,
  consumeCommentTokenRefreshCapability,
  consumeHostedCommentTokenRefreshCapability,
  coolDownHostedAccount,
  createDefaultHostedAccountPool,
  enrollHostedPoolAccount,
  failoverCurrentRelayRequest,
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  invocationGrantId,
  invocationId,
  importAndEnrollHostedCodexAccount,
  issueInvocationGrant,
  issueHostedPoolInvocationGrant,
  pauseHostedAccount,
  quarantineHostedAccount,
  recordProviderRequestFailure,
  recordProviderResponseStarted,
  recordSuccessfulProviderResponse,
  relayRequestId,
  replaceHostedAccountCredential,
  revokeCommentTokenRefreshCapability,
  repositoryId,
  transitionHostedPoolBindingStatus,
  workspaceId,
  type HostedPoolAccount,
  type InvocationGrant,
} from "../index";

const now = new Date("2026-08-15T10:00:00.000Z");
const poolId = hostedPoolId("pool-1");
const workspace = workspaceId("workspace-1");
const repository = repositoryId("repository-1");

describe("hosted account pool domain", () => {
  it("creates the one workspace-default pool and an explicit repository binding", () => {
    const pool = createDefaultHostedAccountPool({
      id: poolId,
      workspaceId: workspace,
      now,
    });

    expect(pool).toMatchObject({ isDefault: true, status: "active" });
    expect(
      bindRepositoryToHostedPool({
        id: hostedBindingId("binding-1"),
        repositoryId: repository,
        workspaceId: workspace,
        pool,
        now,
      }),
    ).toMatchObject({
      repositoryId: repository,
      poolId,
      authMode: "codex_subscription_oauth_hosted_pool",
    });
  });

  it("rejects cross-workspace repository binding", () => {
    const pool = createDefaultHostedAccountPool({
      id: poolId,
      workspaceId: workspace,
      now,
    });
    expect(() =>
      bindRepositoryToHostedPool({
        id: hostedBindingId("binding-1"),
        repositoryId: repository,
        workspaceId: workspaceId("different"),
        pool,
        now,
      }),
    ).toThrow("hosted_pool_workspace_mismatch");
  });

  it("activates a merged binding without changing its workflow revision", () => {
    const pool = createDefaultHostedAccountPool({
      id: poolId,
      workspaceId: workspace,
      now,
    });
    const pending = bindRepositoryToHostedPool({
      id: hostedBindingId("binding-activation"),
      repositoryId: repository,
      workspaceId: workspace,
      pool,
      now,
    });
    const active = transitionHostedPoolBindingStatus({
      binding: pending,
      status: "active",
      expectedRevision: pending.revision,
      expectedStateVersion: pending.stateVersion,
      now: new Date("2026-08-15T10:01:00.000Z"),
    });
    expect(active.status).toBe("active");
    expect(active.revision).toBe(pending.revision);
    expect(active.stateVersion).toBe(pending.stateVersion + 1);
    expect(active.attestedBindingRevision).toBe(active.revision);
  });

  it("re-enables a draining binding as pending and clears stale evidence", () => {
    const pool = createDefaultHostedAccountPool({
      id: poolId,
      workspaceId: workspace,
      now,
    });
    const pending = bindRepositoryToHostedPool({
      id: hostedBindingId("binding-reenable"),
      repositoryId: repository,
      workspaceId: workspace,
      pool,
      now,
    });
    const active = transitionHostedPoolBindingStatus({
      binding: pending,
      status: "active",
      expectedRevision: pending.revision,
      expectedStateVersion: pending.stateVersion,
      now: new Date("2026-08-15T10:01:00.000Z"),
    });
    const draining = transitionHostedPoolBindingStatus({
      binding: active,
      status: "draining",
      expectedRevision: active.revision,
      expectedStateVersion: active.stateVersion,
      now: new Date("2026-08-15T10:02:00.000Z"),
    });
    const rebound = bindRepositoryToHostedPool({
      id: draining.bindingId,
      repositoryId: repository,
      workspaceId: workspace,
      pool,
      currentBinding: draining,
      now: new Date("2026-08-15T10:03:00.000Z"),
    });
    expect(rebound).toMatchObject({
      status: "pending_activation",
      revision: draining.revision + 1,
      stateVersion: draining.stateVersion + 1,
      attestedBindingRevision: null,
      activatedAt: null,
      drainingAt: null,
    });
  });

  it("stores only opaque credential metadata and exposes no execution slots", () => {
    const account = accountFixture("account-1", 1);
    expect(account.credential).toEqual({
      credentialRef: "ar:credential:account-1:1",
      subjectFingerprint: "subject-account-1",
      authGeneration: 1,
      validatedAt: now,
      expiresAt: new Date("2026-08-16T10:00:00.000Z"),
    });
    expect("accessToken" in account.credential).toBe(false);
    expect("refreshToken" in account.credential).toBe(false);
    expect("authJson" in account.credential).toBe(false);
    expect("executionSlots" in account).toBe(false);
  });

  it("replaces credential metadata with an auth-generation CAS", () => {
    const account = accountFixture("account-1", 1);
    const replacement = replaceHostedAccountCredential({
      account,
      expectedAuthGeneration: 1,
      credential: {
        ...account.credential,
        credentialRef: "ar:credential:account-1:2",
        authGeneration: 2,
        validatedAt: new Date("2026-08-15T10:05:00.000Z"),
      },
      now: new Date("2026-08-15T10:05:00.000Z"),
    });
    expect(replacement.credential.authGeneration).toBe(2);
    expect(() =>
      replaceHostedAccountCredential({
        account: replacement,
        expectedAuthGeneration: 1,
        credential: replacement.credential,
        now,
      }),
    ).toThrow("hosted_account_auth_generation_conflict");
  });

  it("rejects credential replacement for a different account subject", () => {
    const account = accountFixture("account-1", 1);
    expect(() =>
      replaceHostedAccountCredential({
        account,
        expectedAuthGeneration: 1,
        credential: {
          ...account.credential,
          subjectFingerprint: "different-subject",
          authGeneration: 2,
        },
        now,
      }),
    ).toThrow("hosted_account_subject_mismatch");
  });

  it("supports pause, quarantine, cooldown, and explicit recovery", () => {
    const account = accountFixture("account-1", 1);
    expect(
      pauseHostedAccount(account, "operator", now).availability.status,
    ).toBe("paused");
    expect(
      quarantineHostedAccount(account, "credential_invalid", now).availability
        .status,
    ).toBe("quarantined");
    const cooled = coolDownHostedAccount(account, {
      reason: "rate_limited",
      now,
      until: new Date("2026-08-15T10:01:00.000Z"),
    });
    expect(cooled.availability.status).toBe("cooldown");
  });
});

describe("hosted credential enrollment boundary", () => {
  it("passes raw auth bytes only to custody and returns a safe account summary", async () => {
    const authJsonBytes = new Uint8Array([123, 34, 120, 34, 58, 49, 125]);
    let custodyInput: Uint8Array | null = null;

    const result = await importAndEnrollHostedCodexAccount(
      {
        accountId: hostedAccountId("imported"),
        poolId,
        workspaceId: workspace,
        label: "Primary subscription",
        priority: 0,
        expectedPoolRevision: 1,
        authJsonBytes,
        requestedAt: now,
      },
      {
        credentialEnrollment: {
          async importCodexAuth(input) {
            custodyInput = input.authJsonBytes;
            return {
              id: input.accountId,
              label: input.label,
              priority: input.priority,
              availability: { status: "healthy" },
              healthVersion: 1,
              authGeneration: 1,
              validatedAt: now,
              credentialExpiresAt: null,
              refreshDue: false,
              createdAt: now,
              updatedAt: now,
            };
          },
        },
      },
    );

    expect(custodyInput).toBe(authJsonBytes);
    expect(result).toMatchObject({
      label: "Primary subscription",
      priority: 0,
      authGeneration: 1,
    });
    expect("credentialRef" in result).toBe(false);
    expect("authJsonBytes" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain("fingerprint");
  });
});

describe("invocation-bounded relay grant", () => {
  it("persists only the capability hash and returns plaintext once", async () => {
    let stored: InvocationGrant | null = null;
    const authority = grantAuthorityFixture(0);
    const result = await issueHostedPoolInvocationGrant(
      {
        id: invocationGrantId("grant-issued"),
        invocationId: invocationId("invocation-issued"),
        repositoryId: repository,
        workspaceId: workspace,
        authority,
        budget: {
          expiresAt: new Date("2026-08-15T11:00:00.000Z"),
          maxRequests: 10,
          maxConcurrentRequests: 3,
          maxRequestBytes: 1024,
        },
        commentRefreshBudget: {
          expiresAt: new Date("2026-08-15T10:30:00.000Z"),
          maxUses: 2,
        },
        now,
      },
      {
        pools: {
          async findDefaultByWorkspaceId() {
            return null;
          },
          async findById() {
            return createDefaultHostedAccountPool({
              id: poolId,
              workspaceId: workspace,
              now,
            });
          },
          async insertDefault(value) {
            return value;
          },
          async advanceRevision() {
            return null;
          },
        },
        bindings: {
          async findByRepositoryId() {
            return {
              bindingId: hostedBindingId("binding-1"),
              repositoryId: repository,
              workspaceId: workspace,
              poolId,
              authMode: "codex_subscription_oauth_hosted_pool" as const,
              status: "active" as const,
              revision: 1,
              stateVersion: 2,
              attestedBindingRevision: 1,
              activatedAt: now,
              drainingAt: null,
              boundAt: now,
              updatedAt: now,
            };
          },
          async save() {
            return true;
          },
        },
        accounts: {
          async findById() {
            return null;
          },
          async findBySubjectFingerprint() {
            return null;
          },
          async listByPoolId() {
            return [accountFixture("primary", 0)];
          },
          async replaceCredential() {
            return false;
          },
          async saveAvailability() {
            return true;
          },
        },
        grants: {
          async findByInvocationId() {
            return null;
          },
          async insert(grant) {
            stored = grant;
          },
          async mutate(_grantId, transition) {
            if (!stored) throw new Error("missing grant");
            stored = transition(stored);
            return stored;
          },
        },
        capabilities: {
          async issue(input) {
            expect(input.repositoryBindingId).toBe(
              hostedBindingId("binding-1"),
            );
            return {
              plaintextToken: "plaintext-capability-token",
              tokenHash: "sha256:persisted-capability-hash",
            };
          },
        },
        commentRefreshCapabilities: {
          async issue(input) {
            expect(input.repositoryBindingId).toBe(
              hostedBindingId("binding-1"),
            );
            return {
              plaintextToken: "plaintext-comment-refresh-token",
              tokenHash: "sha256:comment-refresh-token-hash",
            };
          },
          async consume() {
            throw new Error("not used");
          },
          async revoke() {
            throw new Error("not used");
          },
        },
      },
    );

    expect(result.plaintextToken).toBe("plaintext-capability-token");
    expect(result.commentRefreshPlaintextToken).toBe(
      "plaintext-comment-refresh-token",
    );
    expect(result.grant).toBe(stored);
    expect(result.grant.capabilityTokenHash).toBe(
      "sha256:persisted-capability-hash",
    );
    expect(stored).not.toHaveProperty("plaintextToken");
    expect(result.grant.commentTokenRefreshCapability).toMatchObject({
      tokenHash: "sha256:comment-refresh-token-hash",
      useCount: 0,
      maxUses: 2,
      repositoryBindingId: hostedBindingId("binding-1"),
    });
    expect("tokenHash" in result).toBe(false);
  });

  it("selects the lowest priority number with a stable created-at/id tie break", () => {
    const later = accountFixture("account-z", 1, "2026-08-15T09:01:00.000Z");
    const earlierB = accountFixture("account-b", 1, "2026-08-15T09:00:00.000Z");
    const earlierA = accountFixture("account-a", 1, "2026-08-15T09:00:00.000Z");
    const lowerPreference = accountFixture("priority-two", 2);
    const grant = grantFixture([later, lowerPreference, earlierB, earlierA]);

    expect(grant.primaryAccountId).toBe(hostedAccountId("account-a"));
    expect(grant.backupAccountId).toBe(hostedAccountId("account-b"));
  });

  it("issues at most one backup", () => {
    const grant = grantFixture([
      accountFixture("a", 0),
      accountFixture("b", 1),
      accountFixture("c", 2),
    ]);
    expect(grant.backupAccountId).toBe(hostedAccountId("b"));
    expect(
      Object.keys(grant).filter((key) => key.toLowerCase().includes("backup")),
    ).toEqual(["backupAccountId", "backupActivated"]);
  });

  it("keeps account binding sticky across relay requests", () => {
    let grant = grantFixture([
      accountFixture("primary", 0),
      accountFixture("backup", 1),
    ]);
    const first = admitRelayRequest({
      grant,
      requestId: relayRequestId("r1"),
      authority: grant.authority,
      requestBytes: 128,
      now,
    });
    grant = first.grant;
    const second = admitRelayRequest({
      grant,
      requestId: relayRequestId("r2"),
      authority: grant.authority,
      requestBytes: 128,
      now,
    });
    expect(first.status).toBe("admitted");
    expect(second.status).toBe("admitted");
    if (first.status === "admitted" && second.status === "admitted") {
      expect(first.accountId).toBe(second.accountId);
    }
  });

  it("admits 12 concurrent invocations to one account without an account lease", () => {
    const sharedAccount = accountFixture("shared", 0);
    const admissions = Array.from({ length: 12 }, (_, index) => {
      const grant = grantFixture([sharedAccount], index);
      return admitRelayRequest({
        grant,
        requestId: relayRequestId(`request-${index}`),
        authority: grant.authority,
        requestBytes: 128,
        now,
      });
    });
    expect(admissions).toHaveLength(12);
    expect(
      admissions.every((admission) => admission.status === "admitted"),
    ).toBe(true);
    expect(
      admissions.every(
        (admission) =>
          admission.status !== "admitted" ||
          admission.accountId === sharedAccount.id,
      ),
    ).toBe(true);
  });

  it("applies request and concurrency budgets per invocation grant", () => {
    let grant = grantFixture([accountFixture("shared", 0)], 0, {
      maxRequests: 2,
      maxConcurrentRequests: 1,
    });
    const first = admitRelayRequest({
      grant,
      requestId: relayRequestId("r1"),
      authority: grant.authority,
      requestBytes: 128,
      now,
    });
    grant = first.grant;
    expect(
      admitRelayRequest({
        grant,
        requestId: relayRequestId("r2"),
        authority: grant.authority,
        requestBytes: 128,
        now,
      }).status,
    ).toBe("concurrency_budget_exhausted");
    grant = recordSuccessfulProviderResponse({
      grant,
      requestId: relayRequestId("r1"),
    });
    const second = admitRelayRequest({
      grant,
      requestId: relayRequestId("r2"),
      authority: grant.authority,
      requestBytes: 128,
      now,
    });
    grant = second.grant;
    grant = recordSuccessfulProviderResponse({
      grant,
      requestId: relayRequestId("r2"),
    });
    expect(
      admitRelayRequest({
        grant,
        requestId: relayRequestId("r3"),
        authority: grant.authority,
        requestBytes: 128,
        now,
      }).status,
    ).toBe("request_budget_exhausted");
  });

  it("rejects a request larger than the invocation byte budget", () => {
    const grant = grantFixture([accountFixture("shared", 0)], 0, {
      maxRequests: 2,
      maxConcurrentRequests: 1,
      maxRequestBytes: 256,
    });
    const admission = admitRelayRequest({
      grant,
      requestId: relayRequestId("oversized"),
      authority: grant.authority,
      requestBytes: 257,
      now,
    });
    expect(admission.status).toBe("request_bytes_exceeded");
    expect(admission.grant.admittedRequestIds).toEqual([]);
  });

  it("bounds comment refresh capability by expiry, use budget, and revocation", () => {
    let grant = grantFixture([accountFixture("shared", 0)]);
    const first = consumeCommentTokenRefreshCapability({
      grant,
      now: new Date("2026-08-15T10:10:00.000Z"),
    });
    expect(first.status).toBe("consumed");
    grant = first.grant;
    const second = consumeCommentTokenRefreshCapability({
      grant,
      now: new Date("2026-08-15T10:11:00.000Z"),
    });
    expect(second.status).toBe("consumed");
    expect(
      consumeCommentTokenRefreshCapability({
        grant: second.grant,
        now: new Date("2026-08-15T10:12:00.000Z"),
      }).status,
    ).toBe("budget_exhausted");
    expect(
      consumeCommentTokenRefreshCapability({
        grant: grantFixture([accountFixture("expiry", 0)]),
        now: new Date("2026-08-15T10:30:00.000Z"),
      }).status,
    ).toBe("expired");
    const revoked = revokeCommentTokenRefreshCapability({
      grant: grantFixture([accountFixture("revoked", 0)]),
      revokedAt: new Date("2026-08-15T10:05:00.000Z"),
    });
    expect(
      consumeCommentTokenRefreshCapability({
        grant: revoked,
        now: new Date("2026-08-15T10:06:00.000Z"),
      }).status,
    ).toBe("revoked");
  });

  it("replays a comment refresh idempotency key without consuming another use", async () => {
    let stored = grantFixture([accountFixture("replay", 0)]);
    const seen = new Set<string>();
    const capabilities = {
      async issue() {
        throw new Error("not used");
      },
      async consume(
        input: Parameters<
          import("../index").CommentTokenRefreshCapabilityPort["consume"]
        >[0],
      ) {
        if (seen.has(input.requestIdHash)) {
          return { status: "replayed" as const, grant: stored };
        }
        seen.add(input.requestIdHash);
        const result = input.transition(stored);
        stored = result.grant;
        return result;
      },
      async revoke() {
        throw new Error("not used");
      },
    };
    const input = {
      grantId: stored.id,
      presentedTokenHash: "a".repeat(64),
      requestIdHash: "b".repeat(64),
      now: new Date("2026-08-15T10:10:00.000Z"),
    };
    expect(
      (await consumeHostedCommentTokenRefreshCapability(input, capabilities))
        .status,
    ).toBe("consumed");
    expect(
      (await consumeHostedCommentTokenRefreshCapability(input, capabilities))
        .status,
    ).toBe("replayed");
    expect(stored.commentTokenRefreshCapability.useCount).toBe(1);
  });

  it("makes repeated request admission idempotent", () => {
    const grant = grantFixture([accountFixture("shared", 0)]);
    const first = admitRelayRequest({
      grant,
      requestId: relayRequestId("same"),
      authority: grant.authority,
      requestBytes: 128,
      now,
    });
    const repeated = admitRelayRequest({
      grant: first.grant,
      requestId: relayRequestId("same"),
      authority: grant.authority,
      requestBytes: 128,
      now,
    });
    expect(repeated.status).toBe("already_admitted");
    expect(repeated.grant.admittedRequestIds).toHaveLength(1);
  });

  it("rejects relay evidence from a different invocation trust domain", () => {
    const grant = grantFixture([accountFixture("shared", 0)]);
    expect(() =>
      admitRelayRequest({
        grant,
        requestId: relayRequestId("r1"),
        authority: { ...grant.authority, runAttempt: 2 },
        requestBytes: 128,
        now,
      }),
    ).toThrow("invocation_grant_authority_mismatch");
    expect(() =>
      admitRelayRequest({
        grant,
        requestId: relayRequestId("r2"),
        authority: {
          ...grant.authority,
          runtimeConfigVersion: grant.authority.runtimeConfigVersion + 1,
        },
        requestBytes: 128,
        now,
      }),
    ).toThrow("invocation_grant_authority_mismatch");
  });

  it("rejects a comment refresh capability for another binding", () => {
    expect(() =>
      issueInvocationGrant({
        id: invocationGrantId("scope-grant"),
        invocationId: invocationId("scope-invocation"),
        repositoryId: repository,
        workspaceId: workspace,
        poolId,
        accounts: [accountFixture("scope", 0)],
        authority: grantAuthorityFixture(91),
        capabilityTokenHash: "sha256:scope-relay-capability",
        commentTokenRefreshCapability: {
          tokenHash: "sha256:scope-comment-capability",
          grantId: invocationGrantId("scope-grant"),
          invocationId: invocationId("scope-invocation"),
          repositoryBindingId: hostedBindingId("different-binding"),
          expiresAt: new Date("2026-08-15T10:30:00.000Z"),
          maxUses: 1,
          useCount: 0,
          revokedAt: null,
        },
        budget: {
          expiresAt: new Date("2026-08-15T11:00:00.000Z"),
          maxRequests: 10,
          maxConcurrentRequests: 2,
          maxRequestBytes: 1024,
        },
        now,
      }),
    ).toThrow("comment_refresh_capability_scope_mismatch");
  });

  it("permits one failover before the first successful provider response", () => {
    let grant = grantFixture([
      accountFixture("primary", 0),
      accountFixture("backup", 1),
    ]);
    const admitted = admitRelayRequest({
      grant,
      requestId: relayRequestId("r1"),
      authority: grant.authority,
      requestBytes: 128,
      now,
    });
    grant = recordProviderRequestFailure({
      grant: admitted.grant,
      requestId: relayRequestId("r1"),
    });
    const eligibility = classifyFailoverEligibility({
      grant,
      failure: "rate_limited",
      effectFence: "before_refresh_or_upstream_effect",
    });
    grant = activateInvocationBackup({ grant, eligibility });
    expect(grant.activeAccountId).toBe(hostedAccountId("backup"));
    expect(grant.backupActivated).toBe(true);
    expect(
      classifyFailoverEligibility({
        grant,
        failure: "rate_limited",
        effectFence: "before_refresh_or_upstream_effect",
      }).reason,
    ).toBe("already_failed_over");
  });

  it("fails over the current pre-effect request without completing it", () => {
    const primary = accountFixture("current-primary", 0);
    const backup = accountFixture("current-backup", 1);
    let grant = grantFixture([primary, backup]);
    const requestId = relayRequestId("current-request");
    grant = admitRelayRequest({
      grant,
      requestId,
      authority: grant.authority,
      requestBytes: 128,
      now,
    }).grant;
    const switched = failoverCurrentRelayRequest({
      grant,
      requestId,
      failedAccount: primary,
      backupAccount: backup,
      failure: "rate_limited",
      effectFence: "before_refresh_or_upstream_effect",
      cooldownUntil: new Date("2026-08-15T10:05:00.000Z"),
      now,
    });
    expect(switched.status).toBe("switched");
    expect(switched.grant.activeAccountId).toBe(backup.id);
    expect(switched.grant.failoverCount).toBe(1);
    expect(switched.grant.inFlightRequestIds).toContain(requestId);
    expect(switched.failedAccount.availability.status).toBe("cooldown");

    const repeated = failoverCurrentRelayRequest({
      grant: switched.grant,
      requestId,
      failedAccount: backup,
      backupAccount: backup,
      failure: "rate_limited",
      effectFence: "before_refresh_or_upstream_effect",
      cooldownUntil: new Date("2026-08-15T10:06:00.000Z"),
      now,
    });
    expect(repeated.status).toBe("denied");
    if (repeated.status === "denied") {
      expect(repeated.reason).toBe("already_failed_over");
    }
    expect(repeated.grant.failoverCount).toBe(1);
  });

  it("denies current-request failover after response start", () => {
    const primary = accountFixture("started-primary", 0);
    const backup = accountFixture("started-backup", 1);
    let grant = grantFixture([primary, backup]);
    const requestId = relayRequestId("started-request");
    grant = admitRelayRequest({
      grant,
      requestId,
      authority: grant.authority,
      requestBytes: 128,
      now,
    }).grant;
    grant = recordProviderResponseStarted({ grant, requestId });
    const result = failoverCurrentRelayRequest({
      grant,
      requestId,
      failedAccount: primary,
      backupAccount: backup,
      failure: "credential_invalid",
      effectFence: "before_refresh_or_upstream_effect",
      cooldownUntil: null,
      now,
    });
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reason).toBe("successful_response_fence");
    }
  });

  it("allows unrelated grants to fail over concurrently without an account lease", () => {
    const primary = accountFixture("concurrent-primary", 0);
    const backup = accountFixture("concurrent-backup", 1);
    const results = [71, 72].map((suffix) => {
      let grant = grantFixture([primary, backup], suffix);
      const requestId = relayRequestId(`concurrent-${suffix}`);
      grant = admitRelayRequest({
        grant,
        requestId,
        authority: grant.authority,
        requestBytes: 128,
        now,
      }).grant;
      return failoverCurrentRelayRequest({
        grant,
        requestId,
        failedAccount: primary,
        backupAccount: backup,
        failure: "needs_reconnect",
        effectFence: "before_refresh_or_upstream_effect",
        cooldownUntil: null,
        now,
      });
    });
    expect(results.map((result) => result.status)).toEqual([
      "switched",
      "switched",
    ]);
    expect(results.every((result) => result.grant.failoverCount === 1)).toBe(
      true,
    );
  });

  it("fences failover forever after the first successful provider response", () => {
    let grant = grantFixture([
      accountFixture("primary", 0),
      accountFixture("backup", 1),
    ]);
    const admitted = admitRelayRequest({
      grant,
      requestId: relayRequestId("r1"),
      authority: grant.authority,
      requestBytes: 128,
      now,
    });
    grant = recordSuccessfulProviderResponse({
      grant: admitted.grant,
      requestId: relayRequestId("r1"),
    });
    expect(
      classifyFailoverEligibility({
        grant,
        failure: "credential_invalid",
        effectFence: "before_refresh_or_upstream_effect",
      }),
    ).toEqual({
      eligible: false,
      reason: "successful_response_fence",
      accountDisposition: "none",
    });
  });

  it("fences failover as soon as upstream response starts", () => {
    let grant = grantFixture([
      accountFixture("primary", 0),
      accountFixture("backup", 1),
    ]);
    const admitted = admitRelayRequest({
      grant,
      requestId: relayRequestId("response-started"),
      authority: grant.authority,
      requestBytes: 128,
      now,
    });
    grant = recordProviderResponseStarted({
      grant: admitted.grant,
      requestId: relayRequestId("response-started"),
    });
    expect(
      classifyFailoverEligibility({
        grant,
        failure: "rate_limited",
        effectFence: "before_refresh_or_upstream_effect",
      }).reason,
    ).toBe("successful_response_fence");
  });

  it("uses AR classification without inspecting raw provider failures", () => {
    const grant = grantFixture([
      accountFixture("primary", 0),
      accountFixture("backup", 1),
    ]);
    expect(
      classifyFailoverEligibility({
        grant,
        failure: "credential_invalid",
        effectFence: "before_refresh_or_upstream_effect",
      }),
    ).toMatchObject({ eligible: true, accountDisposition: "quarantine" });
    expect(
      classifyFailoverEligibility({
        grant,
        failure: "rate_limited",
        effectFence: "before_refresh_or_upstream_effect",
      }),
    ).toMatchObject({ eligible: true, accountDisposition: "cooldown" });
    expect(
      classifyFailoverEligibility({
        grant,
        failure: "request_invalid",
        effectFence: "before_refresh_or_upstream_effect",
      }),
    ).toMatchObject({ eligible: false, accountDisposition: "none" });
  });

  it("rejects expired grants but leaves expired credentials eligible for lazy refresh", () => {
    const grant = grantFixture([accountFixture("primary", 0)]);
    expect(
      admitRelayRequest({
        grant,
        requestId: relayRequestId("late"),
        authority: grant.authority,
        requestBytes: 128,
        now: grant.budget.expiresAt,
      }).status,
    ).toBe("expired");
    const expired = {
      ...accountFixture("expired", 0),
      credential: {
        ...accountFixture("expired", 0).credential,
        expiresAt: new Date("2026-08-15T09:59:59.000Z"),
      },
    };
    expect(grantFixture([expired]).primaryAccountId).toBe(expired.id);
  });

  it("fails closed after refresh or upstream effects may have started", () => {
    const grant = grantFixture([
      accountFixture("primary", 0),
      accountFixture("backup", 1),
    ]);
    expect(
      classifyFailoverEligibility({
        grant,
        failure: "credential_refresh_failed",
        effectFence: "refresh_outcome_unknown",
      }),
    ).toEqual({
      eligible: false,
      reason: "not_failover_class",
      accountDisposition: "quarantine",
    });
    expect(
      classifyFailoverEligibility({
        grant,
        failure: "rate_limited",
        effectFence: "upstream_effect_started",
      }).eligible,
    ).toBe(false);
  });
});

function accountFixture(
  id: string,
  priority: number,
  createdAt = "2026-08-15T09:00:00.000Z",
): HostedPoolAccount {
  return enrollHostedPoolAccount({
    id: hostedAccountId(id),
    poolId,
    label: `Account ${id}`,
    priority,
    credential: {
      credentialRef: `ar:credential:${id}:1`,
      subjectFingerprint: `subject-${id}`,
      authGeneration: 1,
      validatedAt: now,
      expiresAt: new Date("2026-08-16T10:00:00.000Z"),
    },
    now: new Date(createdAt),
  });
}

function grantFixture(
  accounts: readonly HostedPoolAccount[],
  suffix = 0,
  budget: {
    readonly maxRequests: number;
    readonly maxConcurrentRequests: number;
    readonly maxRequestBytes?: number;
  } = {
    maxRequests: 100,
    maxConcurrentRequests: 100,
  },
) {
  return issueInvocationGrant({
    id: invocationGrantId(`grant-${suffix}`),
    invocationId: invocationId(`invocation-${suffix}`),
    repositoryId: repository,
    workspaceId: workspace,
    poolId,
    accounts,
    authority: grantAuthorityFixture(suffix),
    capabilityTokenHash: "sha256:fixture-capability-token-hash",
    commentTokenRefreshCapability: {
      tokenHash: "sha256:fixture-comment-refresh-hash",
      grantId: invocationGrantId(`grant-${suffix}`),
      invocationId: invocationId(`invocation-${suffix}`),
      repositoryBindingId: hostedBindingId("binding-1"),
      expiresAt: new Date("2026-08-15T10:30:00.000Z"),
      maxUses: 2,
      useCount: 0,
      revokedAt: null,
    },
    budget: {
      expiresAt: new Date("2026-08-15T11:00:00.000Z"),
      maxRequestBytes: 1024,
      ...budget,
    },
    now,
  });
}

function grantAuthorityFixture(suffix: number) {
  return {
    repositoryBindingId: hostedBindingId("binding-1"),
    reviewRequestId: `review-request-${suffix}`,
    providerInvocationKey: `provider-invocation-${suffix}`,
    runId: `run-${suffix}`,
    runAttempt: 1,
    model: "gpt-5.6",
    policyFingerprint: "sha256:policy",
    runtimeConfigVersion: 1,
    bindingRevision: 1,
    authzEpoch: 1n,
  } as const;
}
