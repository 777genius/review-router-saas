export type ReviewRouterWorkflowOptions = {
  readonly actionRef: string;
  readonly apiUrl: string;
  readonly runtimeConfigMode: "oidc" | "static";
  readonly staticRuntimeEnv?: Readonly<Record<string, string>>;
  readonly workflowStyle?: ReviewRouterWorkflowStyle;
};

export type ReviewRouterWorkflowStyle = "reusable" | "explicit";

export type ReviewRouterWorkflowFile = {
  readonly path: string;
  readonly content: string;
};

export const defaultWorkflowPath = ".github/workflows/reviewrouter.yml";
export const defaultInteractionWorkflowPath =
  ".github/workflows/reviewrouter-interaction.yml";
export const defaultRequiredWorkflowPath =
  ".github/workflows/reviewrouter-required.yml";
export const defaultSetupBranch = "reviewrouter/setup";
export const reusableWorkflowRuntimeRepository = "777genius/review-router";
export const reusableReviewWorkflowPath =
  ".github/workflows/reviewrouter-reusable.yml";
export const reusableInteractionWorkflowPath =
  ".github/workflows/reviewrouter-interaction-reusable.yml";

export function renderReviewRouterWorkflow(
  options: ReviewRouterWorkflowOptions,
): string {
  const template = prepareWorkflowTemplate(options);

  return `name: ReviewRouter

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
    if: \${{ github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false }}
    env:
      REVIEWROUTER_API_URL: ${JSON.stringify(options.apiUrl)}
      REVIEWROUTER_ACTION_VERSION: ${JSON.stringify(template.actionVersion)}
      REVIEWROUTER_OIDC_AUDIENCE: "reviewrouter"
      REVIEWROUTER_RUNTIME_CONFIG_MODE: ${JSON.stringify(options.runtimeConfigMode)}
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: "true"${template.staticRuntimeEnvBlock}
      REVIEWROUTER_COMMENT_TOKEN_MODE: ${JSON.stringify(template.commentTokenMode)}
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
            echo "::error::CODEX_AUTH_JSON secret is missing. reseed auth.json from a trusted machine or switch this repository to OpenAI API-key mode."
            exit 1
          fi
          node - <<'NODE'
          const payload = process.env.CODEX_AUTH_JSON || '';
          const fail = (message) => {
            console.error('::error::' + message);
            process.exit(1);
          };
          const warn = (message) => {
            console.error('::warning::' + message);
          };
          let auth;
          try {
            auth = JSON.parse(payload);
          } catch (error) {
            fail('CODEX_AUTH_JSON is not valid JSON. reseed auth.json from a trusted machine. ' + error.message);
          }
          if (auth.auth_mode !== 'chatgpt') {
            fail('CODEX_AUTH_JSON auth_mode must be chatgpt. reseed auth.json with Codex CLI subscription login or switch this repo to API-key mode.');
          }
          if (!auth.tokens || typeof auth.tokens.refresh_token !== 'string' || auth.tokens.refresh_token.length === 0) {
            fail('CODEX_AUTH_JSON tokens.refresh_token is missing. Run codex login on a trusted machine and reseed auth.json.');
          }
          if (!auth.last_refresh) {
            warn('CODEX_AUTH_JSON last_refresh is missing. If Codex later fails with an auth error, run codex login on a trusted machine and reseed auth.json.');
          } else {
            const refreshedAt = Date.parse(auth.last_refresh);
            const maxAgeDays = 30;
            if (!Number.isFinite(refreshedAt)) {
              warn('CODEX_AUTH_JSON last_refresh is not parseable. If Codex later fails with an auth error, run codex login on a trusted machine and reseed auth.json.');
            } else if ((Date.now() - refreshedAt) / 86400000 > maxAgeDays) {
              warn('CODEX_AUTH_JSON last_refresh is older than 30 days. If Codex later fails with an auth error, run codex login on a trusted machine and reseed auth.json.');
            }
          }
          NODE
          export CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}"
          mkdir -p "$CODEX_HOME"
          chmod 700 "$CODEX_HOME"
          printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"
          chmod 600 "$CODEX_HOME/auth.json"
          if [ -n "\${CODEX_CONFIG_TOML:-}" ]; then
            printf '%s' "$CODEX_CONFIG_TOML" > "$CODEX_HOME/config.toml"
            chmod 600 "$CODEX_HOME/config.toml"
          fi

${template.oidcStep}      - name: Run ReviewRouter
        if: \${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}
        uses: ${options.actionRef}
        env:
          GITHUB_TOKEN: \${{ github.token }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
          CODEX_CONFIG_TOML: \${{ secrets.CODEX_CONFIG_TOML }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
`;
}

