import { describe, expect, it } from "vitest";
import { renderReviewRouterWorkflow } from "../domain/workflow-template";

describe("renderReviewRouterWorkflow", () => {
  it("matches the reviewed secure workflow snapshot", () => {
    const workflow = renderReviewRouterWorkflow({
      actionRef: "777genius/review-router@v1",
      apiUrl: "https://app.reviewrouter.dev",
      runtimeConfigMode: "oidc",
      staticRuntimeEnv: {
        CODEX_AGENTIC_CONTEXT: "true",
        CODEX_MODEL: "gpt-5.5",
        CODEX_REASONING_EFFORT: "medium",
        FAIL_ON_SEVERITY: "critical",
        REVIEW_AUTH_MODE: "codex-oauth",
      },
    });

    expect(workflow).toMatchInlineSnapshot(`
      "name: ReviewRouter

      on:
        pull_request:
          types: [opened, synchronize, reopened, ready_for_review]
        workflow_dispatch:

      permissions:
        contents: read
        pull-requests: write
        issues: write
        id-token: write

      jobs:
        review:
          name: review
          runs-on: ubuntu-latest
          if: \${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}
          env:
            REVIEWROUTER_API_URL: "https://app.reviewrouter.dev"
            REVIEWROUTER_ACTION_VERSION: "v1"
            REVIEWROUTER_OIDC_AUDIENCE: "reviewrouter"
            REVIEWROUTER_RUNTIME_CONFIG_MODE: "oidc"
            REVIEWROUTER_STATIC_CONFIG_FALLBACK: "true"
            CODEX_AGENTIC_CONTEXT: "true"
            CODEX_MODEL: "gpt-5.5"
            CODEX_REASONING_EFFORT: "medium"
            FAIL_ON_SEVERITY: "critical"
            REVIEW_AUTH_MODE: "codex-oauth"
          steps:
            - name: Checkout pull request code
              uses: actions/checkout@v6
              with:
                persist-credentials: false

            - name: Skip fork pull requests
              if: \${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}
              shell: bash
              run: |
                echo "ReviewRouter skipped this fork pull request because secret-backed provider execution is disabled by default."

            - name: Setup Node.js for Codex CLI
              if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && (env.REVIEW_AUTH_MODE == 'codex-oauth' || env.REVIEW_AUTH_MODE == 'openai-api') }}
              uses: actions/setup-node@v6
              with:
                node-version: "24"

            - name: Install Codex CLI
              if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && (env.REVIEW_AUTH_MODE == 'codex-oauth' || env.REVIEW_AUTH_MODE == 'openai-api') }}
              shell: bash
              run: npm install -g @openai/codex@0.125.0

            - name: Restore Codex subscription auth
              if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && env.REVIEW_AUTH_MODE == 'codex-oauth' }}
              shell: bash
              env:
                CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
                CODEX_CONFIG_TOML: \${{ secrets.CODEX_CONFIG_TOML }}
              run: |
                set -euo pipefail
                if [ -z "\${CODEX_AUTH_JSON:-}" ]; then
                  echo "::error::CODEX_AUTH_JSON secret is missing. Re-seed Codex auth from a trusted machine or switch this repository to OpenAI API-key mode."
                  exit 1
                fi
                export CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}"
                mkdir -p "$CODEX_HOME"
                chmod 700 "$CODEX_HOME"
                printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"
                chmod 600 "$CODEX_HOME/auth.json"
                if [ -n "\${CODEX_CONFIG_TOML:-}" ]; then
                  printf '%s' "$CODEX_CONFIG_TOML" > "$CODEX_HOME/config.toml"
                  chmod 600 "$CODEX_HOME/config.toml"
                fi


            - name: Fetch ReviewRouter runtime config
              if: \${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}
              shell: bash
              run: |
                set -euo pipefail
                if [ -z "\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] || [ -z "\${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
                  echo "ReviewRouter OIDC is unavailable. Check id-token: write permission."
                  exit 1
                fi
                echo "ReviewRouter runtime config will be fetched by the action using GitHub OIDC."
            - name: Run ReviewRouter
              if: \${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}
              uses: 777genius/review-router@v1
              env:
                GITHUB_TOKEN: \${{ github.token }}
                PR_NUMBER: \${{ github.event.pull_request.number }}
                CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
                CODEX_CONFIG_TOML: \${{ secrets.CODEX_CONFIG_TOML }}
                OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
                OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
      "
    `);
  });

  it("renders secure pull_request workflow defaults", () => {
    const workflow = renderReviewRouterWorkflow({
      actionRef: "777genius/review-router@v1",
      apiUrl: "https://app.reviewrouter.dev",
      runtimeConfigMode: "oidc",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth",
        CODEX_MODEL: "gpt-5.5",
      },
    });

    expect(workflow).toContain("pull_request:");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toContain("env:\n        run:");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain(
      "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository",
    );
    expect(workflow).toContain(
      "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toContain(
      "github.event_name != 'pull_request' || github.event.pull_request.draft == false",
    );
    expect(workflow).toContain("uses: 777genius/review-router@v1");
    expect(workflow).toContain("uses: actions/setup-node@v6");
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("npm install -g @openai/codex@0.125.0");
    expect(workflow).toContain("github.event.pull_request.user.type != 'Bot'");
    expect(workflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(workflow).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
    expect(workflow).toContain(
      "OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}",
    );
    expect(workflow).toContain(
      "CODEX_AUTH_JSON secret is missing. Re-seed Codex auth",
    );
    expect(workflow).toContain(
      'REVIEWROUTER_API_URL: "https://app.reviewrouter.dev"',
    );
    expect(workflow).toContain('REVIEWROUTER_ACTION_VERSION: "v1"');
    expect(workflow).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(workflow).toContain(
      "PR_NUMBER: ${{ github.event.pull_request.number }}",
    );
    expect(workflow).toContain('REVIEWROUTER_OIDC_AUDIENCE: "reviewrouter"');
    expect(workflow).toContain('REVIEWROUTER_RUNTIME_CONFIG_MODE: "oidc"');
    expect(workflow).toContain('REVIEW_AUTH_MODE: "codex-oauth"');
    expect(workflow).toContain('CODEX_MODEL: "gpt-5.5"');
  });

  it("allows local http for development workflow provisioning only", () => {
    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "http://localhost:4000",
        runtimeConfigMode: "oidc",
      }),
    ).not.toThrow();
    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "http://127.0.0.1:4000",
        runtimeConfigMode: "oidc",
      }),
    ).not.toThrow();
  });

  it("rejects unsafe workflow template inputs before rendering YAML", () => {
    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1\nrun: evil",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_action_ref");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "javascript:alert(1)",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "http://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://token@example.com",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev?target=evil",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "static",
        staticRuntimeEnv: {
          "BAD_KEY:\n          RUN": "evil",
        },
      }),
    ).toThrow("invalid_workflow_env_key");
  });
});
