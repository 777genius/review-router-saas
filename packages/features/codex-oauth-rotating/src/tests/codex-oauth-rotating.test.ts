import { describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers";
import {
  buildCodexRefreshBootstrapPlan,
  buildCodexRotatingSetupManifest,
  buildSafeCheckoutPlan,
  classifyCodexRuntimeFailure,
  codexRotatingOidcClaimsSchema,
  codexRotatingAuthMode,
  codexRotatingSecretName,
  computeCodexAuthGenerationHash,
  computeEncryptedPayloadDigest,
  decodeCodexRotatingSetupManifest,
  encodeCodexRotatingSetupManifest,
  encryptCodexRotatingAuthForGitHubSecret,
  InMemoryCodexRotatingLeaseStore,
  parseCodexRotatingEncryptedWritebackRequest,
  pruneCodexRotatingChildEnv,
  renderCodexRotatingAdvisoryWorkflow,
  renderCodexRotatingInstallerCommand,
  scanCodexRotatingAdvisoryWorkflow,
  validateCodexAuthJsonBytes,
  validateCodexRotatingPrelease,
} from "../domain/codex-oauth-rotating";

const validAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "refresh-token",
    access_token: "access-token",
  },
  last_refresh: "2026-05-24T12:00:00.000Z",
});