export function renderReviewRouterInteractionWorkflow(
  options: ReviewRouterWorkflowOptions,
): string {
  const template = prepareWorkflowTemplate(options);

  return `name: ReviewRouter Interaction

on:
  pull_request_review_comment:
    types: [created]
  workflow_dispatch:

permissions:
  actions: write
  contents: read
  pull-requests: write
  issues: write
  id-token: write

jobs:
  interaction:
    name: interaction
    runs-on: ubuntu-latest
    env:
      REVIEWROUTER_API_URL: ${JSON.stringify(options.apiUrl)}
      REVIEWROUTER_ACTION_VERSION: ${JSON.stringify(template.actionVersion)}
      REVIEWROUTER_OIDC_AUDIENCE: "reviewrouter"
      REVIEWROUTER_RUNTIME_CONFIG_MODE: ${JSON.stringify(options.runtimeConfigMode)}
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: "true"
      REVIEWROUTER_COMMENT_TOKEN_MODE: ${JSON.stringify(template.commentTokenMode)}
      REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: "reviewrouter.yml"
    steps:${template.oidcStep}      - name: Preflight ReviewRouter interaction
        id: preflight
        uses: ${options.actionRef}
        env:
          GITHUB_TOKEN: \${{ github.token }}
          REVIEW_ROUTER_MODE: "interaction-preflight"

      - name: Run ReviewRouter interaction
        if: \${{ steps.preflight.outputs.should_run == 'true' }}
        uses: ${options.actionRef}
        env:
          GITHUB_TOKEN: \${{ github.token }}
          REVIEW_ROUTER_MODE: "interaction"
`;
}

export function renderReviewRouterReusableWorkflow(
  options: ReviewRouterWorkflowOptions,
): string {
  const template = prepareReusableWorkflowTemplate(options);

  return `name: ReviewRouter

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:
  workflow_dispatch:
    inputs:
      pr_number:
        description: "Pull request number for manual reruns"
        required: false
        type: string

permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write

jobs:
  review:
    name: review
    uses: ${reusableWorkflowRuntimeRepository}/${reusableReviewWorkflowPath}@${template.runtimeRef}
    with:
      runtime_ref: ${template.runtimeRef}
      api_url: ${JSON.stringify(options.apiUrl)}
      runtime_config_mode: ${options.runtimeConfigMode}
      static_runtime_env_json: >-
        ${template.staticRuntimeEnvJson}
      pr_number: \${{ github.event.pull_request.number || inputs.pr_number }}
    secrets:
      REVIEW_ROUTER_LEDGER_KEY: \${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}
      CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
      CODEX_CONFIG_TOML: \${{ secrets.CODEX_CONFIG_TOML }}
      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
      OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
`;
}

export function renderReviewRouterReusableInteractionWorkflow(
  options: ReviewRouterWorkflowOptions,
): string {
  const template = prepareReusableWorkflowTemplate(options);

  return `name: ReviewRouter Interaction

on:
  pull_request_review_comment:
    types: [created]
  workflow_dispatch:

permissions:
  actions: write
  contents: read
  pull-requests: write
  issues: write
  id-token: write

jobs:
  interaction:
    name: interaction
    uses: ${reusableWorkflowRuntimeRepository}/${reusableInteractionWorkflowPath}@${template.runtimeRef}
    with:
      runtime_ref: ${template.runtimeRef}
      api_url: ${JSON.stringify(options.apiUrl)}
      runtime_config_mode: ${options.runtimeConfigMode}
      review_workflow_file: reviewrouter.yml
    secrets:
      REVIEW_ROUTER_LEDGER_KEY: \${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}
`;
}

