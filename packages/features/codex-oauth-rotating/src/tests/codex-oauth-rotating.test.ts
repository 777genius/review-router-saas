import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function withRenderedInstallerCommandFixture(input: {
  readonly installerBody: string;
  readonly run: (fixture: {
    readonly command: string;
    readonly env: NodeJS.ProcessEnv;
    readonly markerPath: string;
    readonly manifest: ReturnType<typeof buildCodexRotatingSetupManifest>;
  }) => void;
}): void {
  const root = mkdtempSync(join(tmpdir(), "rr-codex-command-e2e-"));
  try {
    const binDir = join(root, "bin");
    const installerPath = join(root, "fixture-installer.sh");
    const markerPath = join(root, "install-marker.txt");
    const installerUrl = "https://reviewrouter.site/install/codex-rotating";
    mkdirSync(binDir, { recursive: true });
    writeExecutable(installerPath, input.installerBody);
    writeExecutable(
      join(binDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift
      out="\${1:-}"
      ;;
    -*)
      ;;
    *)
      url="$1"
      ;;
  esac
  shift
done
if [ "$url" != "$RR_EXPECTED_URL" ]; then
  echo "unexpected curl URL: $url" >&2
  exit 21
fi
if [ -z "$out" ]; then
  echo "missing curl output path" >&2
  exit 22
fi
cp "$RR_FIXTURE_INSTALLER" "$out"
`,
    );
    writeExecutable(
      join(binDir, "shasum"),
      `#!/usr/bin/env bash
set -euo pipefail
file="\${@: -1}"
hash="$(node - "$file" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
console.log(crypto.createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex"));
NODE
)"
printf '%s  %s\\n' "$hash" "$file"
`,
    );

    const installerSha256 = createHash("sha256")
      .update(readFileSync(installerPath))
      .digest("hex");
    const manifest = buildCodexRotatingSetupManifest({
      repositoryFullName: "777genius/agent-teams-ai",
      repositoryId: "123456",
      providerInstanceId: "codex-rotating:123456",
      setupNonce: "stp:sandbox-command",
      installerUrl,
      installerVersion: "v1.2.3",
      installerSha256,
      now: new Date("2026-05-25T12:00:00.000Z"),
    });
    const command = renderCodexRotatingInstallerCommand({
      manifest,
      setupManifestUrl:
        "https://reviewrouter.site/api/codex-rotating/setup-manifest",
      setupConfirmUrl:
        "https://reviewrouter.site/api/codex-rotating/setup-confirm",
    });

    input.run({
      command,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        RR_EXPECTED_URL: installerUrl,
        RR_FIXTURE_INSTALLER: installerPath,
        RR_INSTALL_MARKER: markerPath,
      },
      markerPath,
      manifest,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o700);
}

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

    expect(command).toMatch(/^bash <<'REVIEW_ROUTER_INSTALL'\n/);
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
    expect(command).toMatch(/\nREVIEW_ROUTER_INSTALL$/);
  });

  it("executes the rendered installer command end-to-end in a sandbox", () => {
    withRenderedInstallerCommandFixture({
      installerBody: `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 1 ] || [ "$1" != "--confirm-write" ]; then
  echo "unexpected installer args: $*" >&2
  exit 10
fi
{
  printf 'url=%s\\n' "$REVIEW_ROUTER_INSTALLER_URL"
  printf 'version=%s\\n' "$REVIEW_ROUTER_INSTALLER_VERSION"
  printf 'sha=%s\\n' "$REVIEW_ROUTER_INSTALLER_SHA256"
  printf 'provider=%s\\n' "$REVIEW_ROUTER_CODEX_ROTATING_PROVIDER_INSTANCE_ID"
  printf 'setup_url=%s\\n' "$REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL"
  printf 'confirm_url=%s\\n' "$REVIEW_ROUTER_CODEX_ROTATING_SETUP_CONFIRM_URL"
  printf 'nonce=%s\\n' "$REVIEW_ROUTER_CODEX_ROTATING_SETUP_NONCE"
} > "$RR_INSTALL_MARKER"
`,
      run: ({ command, env, markerPath, manifest }) => {
        const result = spawnSync("bash", ["-c", command], {
          encoding: "utf8",
          env,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(markerPath, "utf8")).toContain(
          `url=${manifest.installer.url}`,
        );
        expect(readFileSync(markerPath, "utf8")).toContain(
          `version=${manifest.installer.version}`,
        );
        expect(readFileSync(markerPath, "utf8")).toContain(
          `sha=${manifest.installer.sha256}`,
        );
        expect(readFileSync(markerPath, "utf8")).toContain(
          `provider=${manifest.providerInstanceId}`,
        );
        expect(readFileSync(markerPath, "utf8")).toContain(
          `nonce=${manifest.setupNonce}`,
        );
      },
    });
  });

  it("keeps the caller shell alive when the child installer fails", () => {
    withRenderedInstallerCommandFixture({
      installerBody: `#!/usr/bin/env bash
set -euo pipefail
printf 'installer-started\\n' > "$RR_INSTALL_MARKER"
echo "installer failed intentionally" >&2
exit 17
`,
      run: ({ command, env, markerPath }) => {
        const result = spawnSync(
          "bash",
          ["-c", `${command}\nprintf 'parent-shell-survived\\n'`],
          {
            encoding: "utf8",
            env,
          },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("parent-shell-survived");
        expect(result.stderr).toContain("installer failed intentionally");
        expect(readFileSync(markerPath, "utf8")).toBe("installer-started\n");
      },
    });
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
    expect(workflow).toContain("permissions: {}\n\njobs:");
    expect(workflow).toContain("    permissions:\n      id-token: write");
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

    const inlineEnv = workflow.replace(
      "    timeout-minutes:",
      "    env: { NODE_OPTIONS: --require ./hook.js }\n    timeout-minutes:",
    );
    expect(scanCodexRotatingAdvisoryWorkflow(inlineEnv).errors).toContain(
      "workflow_env_not_allowed",
    );

    const inlineStrategy = workflow.replace(
      "    timeout-minutes:",
      "    strategy: { matrix: { node: [24] } }\n    timeout-minutes:",
    );
    expect(scanCodexRotatingAdvisoryWorkflow(inlineStrategy).errors).toContain(
      "matrix_strategy_not_allowed",
    );
  });

  it("accepts job-scoped and legacy top-level id-token workflow permissions", () => {
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: "777genius/review-router@main",
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:777genius/agent-teams-ai",
    });

    expect(scanCodexRotatingAdvisoryWorkflow(workflow)).toEqual({
      valid: true,
      errors: [],
    });

    const legacyTopLevelPermissions = workflow.replace(
      "permissions: {}\n\njobs:",
      "permissions:\n  id-token: write\n\njobs:",
    );
    expect(
      scanCodexRotatingAdvisoryWorkflow(legacyTopLevelPermissions),
    ).toEqual({
      valid: true,
      errors: [],
    });

    const broadReviewJobPermissions = workflow.replace(
      "    permissions:\n      id-token: write",
      "    permissions:\n      id-token: write\n      contents: read",
    );
    expect(
      scanCodexRotatingAdvisoryWorkflow(broadReviewJobPermissions).errors,
    ).toContain("review_job_requires_id_token_write");
  });

  it("allows only explicit hybrid provider secret inputs in rotating workflow", () => {
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: "777genius/review-router@main",
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:777genius/agent-teams-ai",
      claudeCodeOAuthTokenSecret: true,
      openRouterApiKeySecret: true,
    });

    expect(workflow).toContain(
      "claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(workflow).toContain(
      "openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}",
    );
    expect(scanCodexRotatingAdvisoryWorkflow(workflow)).toEqual({
      valid: true,
      errors: [],
    });

    const unsafe = workflow.replace(
      "openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}",
      "openrouter-api-key: ${{ secrets.SOME_OTHER_SECRET }}",
    );
    expect(scanCodexRotatingAdvisoryWorkflow(unsafe).errors).toContain(
      "unknown_secret_reference:SOME_OTHER_SECRET",
    );
  });

  it("rejects extra executable surfaces in fork sandbox workflow", () => {
    const workflow = renderCodexRotatingAdvisoryWorkflow({
      actionRef: "777genius/review-router@main",
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:777genius/agent-teams-ai",
      forkAgenticSandboxEnabled: true,
    });

    expect(scanCodexRotatingAdvisoryWorkflow(workflow)).toEqual({
      valid: true,
      errors: [],
    });

    const extraRun = workflow.replace(
      "      - name: ReviewRouter fork sandbox review",
      "      - name: Unexpected fork command\n        run: echo unsafe\n\n      - name: ReviewRouter fork sandbox review",
    );
    expect(scanCodexRotatingAdvisoryWorkflow(extraRun).errors).toContain(
      "fork_raw_run_step_count_invalid",
    );

    const extraEnv = workflow.replace(
      "    timeout-minutes:",
      "    env: { NODE_OPTIONS: --require ./hook.js }\n    timeout-minutes:",
    );
    expect(scanCodexRotatingAdvisoryWorkflow(extraEnv).errors).toContain(
      "fork_env_block_count_invalid",
    );

    const downgradedCheckout = workflow.replace(
      "uses: actions/checkout@v6",
      "uses: actions/checkout@v5",
    );
    expect(
      scanCodexRotatingAdvisoryWorkflow(downgradedCheckout).errors,
    ).toContain("fork_checkout_action_ref_invalid");
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

  it("allows a rerun attempt to replace an unfinished lease", () => {
    const store = new InMemoryCodexRotatingLeaseStore();
    const now = new Date("2026-05-25T12:00:00.000Z");
    const first = store.acquire({
      providerInstanceId: "codex-rotating:repo",
      runId: "1",
      runAttempt: "1",
      now,
      ttlSeconds: 300,
    });
    const rerun = store.acquire({
      providerInstanceId: "codex-rotating:repo",
      runId: "1",
      runAttempt: "2",
      now,
      ttlSeconds: 300,
    });
    const otherRun = store.acquire({
      providerInstanceId: "codex-rotating:repo",
      runId: "2",
      runAttempt: "1",
      now,
      ttlSeconds: 300,
    });

    expect(first.status).toBe("preleased");
    expect(rerun.status).toBe("preleased");
    expect(rerun.leaseId).not.toBe(first.leaseId);
    expect(otherRun.status).toBe("conflict");
    expect(() =>
      store.finalize({
        leaseId: first.leaseId,
        restoredGenerationHash: "hash-1",
        nextGeneration: 2,
        now,
      }),
    ).toThrow("lease_not_active");
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
        GEMINI_API_KEY: "gemini-test",
        OPENCODE_API_KEY: "opencode-test",
        NPM_TOKEN: "npm-token",
        CUSTOM_SECRET: "secret",
        PRIVATE_KEY: "private-key",
        DB_PASSWORD: "password",
        INPUT_MODE: "fork-agentic-sandbox",
        NODE_OPTIONS: "--require ./repo-hook.js",
        BASH_ENV: "/tmp/repo-env",
        ENV: "/tmp/repo-env",
        GIT_CONFIG_COUNT: "1",
        GIT_TRACE: "1",
        REVIEW_ROUTER_USE_SUBSCRIPTION_RUNTIME_CODEX: "0",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      REVIEW_ROUTER_USE_SUBSCRIPTION_RUNTIME_CODEX: "0",
    });
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