describe("Codex rotating auth domain", () => {
  it("validates ChatGPT Codex auth and hashes exact bytes", () => {
    const result = validateCodexAuthJsonBytes({
      authJsonBytes: validAuthJson,
      now: new Date("2026-05-25T12:00:00.000Z"),
    });

    expect(result.parsed.auth_mode).toBe("chatgpt");
    expect(result.byteLength).toBe(Buffer.byteLength(validAuthJson, "utf8"));
    expect(result.exactBytesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.warnings).toEqual([]);
    expect(
      computeCodexAuthGenerationHash({
        authJsonBytes: validAuthJson,
        generationHashSalt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it("rejects malformed or oversized auth before writeback", () => {
    expect(() =>
      validateCodexAuthJsonBytes({
        authJsonBytes: JSON.stringify({ auth_mode: "api-key" }),
      }),
    ).toThrow();
    expect(() =>
      validateCodexAuthJsonBytes({
        authJsonBytes: `${validAuthJson}${" ".repeat(33 * 1024)}`,
      }),
    ).toThrow("codex_auth_json_too_large");
  });

  it("classifies Codex usage and credit limits as quota-limited", () => {
    expect(classifyCodexRuntimeFailure("You've hit your usage limit.")).toBe(
      "quota_limited",
    );
    expect(
      classifyCodexRuntimeFailure(
        "Visit https://chatgpt.com/codex/settings/usage to purchase more credits",
      ),
    ).toBe("quota_limited");
    expect(classifyCodexRuntimeFailure("invalid_grant refresh token")).toBe(
      "needs_reconnect",
    );
  });

  it("builds and encodes a repo-bound setup manifest", () => {
    const manifest = buildCodexRotatingSetupManifest({
      repositoryFullName: "777genius/agent-teams-ai",
      repositoryId: "123456",
      installerUrl: "https://reviewrouter.site/install/codex-rotating",
      installerVersion: "v1.2.3",
      installerSha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      now: new Date("2026-05-25T12:00:00.000Z"),
      generationHashSalt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      accountFingerprintSalt: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    const encoded = encodeCodexRotatingSetupManifest(manifest);
    expect(decodeCodexRotatingSetupManifest(encoded)).toEqual(manifest);
    expect(manifest.authMode).toBe(codexRotatingAuthMode);
    expect(manifest.secretName).toBe(codexRotatingSecretName);
  });

  it("renders installer command without raw curl pipe", () => {
    const manifest = buildCodexRotatingSetupManifest({
      repositoryFullName: "777genius/agent-teams-ai",
      installerUrl: "https://reviewrouter.site/install/codex-rotating",
      installerVersion: "v1.2.3",
      installerSha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      now: new Date("2026-05-25T12:00:00.000Z"),
    });
    const command = renderCodexRotatingInstallerCommand({ manifest });

    expect(command).toContain("curl -fsSL");
    expect(command).toContain("shasum -a 256");
    expect(command).toContain("sha256sum");
    expect(command).toContain("Installer SHA256 mismatch");
    expect(command).toContain("trap 'rm -f \"$tmp\"' EXIT");
    expect(command).toContain('bash "$tmp" --confirm-write');
    expect(command).not.toContain("| bash");
    expect(command).toContain(
      "REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64",
    );
  });

  it("renders server-backed setup nonce commands without embedding the manifest", () => {
    const manifest = buildCodexRotatingSetupManifest({
      repositoryFullName: "777genius/agent-teams-ai",
      installerUrl: "https://reviewrouter.site/install/codex-rotating",
      installerVersion: "v1.2.3",
      installerSha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      setupNonce: "stp:server-backed-nonce",
      providerInstanceId: "codex-rotating:123456",
      now: new Date("2026-05-25T12:00:00.000Z"),
    });
    const command = renderCodexRotatingInstallerCommand({
      manifest,
      setupManifestUrl:
        "https://reviewrouter.site/api/codex-rotating/setup-manifest",
      setupConfirmUrl:
        "https://reviewrouter.site/api/codex-rotating/setup-confirm",
    });

    expect(command).toContain("REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL");
    expect(command).toContain("REVIEW_ROUTER_CODEX_ROTATING_SETUP_NONCE");
    expect(command).toContain("REVIEW_ROUTER_CODEX_ROTATING_SETUP_CONFIRM_URL");
    expect(command).toContain(
      "REVIEW_ROUTER_CODEX_ROTATING_PROVIDER_INSTANCE_ID",
    );
    expect(command).not.toContain(
      "REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64",
    );
    expect(command).not.toContain("generationHashSalt");
  });

  it("renders an advisory-only workflow and scanner rejects hardened-only surfaces", () => {
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: "777genius/review-router@main",
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:777genius/agent-teams-ai",
    });

    expect(workflow).toContain("pull_request:");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("merge_group:");
    expect(workflow).not.toContain("actions/checkout");
    expect(workflow).not.toContain("run:");
    expect(workflow).toContain(
      `auth-json: \${{ secrets.${codexRotatingSecretName} }}`,
    );
    expect(workflow.match(/^\s+mode:\s+codex-oauth-rotating$/gm)).toHaveLength(
      1,
    );
    expect(scanCodexRotatingAdvisoryWorkflow(workflow)).toEqual({
      valid: true,
      errors: [],
    });

    const unsafe = `${workflow}\n  workflow_dispatch: {}\n`;
    expect(scanCodexRotatingAdvisoryWorkflow(unsafe).errors).toContain(
      "workflow_dispatch_not_allowed",
    );
  });

  it("validates OIDC prelease binding before auth input can be read", () => {
    const now = new Date("2026-05-25T12:00:00.000Z");
    const claims = {
      iss: "https://token.actions.githubusercontent.com",
      aud: "reviewrouter",
      repository: "777genius/agent-teams-ai",
      repository_id: "123456",
      repository_visibility: "private",
      event_name: "pull_request" as const,
      run_id: "9001",
      run_attempt: "1",
      workflow_ref:
        "777genius/agent-teams-ai/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
      workflow_sha: "0123456789abcdef0123456789abcdef01234567",
      actor: "belief",
      runner_environment: "github-hosted" as const,
      iat: Math.floor(now.getTime() / 1000) - 10,
      nbf: Math.floor(now.getTime() / 1000) - 20,
      exp: Math.floor(now.getTime() / 1000) + 120,
      jti: "jti-123456789",
    } as const;

    expect(
      codexRotatingOidcClaimsSchema.parse({
        ...claims,
        sub: "repo:777genius/agent-teams-ai:pull_request",
        repository_owner: "777genius",
        repository_owner_id: "123",
        job_workflow_ref:
          "777genius/agent-teams-ai/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
        job_workflow_sha: "0123456789abcdef0123456789abcdef01234567",
      }).repository_visibility,
    ).toBe("private");

    expect(
      validateCodexRotatingPrelease({
        claims,
        binding: {
          providerInstanceId: "codex-rotating:777genius/agent-teams-ai",
          repositoryFullName: "777genius/agent-teams-ai",
          githubRepositoryId: "123456",
          actionRef: "777genius/review-router@main",
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 1,
        },
        requestedProviderInstanceId: "codex-rotating:777genius/agent-teams-ai",
        requestedWorkflowSchemaVersion: 1,
        now,
      }),
    ).toEqual({
      leaseKey: "codex-rotating:777genius/agent-teams-ai:9001:1",
      runKey: "123456:9001:1",
    });

    expect(
      validateCodexRotatingPrelease({
        claims: {
          ...claims,
          repository_visibility: "public",
        },
        binding: {
          providerInstanceId: "codex-rotating:777genius/agent-teams-ai",
          repositoryFullName: "777genius/agent-teams-ai",
          githubRepositoryId: "123456",
          actionRef:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 1,
        },
        requestedProviderInstanceId: "codex-rotating:777genius/agent-teams-ai",
        requestedWorkflowSchemaVersion: 1,
        now,
      }),
    ).toEqual({
      leaseKey: "codex-rotating:777genius/agent-teams-ai:9001:1",
      runKey: "123456:9001:1",
    });

    expect(() =>
      validateCodexRotatingPrelease({
        claims: {
          ...claims,
          actor: "dependabot[bot]",
        },
        binding: {
          providerInstanceId: "codex-rotating:777genius/agent-teams-ai",
          repositoryFullName: "777genius/agent-teams-ai",
          githubRepositoryId: "123456",
          actionRef:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 1,
        },
        requestedProviderInstanceId: "codex-rotating:777genius/agent-teams-ai",
        requestedWorkflowSchemaVersion: 1,
        now,
      }),
    ).toThrow("dependabot_actor_not_allowed");

    expect(() =>
      validateCodexRotatingPrelease({
        claims: {
          ...claims,
          iat: Math.floor(now.getTime() / 1000) - 30,
          nbf: Math.floor(now.getTime() / 1000) - 30,
          exp: Math.floor(now.getTime() / 1000) + 570,
        },
        binding: {
          providerInstanceId: "codex-rotating:777genius/agent-teams-ai",
          repositoryFullName: "777genius/agent-teams-ai",
          githubRepositoryId: "123456",
          actionRef:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 1,
        },
        requestedProviderInstanceId: "codex-rotating:777genius/agent-teams-ai",
        requestedWorkflowSchemaVersion: 1,
        now,
      }),
    ).not.toThrow();

    expect(() =>
      validateCodexRotatingPrelease({
        claims: {
          ...claims,
          iat: Math.floor(now.getTime() / 1000) - 30,
          nbf: Math.floor(now.getTime() / 1000) - 30,
          exp: Math.floor(now.getTime() / 1000) + 700,
        },
        binding: {
          providerInstanceId: "codex-rotating:777genius/agent-teams-ai",
          repositoryFullName: "777genius/agent-teams-ai",
          githubRepositoryId: "123456",
          actionRef:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSchemaVersion: 1,
        },
        requestedProviderInstanceId: "codex-rotating:777genius/agent-teams-ai",
        requestedWorkflowSchemaVersion: 1,
        now,
      }),
    ).toThrow("oidc_token_lifetime_too_long");
  });

  it("serializes leases per provider instance", () => {
    const store = new InMemoryCodexRotatingLeaseStore();
    const now = new Date("2026-05-25T12:00:00.000Z");
    const first = store.acquire({
      providerInstanceId: "codex-rotating:repo",
      runId: "1",
      runAttempt: "1",
      now,
      ttlSeconds: 300,
    });
    const second = store.acquire({
      providerInstanceId: "codex-rotating:repo",
      runId: "2",
      runAttempt: "1",
      now,
      ttlSeconds: 300,
    });

    expect(first.status).toBe("preleased");
    expect(second.status).toBe("conflict");
    const finalized = store.finalize({
      leaseId: first.leaseId,
      restoredGenerationHash: "hash-1",
      nextGeneration: 2,
      now,
    });
    expect(finalized.status).toBe("finalized");
    expect(store.complete({ leaseId: first.leaseId, now }).status).toBe(
      "completed",
    );
  });

  it("accepts encrypted writeback and rejects plaintext-like payloads", () => {
    expect(
      parseCodexRotatingEncryptedWritebackRequest({
        protocolVersion: 1,
        leaseId: "lease:abc12345",
        providerInstanceId: "codex-rotating:repo",
        generation: 2,
        latestGenerationHash: "hashhashhashhashhashhashhashhashhash",
        encryptedValue: Buffer.from("ciphertext").toString("base64"),
        keyId: "012345",
        idempotencyKey: "idem:abc12345",
      }).keyId,
    ).toBe("012345");
    expect(
      computeEncryptedPayloadDigest({
        encryptedValue: Buffer.from("ciphertext").toString("base64"),
        hmacKey: "secret",
      }),
    ).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(() =>
      parseCodexRotatingEncryptedWritebackRequest({
        protocolVersion: 1,
        leaseId: "lease:abc12345",
        providerInstanceId: "codex-rotating:repo",
        generation: 2,
        latestGenerationHash: "hashhashhashhashhashhashhashhashhash",
        encryptedValue: '{"auth_mode":"chatgpt"}',
        keyId: "012345",
        idempotencyKey: "idem:abc12345",
      }),
    ).toThrow();
  });

  it("encrypts compact auth with GitHub public key and hashes the exact compact bytes", async () => {
    await sodium.ready;
    const keyPair = sodium.crypto_box_keypair();
    const encrypted = await encryptCodexRotatingAuthForGitHubSecret({
      authJsonBytes: JSON.stringify(
        {
          auth_mode: "chatgpt",
          tokens: { refresh_token: "refresh-token" },
          last_refresh: "2026-05-24T12:00:00.000Z",
        },
        null,
        2,
      ),
      githubPublicKeyBase64: Buffer.from(keyPair.publicKey).toString("base64"),
      githubKeyId: "github-key-id",
      generationHashSalt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(encrypted.compactAuthJsonBytes).not.toContain("\n");
    expect(encrypted.keyId).toBe("github-key-id");
    expect(encrypted.latestGenerationHash).toBe(
      computeCodexAuthGenerationHash({
        authJsonBytes: encrypted.compactAuthJsonBytes,
        generationHashSalt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );
    expect(encrypted.encryptedValue).not.toContain("refresh-token");

    const opened = sodium.crypto_box_seal_open(
      Buffer.from(encrypted.encryptedValue, "base64"),
      keyPair.publicKey,
      keyPair.privateKey,
      "text",
    );
    expect(opened).toBe(encrypted.compactAuthJsonBytes);
  });

  it("prunes secret and GitHub command env before child processes", () => {
    expect(
      pruneCodexRotatingChildEnv({
        PATH: "/usr/bin",
        GITHUB_TOKEN: "token",
        GITHUB_OUTPUT: "/tmp/out",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc",
        INPUT_AUTH_JSON: validAuthJson,
        REVIEWROUTER_CODEX_AUTH_JSON: validAuthJson,
        OPENAI_API_KEY: "sk-test",
        NODE_OPTIONS: "--require ./repo-hook.js",
        BASH_ENV: "/tmp/repo-env",
        ENV: "/tmp/repo-env",
        GIT_CONFIG_COUNT: "1",
        GIT_TRACE: "1",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });

  it("builds refresh bootstrap and safe checkout plans without package installs", () => {
    expect(
      buildCodexRefreshBootstrapPlan({
        codexBinaryPath: "/opt/reviewrouter/codex",
        tempHome: "/tmp/home",
        tempCodexHome: "/tmp/codex",
        emptyWorkingDirectory: "/tmp/empty",
        authJsonPath: "/tmp/codex/auth.json",
      }),
    ).toMatchObject({
      command: "/opt/reviewrouter/codex",
      cwd: "/tmp/empty",
    });

    const checkout = buildSafeCheckoutPlan({
      repositoryFullName: "777genius/agent-teams-ai",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/work",
    });
    expect(checkout.commands.join("\n")).toContain("--no-recurse-submodules");
    expect(checkout.commands.join("\n")).not.toContain("actions/checkout");
  });
});