export function renderReviewRouterRequiredWorkflow(
  options: ReviewRouterWorkflowOptions,
): string {
  const template = prepareWorkflowTemplate(options);

  return `name: ReviewRouter Required

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:

permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write

jobs:
  review:
    name: review
    runs-on: ubuntu-latest
    if: \${{ github.event_name == 'merge_group' || github.event.pull_request.draft == false }}
    env:
      REVIEWROUTER_API_URL: ${JSON.stringify(options.apiUrl)}
      REVIEWROUTER_ACTION_VERSION: ${JSON.stringify(template.actionVersion)}
      REVIEWROUTER_OIDC_AUDIENCE: "reviewrouter"
      REVIEWROUTER_RUNTIME_CONFIG_MODE: ${JSON.stringify(options.runtimeConfigMode)}
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: "true"${template.staticRuntimeEnvBlock}
      REVIEWROUTER_COMMENT_TOKEN_MODE: ${JSON.stringify(template.commentTokenMode)}
    steps:
      - name: Pass merge queue check
        if: \${{ github.event_name == 'merge_group' }}
        shell: bash
        run: |
          echo "ReviewRouter merge queue check passed. Full review runs on pull_request events where a PR number is available."

      - name: Checkout pull request code
        if: \${{ github.event_name != 'merge_group' }}
        uses: actions/checkout@v6
        with:
          persist-credentials: false

      - name: Skip fork pull requests
        if: \${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}
        shell: bash
        run: |
          echo "ReviewRouter skipped this fork pull request because secret-backed provider execution is disabled by default."

      - name: Setup Node.js for Codex CLI
        if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && github.event_name != 'merge_group' && (env.REVIEW_AUTH_MODE == 'codex-oauth' || env.REVIEW_AUTH_MODE == 'openai-api') }}
        uses: actions/setup-node@v6
        with:
          node-version: "24"

      - name: Install Codex CLI
        if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && github.event_name != 'merge_group' && (env.REVIEW_AUTH_MODE == 'codex-oauth' || env.REVIEW_AUTH_MODE == 'openai-api') }}
        shell: bash
        run: npm install -g @openai/codex@0.125.0

      - name: Restore Codex subscription auth
        if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && github.event_name != 'merge_group' && env.REVIEW_AUTH_MODE == 'codex-oauth' }}
        shell: bash
        env:
          CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
          CODEX_CONFIG_TOML: \${{ secrets.CODEX_CONFIG_TOML }}
        run: |
          set -euo pipefail
          if [ -z "\${CODEX_AUTH_JSON:-}" ]; then
            echo "::error::CODEX_AUTH_JSON secret is missing. reseed auth.json from a trusted machine or switch this repository to OpenAI API-key mode."
            exit 1
          fi
          node - <<'NODE'
          const payload = process.env.CODEX_AUTH_JSON || '';
          const fail = (message) => {
            console.error('::error::' + message);
            process.exit(1);
          };
          let auth;
          try {
            auth = JSON.parse(payload);
          } catch (error) {
            fail('CODEX_AUTH_JSON is not valid JSON. reseed auth.json from a trusted machine. ' + error.message);
          }
          if (auth.auth_mode !== 'chatgpt') {
            fail('CODEX_AUTH_JSON auth_mode must be chatgpt. reseed auth.json with Codex CLI subscription login or switch this repo to API-key mode.');
          }
          if (!auth.tokens || typeof auth.tokens.refresh_token !== 'string' || auth.tokens.refresh_token.length === 0) {
            fail('CODEX_AUTH_JSON tokens.refresh_token is missing. Run codex login on a trusted machine and reseed auth.json.');
          }
          NODE
          export CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}"
          mkdir -p "$CODEX_HOME"
          chmod 700 "$CODEX_HOME"
          printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"
          chmod 600 "$CODEX_HOME/auth.json"
          if [ -n "\${CODEX_CONFIG_TOML:-}" ]; then
            printf '%s' "$CODEX_CONFIG_TOML" > "$CODEX_HOME/config.toml"
            chmod 600 "$CODEX_HOME/config.toml"
          fi

${template.oidcStep}      - name: Run ReviewRouter
        if: \${{ github.event_name != 'merge_group' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}
        uses: ${options.actionRef}
        env:
          GITHUB_TOKEN: \${{ github.token }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
          CODEX_CONFIG_TOML: \${{ secrets.CODEX_CONFIG_TOML }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
`;
}

