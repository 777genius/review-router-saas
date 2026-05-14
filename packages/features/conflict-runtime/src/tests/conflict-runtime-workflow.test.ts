import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(
  process.cwd(),
  ".github/workflows/reviewrouter-conflict-reusable.yml",
);
const cliPath = resolve(
  process.cwd(),
  "packages/features/conflict-runtime/src/interface/cli/reviewrouter-conflict-runtime.ts",
);

describe("conflict runtime reusable workflow contract", () => {
  it("keeps conflict review isolated before checking out untrusted PR code", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const runtimeRefValidation = workflow.indexOf(
      "Validate conflict runtime ref",
    );
    const trustedRuntimeCheckout = workflow.indexOf(
      "Checkout trusted ReviewRouter runtime",
    );
    const preflight = workflow.indexOf(
      "Preflight conflict runtime before PR checkout",
    );
    const targetCheckout = workflow.indexOf("Checkout exact conflict head");

    expect(runtimeRefValidation).toBeGreaterThanOrEqual(0);
    expect(trustedRuntimeCheckout).toBeGreaterThan(runtimeRefValidation);
    expect(trustedRuntimeCheckout).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(trustedRuntimeCheckout);
    expect(targetCheckout).toBeGreaterThan(preflight);
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain(
      "if: ${{ inputs.review_kind == 'conflict-head' && inputs.runtime_config_mode == 'oidc' }}",
    );
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toContain("issues: write");
    expect(workflow).not.toContain("write-all");
    expect(workflow).not.toContain("read-all");
  });

  it("pins checkout behavior and does not interpolate untrusted inputs in shell", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const jobEnv = workflow.slice(
      workflow.indexOf("    env:"),
      workflow.indexOf("    steps:"),
    );
    const scriptBodies = [
      ...workflow.matchAll(/\n\s+run: \|\n((?:\s{10,}.+\n?)*)/g),
    ]
      .map((match) => match[1])
      .join("\n");

    expect(workflow).toContain("repository: 777genius/review-router");
    expect(workflow).toContain(
      "REVIEWROUTER_RUNTIME_REF: ${{ inputs.runtime_ref }}",
    );
    expect(workflow).toContain(
      "runtime_ref must be a v1 release tag or full commit SHA for conflict runtime",
    );
    expect(workflow).toContain("ref: ${{ inputs.runtime_ref }}");
    expect(workflow).toContain("repository: ${{ github.repository }}");
    expect(workflow).toContain("ref: ${{ inputs.conflict_head_sha }}");
    expect(
      workflow.indexOf("pnpm --filter @reviewrouter/platform-db db:generate"),
    ).toBeGreaterThan(workflow.indexOf("pnpm install --frozen-lockfile"));
    expect(
      workflow.indexOf(
        "pnpm --filter @reviewrouter/features-conflict-runtime... build",
      ),
    ).toBeGreaterThan(
      workflow.indexOf("pnpm --filter @reviewrouter/platform-db db:generate"),
    );
    expect(workflow.match(/node --conditions=production /g)).toHaveLength(2);
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(jobEnv).not.toContain("REVIEW_ROUTER_CONFLICT_SESSION_FILE");
    expect(
      workflow.match(
        /REVIEW_ROUTER_CONFLICT_SESSION_FILE: \$\{\{ runner\.temp \}\}/g,
      ),
    ).toHaveLength(2);
    expect(scriptBodies).not.toContain("${{ inputs.");
    expect(scriptBodies).not.toContain("${{ github.");
    expect(scriptBodies).not.toContain("${{ secrets.");
    expect(workflow).not.toContain("if: ${{ secrets.");
    expect(workflow).toContain(
      "if: ${{ env.CODEX_AUTH_JSON_PRESENT == '1' || env.OPENAI_API_KEY_PRESENT == '1' }}",
    );
  });

  it("passes only Codex-backed model secrets to the conflict runtime", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("CODEX_AUTH_JSON:");
    expect(workflow).toContain("CODEX_CONFIG_TOML:");
    expect(workflow).toContain("OPENAI_API_KEY:");
    expect(workflow).not.toContain("REVIEW_ROUTER_LEDGER_KEY");
    expect(workflow).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(workflow).not.toContain("OPENROUTER_API_KEY");
  });

  it("masks dispatch nonce before requesting OIDC or runtime config", () => {
    const cli = readFileSync(cliPath, "utf8");

    const readDispatch = cli.indexOf(
      "const conflictDispatchPayload = readConflictDispatchPayloadFromEnv();",
    );
    const maskNonce = cli.indexOf("mask(conflictDispatchPayload.nonce);");
    const requestOidc = cli.indexOf("}).requestToken();");
    const exchangeSession = cli.indexOf(
      "const session = await configClient.exchangeConflictSession",
    );

    expect(readDispatch).toBeGreaterThanOrEqual(0);
    expect(maskNonce).toBeGreaterThan(readDispatch);
    expect(requestOidc).toBeGreaterThan(maskNonce);
    expect(exchangeSession).toBeGreaterThan(requestOidc);
  });
});