export function renderReviewRouterWorkflowFiles(
  options: ReviewRouterWorkflowOptions,
): readonly ReviewRouterWorkflowFile[] {
  if ((options.workflowStyle ?? "reusable") === "reusable") {
    return [
      {
        path: defaultWorkflowPath,
        content: renderReviewRouterReusableWorkflow(options),
      },
      {
        path: defaultInteractionWorkflowPath,
        content: renderReviewRouterReusableInteractionWorkflow(options),
      },
    ];
  }

  return [
    {
      path: defaultWorkflowPath,
      content: renderReviewRouterWorkflow(options),
    },
    {
      path: defaultInteractionWorkflowPath,
      content: renderReviewRouterInteractionWorkflow(options),
    },
  ];
}

function prepareReusableWorkflowTemplate(
  options: ReviewRouterWorkflowOptions,
): {
  readonly runtimeRef: string;
  readonly staticRuntimeEnvJson: string;
} {
  assertSafeApiUrl(options.apiUrl);
  const runtimeRef = extractReusableRuntimeRef(options.actionRef);
  const staticRuntimeEnv = options.staticRuntimeEnv ?? {};
  for (const [key, value] of Object.entries(staticRuntimeEnv)) {
    assertSafeEnvKey(key);
    if (typeof value !== "string") {
      throw new Error("invalid_workflow_env_value");
    }
  }

  return {
    runtimeRef,
    staticRuntimeEnvJson: JSON.stringify(staticRuntimeEnv),
  };
}

function prepareWorkflowTemplate(options: ReviewRouterWorkflowOptions): {
  readonly actionVersion: string;
  readonly commentTokenMode: "app-oidc" | "github-token";
  readonly oidcStep: string;
  readonly staticRuntimeEnvBlock: string;
} {
  assertSafeActionRef(options.actionRef);
  assertSafeApiUrl(options.apiUrl);
  const actionVersion = extractActionVersion(options.actionRef);
  const staticRuntimeEnv = Object.entries(options.staticRuntimeEnv ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      assertSafeEnvKey(key);
      return `      ${key}: ${JSON.stringify(value)}`;
    })
    .join("\n");
  const staticRuntimeEnvBlock = staticRuntimeEnv ? `\n${staticRuntimeEnv}` : "";
  const oidcStep =
    options.runtimeConfigMode === "oidc"
      ? `
      - name: Fetch ReviewRouter runtime config
        if: \${{ github.event_name != 'merge_group' && (github.event_name == 'workflow_dispatch' || github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}
        shell: bash
        run: |
          set -euo pipefail
          if [ -z "\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] || [ -z "\${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
            echo "ReviewRouter OIDC is unavailable. Check id-token: write permission."
            exit 1
          fi
          echo "ReviewRouter runtime config will be fetched by the action using GitHub OIDC."
`
      : "";

  return {
    actionVersion,
    commentTokenMode:
      options.runtimeConfigMode === "oidc" ? "app-oidc" : "github-token",
    oidcStep,
    staticRuntimeEnvBlock,
  };
}

function assertSafeActionRef(actionRef: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[A-Za-z0-9_./-]+$/.test(actionRef)) {
    throw new Error("invalid_workflow_action_ref");
  }
}

function extractReusableRuntimeRef(actionRef: string): string {
  assertSafeActionRef(actionRef);
  const atIndex = actionRef.lastIndexOf("@");
  const repository = actionRef.slice(0, atIndex).toLowerCase();
  const runtimeRef = actionRef.slice(atIndex + 1);
  if (repository !== reusableWorkflowRuntimeRepository) {
    throw new Error("invalid_reusable_workflow_action_ref");
  }
  if (!/^(main|v1|v1\.[0-9]+\.[0-9]+|[a-fA-F0-9]{40})$/.test(runtimeRef)) {
    throw new Error("invalid_reusable_workflow_runtime_ref");
  }
  return runtimeRef;
}

function extractActionVersion(actionRef: string): string {
  const atIndex = actionRef.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === actionRef.length - 1) {
    throw new Error("invalid_workflow_action_ref");
  }
  return actionRef.slice(atIndex + 1);
}

function assertSafeApiUrl(apiUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("invalid_workflow_api_url");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("invalid_workflow_api_url");
  }
  if (parsed.protocol === "https:") {
    return;
  }
  if (parsed.protocol === "http:" && isLocalhost(parsed.hostname)) {
    return;
  }

  throw new Error("invalid_workflow_api_url");
}

function isLocalhost(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  ) {
    return true;
  }
  if (hostname.endsWith(".localhost")) {
    return true;
  }
  return false;
}

function assertSafeEnvKey(key: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error("invalid_workflow_env_key");
  }
}
