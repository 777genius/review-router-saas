import type { ProviderKind } from "@reviewrouter/features-review-providers";
import { isLoopbackHostname } from "@reviewrouter/shared";
import {
  legacyReviewRouterWorkflowPath,
  managedCodexWorkflowPath,
  managedInteractionWorkflowPath,
} from "@reviewrouter/protocol-review-workflow";
import {
  areWorkflowDocumentsSemanticallyEqual,
  codexRotatingMaxChangedLinesVariableName,
  codexRotatingReviewDraftsVariableName,
  codexRotatingSecretName,
  codexRotatingT0DefaultTimeoutMinutesForSchema,
  codexRotatingTimeoutMinutesVariableName,
  CodexRotatingReviewActionV2Mode,
  CodexRotatingT0WorkflowSchemaVersion,
  isClientTriggeredT0WorkflowSchemaVersion,
  isTrustedDefaultBranchTriggeredCodexWorkflowSchemaVersion,
  type VersionedProviderSecretNamespace,
  renderCodexRotatingAdvisoryWorkflow,
  scanCodexRotatingAdvisoryWorkflow,
} from "@reviewrouter/features-codex-oauth-rotating";

export {
  areWorkflowDocumentsSemanticallyEqual,
  renderCodexRotatingAdvisoryWorkflow,
  scanCodexRotatingAdvisoryWorkflow,
};

export type ReviewRouterWorkflowOptions = {
  readonly actionRef: string;
  readonly apiUrl: string;
  readonly runtimeConfigMode: "oidc" | "static";
  readonly staticRuntimeEnv?: Readonly<Record<string, string>>;
  readonly workflowStyle?: ReviewRouterWorkflowStyle;
  readonly conflictReviewFallbackEnabled?: boolean;
  readonly forkAgenticSandboxEnabled?: boolean;
  readonly codexRotatingProviderInstanceId?: string;
  readonly codexRotatingReviewActionV2Mode?: CodexRotatingReviewActionV2Mode;
  readonly codexRotatingWorkflowSchemaVersion?: CodexRotatingT0WorkflowSchemaVersion;
  readonly codexRotatingActiveSecretNamespace?: VersionedProviderSecretNamespace;
  readonly discussionMode?: ReviewRouterDiscussionMode;
};

export type ReviewRouterWorkflowStyle = "reusable" | "explicit";
export type ReviewRouterDiscussionMode = "off" | "suggest";

export type ReviewRouterWorkflowFile =
  | {
      readonly path: string;
      readonly operation?: "upsert";
      readonly content: string;
    }
  | {
      readonly path: string;
      readonly operation: "delete";
      readonly markerGroups: readonly (readonly string[])[];
    };

export type ReviewRouterWorkflowUpsertFile = {
  readonly path: string;
  readonly operation?: "upsert";
  readonly content: string;
};

export type WorkflowProviderRequirement =
  | "action_ref_supports_provider"
  | "secret_pass_through"
  | "cli_install_step"
  | "trusted_reusable_workflow_ref"
  | "fork_pr_secret_skip";

export type WorkflowProviderCompatibility = {
  readonly providerKind: ProviderKind;
  readonly supported: boolean;
  readonly missingRequirements: readonly WorkflowProviderRequirement[];
};

export const defaultWorkflowPath = legacyReviewRouterWorkflowPath;
export const defaultCodexRotatingWorkflowPath = managedCodexWorkflowPath;
export const defaultInteractionWorkflowPath = managedInteractionWorkflowPath;
export const defaultRequiredWorkflowPath =
  ".github/workflows/reviewrouter-required.yml";
export const defaultSetupBranch = "reviewrouter/setup";
export const reusableWorkflowRuntimeRepository = "777genius/review-router";
export const reusableReviewWorkflowPath =
  ".github/workflows/reviewrouter-reusable.yml";
export const reusableInteractionWorkflowPath =
  ".github/workflows/reviewrouter-interaction-reusable.yml";
export const reusableConflictReviewWorkflowPath =
  ".github/workflows/reviewrouter-conflict-reusable.yml";
export const conflictReviewDispatchEventType = "reviewrouter_conflict_review";
export const conflictReviewKind = "conflict-head";
const reviewMemoryRuntimeEnvBlock = `
      REVIEW_ROUTER_MEMORY_ENABLED: "true"
      REVIEW_ROUTER_MEMORY_PROTOCOL_VERSION: "1"
      REVIEW_ROUTER_MEMORY_BUNDLE_ENDPOINT: "/api/action/v1/memory"`;
const interactionMemoryRuntimeEnvBlock = `${reviewMemoryRuntimeEnvBlock}
      REVIEW_ROUTER_MEMORY_CANDIDATE_ENDPOINT: "/api/action/v1/memory-candidates"
      REVIEW_ROUTER_MEMORY_COMMAND_ENDPOINT: "/api/action/v1/memory-commands"`;
const interactionJobGuardExpression =
  "github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot')";
const actionsCheckoutV6Commit = "d23441a48e516b6c34aea4fa41551a30e30af803";
const actionsSetupNodeV6Commit = "249970729cb0ef3589644e2896645e5dc5ba9c38";
const defaultCodexCliVersion = "0.144.0";
const defaultCodexReviewModel = "gpt-5.6-sol";

function discussionModeExpression(
  options: Pick<ReviewRouterWorkflowOptions, "discussionMode">,
): string {
  return `\${{ vars.REVIEW_ROUTER_DISCUSSION_MODE || '${options.discussionMode ?? "off"}' }}`;
}

export function renderReviewRouterWorkflow(
  options: ReviewRouterWorkflowOptions,
): string {
  if (options.conflictReviewFallbackEnabled === true) {
    throw new Error("conflict_review_explicit_workflow_unsupported");
  }
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
      CODEX_AUTH_JSON_PRESENT: \${{ secrets.CODEX_AUTH_JSON != '' && '1' || '0' }}
      OPENAI_API_KEY_PRESENT: \${{ secrets.OPENAI_API_KEY != '' && '1' || '0' }}
      OPENROUTER_API_KEY_PRESENT: \${{ secrets.OPENROUTER_API_KEY != '' && '1' || '0' }}
      CLAUDE_CODE_OAUTH_TOKEN_PRESENT: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' && '1' || '0' }}${reviewMemoryRuntimeEnvBlock}
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
        if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && (env.CODEX_AUTH_JSON_PRESENT == '1' || env.OPENAI_API_KEY_PRESENT == '1' || env.OPENROUTER_API_KEY_PRESENT == '1') }}
        uses: actions/setup-node@v6
        with:
          node-version: "24"

      - name: Install Codex CLI
        if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && (env.CODEX_AUTH_JSON_PRESENT == '1' || env.OPENAI_API_KEY_PRESENT == '1' || env.OPENROUTER_API_KEY_PRESENT == '1') }}
        shell: bash
        run: npm install -g @openai/codex@${defaultCodexCliVersion}

      - name: Install Claude Code CLI
        if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && env.CLAUDE_CODE_OAUTH_TOKEN_PRESENT == '1' }}
        shell: bash
        run: |
          curl -fsSL https://claude.ai/install.sh | bash -s stable
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"
          "$HOME/.local/bin/claude" --version

      - name: Restore Codex subscription auth
        if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && env.CODEX_AUTH_JSON_PRESENT == '1' }}
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
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
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
    types: [created, edited]
  issue_comment:
    types: [created, edited]
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
    if: \${{ ${interactionJobGuardExpression} }}
    env:
      REVIEWROUTER_API_URL: ${JSON.stringify(options.apiUrl)}
      REVIEWROUTER_ACTION_VERSION: ${JSON.stringify(template.actionVersion)}
      REVIEWROUTER_OIDC_AUDIENCE: "reviewrouter"
      REVIEWROUTER_RUNTIME_CONFIG_MODE: ${JSON.stringify(options.runtimeConfigMode)}
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: "true"
      REVIEWROUTER_COMMENT_TOKEN_MODE: ${JSON.stringify(template.commentTokenMode)}
      CODEX_AUTH_JSON_PRESENT: \${{ secrets.CODEX_AUTH_JSON != '' && '1' || '0' }}
      OPENAI_API_KEY_PRESENT: \${{ secrets.OPENAI_API_KEY != '' && '1' || '0' }}
      REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: "reviewrouter.yml"${interactionMemoryRuntimeEnvBlock}
    steps:${template.oidcStep}      - name: Preflight ReviewRouter interaction
        id: preflight
        uses: ${options.actionRef}
        with:
          mode: interaction-preflight
          api-url: ${JSON.stringify(options.apiUrl)}
        env:
          GITHUB_TOKEN: \${{ github.token }}
          REVIEW_ROUTER_MODE: "interaction-preflight"
          REVIEW_ROUTER_DISCUSSION_MODE: ${discussionModeExpression(options)}

      - name: Setup Node.js for Codex discussion replies
        if: \${{ steps.preflight.outputs.needs_discussion == 'true' && (env.CODEX_AUTH_JSON_PRESENT == '1' || env.OPENAI_API_KEY_PRESENT == '1') }}
        uses: actions/setup-node@v6
        with:
          node-version: "24"

      - name: Install Codex CLI for discussion replies
        if: \${{ steps.preflight.outputs.needs_discussion == 'true' && (env.CODEX_AUTH_JSON_PRESENT == '1' || env.OPENAI_API_KEY_PRESENT == '1') }}
        shell: bash
        run: npm install -g @openai/codex@${defaultCodexCliVersion}

      - name: Restore Codex subscription auth for discussion replies
        if: \${{ steps.preflight.outputs.needs_discussion == 'true' && env.CODEX_AUTH_JSON_PRESENT == '1' }}
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
            fail('CODEX_AUTH_JSON auth_mode must be chatgpt. reseed auth.json with Codex CLI subscription login or switch this repo to OpenAI API-key mode.');
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

      - name: Run ReviewRouter interaction
        if: \${{ steps.preflight.outputs.should_run == 'true' }}
        uses: ${options.actionRef}
        with:
          mode: interaction
        env:
          GITHUB_TOKEN: \${{ github.token }}
          REVIEW_ROUTER_MODE: "interaction"
          REVIEW_ROUTER_DISCUSSION_MODE: ${discussionModeExpression(options)}
          REVIEW_ROUTER_DISCUSSION_MAX_PER_PR: \${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_PR || '20' }}
          REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD: \${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD || '5' }}
          REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS: \${{ vars.REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS || '60' }}
          CODEX_MODEL: \${{ vars.REVIEW_CODEX_MODEL || '${defaultCodexReviewModel}' }}
          CODEX_REASONING_EFFORT: \${{ vars.REVIEW_CODEX_EFFORT || 'xhigh' }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
`;
}

export function renderCodexRotatingInteractionWorkflow(
  options: ReviewRouterWorkflowOptions,
): string {
  return renderCanonicalCodexRotatingInteractionWorkflowV3(options);
}

/**
 * Immutable schema-v1 authority contract. Add a new versioned renderer when
 * the managed interaction workflow changes; queued runs still attest v1.
 */
export function renderCanonicalCodexRotatingInteractionWorkflowV1(
  options: ReviewRouterWorkflowOptions,
): string {
  return renderCanonicalCodexRotatingInteractionWorkflow(options, "v1");
}

/**
 * Immutable schema-v2 authority contract. This remains executable during a
 * staggered rollout, but new setup must install v3.
 */
export function renderCanonicalCodexRotatingInteractionWorkflowV2(
  options: ReviewRouterWorkflowOptions,
): string {
  return renderCanonicalCodexRotatingInteractionWorkflow(options, "v2");
}

/**
 * App-first interaction authority with immutable third-party actions and
 * narrow Actions rerun authority. Repository writes are issued only through
 * App OIDC.
 */
export function renderCanonicalCodexRotatingInteractionWorkflowV3(
  options: ReviewRouterWorkflowOptions,
): string {
  return renderCanonicalCodexRotatingInteractionWorkflow(options, "v3");
}

function renderCanonicalCodexRotatingInteractionWorkflow(
  options: ReviewRouterWorkflowOptions,
  version: "v1" | "v2" | "v3",
): string {
  const runtimeRef = extractReusableRuntimeRef(options.actionRef);
  const appFirst = version !== "v1";
  const actionsRerunAuthority = version === "v3";
  if (actionsRerunAuthority && !/^[a-fA-F0-9]{40}$/.test(runtimeRef)) {
    throw new Error(
      "invalid_app_first_interaction_reusable_workflow_runtime_ref",
    );
  }

  return `name: ReviewRouter Interaction

on:
  pull_request_review_comment:
    types: [created, edited]
  issue_comment:
    types: [created, edited]
  workflow_dispatch:

${
  appFirst
    ? "permissions: {}"
    : `permissions:
  actions: write
  contents: read
  pull-requests: write
  issues: write
  id-token: write`
}

jobs:
  interaction:
    name: interaction
    runs-on: ubuntu-24.04
    if: \${{ ${interactionJobGuardExpression} }}${
      appFirst
        ? `
    permissions:
${actionsRerunAuthority ? "      actions: write\n" : ""}      contents: read
      issues: read
      pull-requests: read
      id-token: write`
        : ""
    }
    env:
      RR_RUNTIME_REF: ${JSON.stringify(runtimeRef)}
      REVIEWROUTER_API_URL: ${JSON.stringify(options.apiUrl)}
      REVIEWROUTER_OIDC_AUDIENCE: "reviewrouter"
      REVIEWROUTER_RUNTIME_CONFIG_MODE: ${JSON.stringify(options.runtimeConfigMode)}
      REVIEWROUTER_STATIC_CONFIG_FALLBACK: "true"
      REVIEWROUTER_COMMENT_TOKEN_MODE: ${JSON.stringify(options.runtimeConfigMode === "oidc" ? "app-oidc" : "github-token")}
      CODEX_AUTH_JSON_PRESENT: \${{ secrets.${codexRotatingSecretName} != '' && '1' || '0' }}
      REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: "reviewrouter-codex.yml"
      REVIEW_ROUTER_MEMORY_ENABLED: "true"
      REVIEW_ROUTER_MEMORY_PROTOCOL_VERSION: "1"
      REVIEW_ROUTER_MEMORY_BUNDLE_ENDPOINT: "/api/action/v1/memory"
      REVIEW_ROUTER_MEMORY_CANDIDATE_ENDPOINT: "/api/action/v1/memory-candidates"
      REVIEW_ROUTER_MEMORY_COMMAND_ENDPOINT: "/api/action/v1/memory-commands"
    steps:
      - name: Checkout ReviewRouter interaction runtime
        uses: actions/checkout@${appFirst ? actionsCheckoutV6Commit : "v6"}
        with:
          repository: ${reusableWorkflowRuntimeRepository}
          ref: \${{ env.RR_RUNTIME_REF }}
          path: .reviewrouter-runtime
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@${appFirst ? actionsSetupNodeV6Commit : "v6"}
        with:
          node-version: "24"

      - name: Preflight ReviewRouter interaction
        id: preflight
        shell: bash
        env:
          GITHUB_TOKEN: \${{ github.token }}
          REVIEW_ROUTER_MODE: "interaction-preflight"
          REVIEW_ROUTER_DISCUSSION_MODE: ${discussionModeExpression(options)}
        run: node .reviewrouter-runtime/dist/index.js

      - name: Install Codex CLI for discussion replies
        if: \${{ steps.preflight.outputs.needs_discussion == 'true' && env.CODEX_AUTH_JSON_PRESENT == '1' }}
        shell: bash
        run: npm install -g @openai/codex@${defaultCodexCliVersion}

      - name: Restore Codex subscription auth for discussion replies
        if: \${{ steps.preflight.outputs.needs_discussion == 'true' && env.CODEX_AUTH_JSON_PRESENT == '1' }}
        shell: bash
        env:
          CODEX_AUTH_JSON: \${{ secrets.${codexRotatingSecretName} }}
        run: |
          set -euo pipefail
          if [ -z "\${CODEX_AUTH_JSON:-}" ]; then
            echo "::error::${codexRotatingSecretName} secret is missing. Re-run ReviewRouter Codex setup."
            exit 1
          fi
          export CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}"
          mkdir -p "$CODEX_HOME"
          chmod 700 "$CODEX_HOME"
          printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"
          chmod 600 "$CODEX_HOME/auth.json"

      - name: Run ReviewRouter interaction
        if: \${{ steps.preflight.outputs.should_run == 'true' }}
        shell: bash
        env:
          GITHUB_TOKEN: \${{ github.token }}
          REVIEW_ROUTER_MODE: "interaction"
          REVIEW_ROUTER_LEDGER_KEY: \${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}
          REVIEW_ROUTER_DISCUSSION_MODE: ${discussionModeExpression(options)}
          REVIEW_ROUTER_DISCUSSION_MAX_PER_PR: \${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_PR || '20' }}
          REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD: \${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD || '5' }}
          REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS: \${{ vars.REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS || '60' }}
          CODEX_MODEL: \${{ vars.REVIEW_CODEX_MODEL || '${defaultCodexReviewModel}' }}
          CODEX_REASONING_EFFORT: \${{ vars.REVIEW_CODEX_EFFORT || 'xhigh' }}
        run: node .reviewrouter-runtime/dist/index.js
`;
}

export function renderReviewRouterReusableWorkflow(
  options: ReviewRouterWorkflowOptions,
): string {
  const template = prepareReusableWorkflowTemplate(options);
  const conflictReviewFallbackEnabled =
    options.conflictReviewFallbackEnabled === true;

  return `name: ReviewRouter

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:${
    conflictReviewFallbackEnabled
      ? `
  repository_dispatch:
    types: [${conflictReviewDispatchEventType}]`
      : ""
  }
  workflow_dispatch:
    inputs:
      pr_number:
        description: "Pull request number for manual reruns"
        required: false
        type: string

permissions: {}
${
  conflictReviewFallbackEnabled
    ? `
concurrency:
  group: reviewrouter-conflict-\${{ github.repository }}-\${{ github.workflow }}-\${{ github.run_id }}
  cancel-in-progress: false
`
    : ""
}

jobs:
  review:
    name: review
${conflictReviewFallbackEnabled ? "    if: ${{ github.event_name != 'repository_dispatch' }}\n" : ""}    permissions:
      contents: read
      pull-requests: write
      issues: write
      id-token: write
    uses: ${reusableWorkflowRuntimeRepository}/${reusableReviewWorkflowPath}@${template.runtimeRef}
    with:
      runtime_ref: ${template.runtimeRef}
      api_url: ${JSON.stringify(options.apiUrl)}
      runtime_config_mode: ${options.runtimeConfigMode}
      static_runtime_env_json: |-
${template.staticRuntimeEnvJsonBlock}
      pr_number: \${{ github.event.pull_request.number || inputs.pr_number }}
    secrets:
      REVIEW_ROUTER_LEDGER_KEY: \${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}
      CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
      CODEX_CONFIG_TOML: \${{ secrets.CODEX_CONFIG_TOML }}
      CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
      OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}${
        conflictReviewFallbackEnabled
          ? `

  conflict-review:
    name: conflict review
    if: \${{ github.event_name == 'repository_dispatch' && github.event.action == '${conflictReviewDispatchEventType}' }}
    permissions:
      contents: read
      id-token: write
    uses: ${reusableWorkflowRuntimeRepository}/${reusableConflictReviewWorkflowPath}@${template.runtimeRef}
    with:
      runtime_ref: ${template.runtimeRef}
      api_url: ${JSON.stringify(options.apiUrl)}
      runtime_config_mode: ${options.runtimeConfigMode}
      pr_number: \${{ github.event.client_payload.pr_number }}
      review_kind: ${conflictReviewKind}
      conflict_repository_id: \${{ github.event.client_payload.repository_id || '' }}
      conflict_dispatch_event_type: \${{ github.event.client_payload.dispatch_event_type || '' }}
      conflict_dispatch_id: \${{ github.event.client_payload.dispatch_id || '' }}
      conflict_dispatch_nonce: \${{ github.event.client_payload.nonce || '' }}
      conflict_head_sha: \${{ github.event.client_payload.head_sha || '' }}
      conflict_base_ref: \${{ github.event.client_payload.base_ref || '' }}
      conflict_base_sha: \${{ github.event.client_payload.base_sha || '' }}
    secrets:
      CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
      CODEX_CONFIG_TOML: \${{ secrets.CODEX_CONFIG_TOML }}
      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}`
          : ""
      }
`;
}

export function renderReviewRouterReusableInteractionWorkflow(
  options: ReviewRouterWorkflowOptions,
): string {
  const template = prepareReusableWorkflowTemplate(options);

  return `name: ReviewRouter Interaction

on:
  pull_request_review_comment:
    types: [created, edited]
  issue_comment:
    types: [created, edited]
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
    if: \${{ ${interactionJobGuardExpression} }}
    uses: ${reusableWorkflowRuntimeRepository}/${reusableInteractionWorkflowPath}@${template.runtimeRef}
    with:
      runtime_ref: ${template.runtimeRef}
      api_url: ${JSON.stringify(options.apiUrl)}
      runtime_config_mode: ${options.runtimeConfigMode}
      review_workflow_file: reviewrouter.yml
      discussion_mode: ${discussionModeExpression(options)}
      discussion_model: \${{ vars.REVIEW_CODEX_MODEL || '${defaultCodexReviewModel}' }}
      discussion_reasoning_effort: \${{ vars.REVIEW_CODEX_EFFORT || 'xhigh' }}
      discussion_max_per_pr: \${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_PR || '20' }}
      discussion_max_per_thread: \${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD || '5' }}
      discussion_timeout_seconds: \${{ vars.REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS || '60' }}
    secrets:
      REVIEW_ROUTER_LEDGER_KEY: \${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}
      CODEX_AUTH_JSON: \${{ secrets.CODEX_AUTH_JSON }}
      CODEX_CONFIG_TOML: \${{ secrets.CODEX_CONFIG_TOML }}
      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
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
      CODEX_AUTH_JSON_PRESENT: \${{ secrets.CODEX_AUTH_JSON != '' && '1' || '0' }}
      OPENAI_API_KEY_PRESENT: \${{ secrets.OPENAI_API_KEY != '' && '1' || '0' }}
      OPENROUTER_API_KEY_PRESENT: \${{ secrets.OPENROUTER_API_KEY != '' && '1' || '0' }}
      CLAUDE_CODE_OAUTH_TOKEN_PRESENT: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' && '1' || '0' }}${reviewMemoryRuntimeEnvBlock}
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
        if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && github.event_name != 'merge_group' && (env.CODEX_AUTH_JSON_PRESENT == '1' || env.OPENAI_API_KEY_PRESENT == '1' || env.OPENROUTER_API_KEY_PRESENT == '1') }}
        uses: actions/setup-node@v6
        with:
          node-version: "24"

      - name: Install Codex CLI
        if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && github.event_name != 'merge_group' && (env.CODEX_AUTH_JSON_PRESENT == '1' || env.OPENAI_API_KEY_PRESENT == '1' || env.OPENROUTER_API_KEY_PRESENT == '1') }}
        shell: bash
        run: npm install -g @openai/codex@${defaultCodexCliVersion}

      - name: Install Claude Code CLI
        if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && github.event_name != 'merge_group' && env.CLAUDE_CODE_OAUTH_TOKEN_PRESENT == '1' }}
        shell: bash
        run: |
          curl -fsSL https://claude.ai/install.sh | bash -s stable
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"
          "$HOME/.local/bin/claude" --version

      - name: Restore Codex subscription auth
        if: \${{ (github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot')) && github.event_name != 'merge_group' && env.CODEX_AUTH_JSON_PRESENT == '1' }}
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
          CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
`;
}

export function analyzeWorkflowProviderCompatibility(input: {
  readonly workflowYaml: string;
  readonly providerKind: ProviderKind;
  readonly workflowStyle?: ReviewRouterWorkflowStyle;
  readonly expectedActionRef?: string;
}): WorkflowProviderCompatibility {
  const missingRequirements: WorkflowProviderRequirement[] = [];
  const workflowStyle =
    input.workflowStyle ?? inferWorkflowStyle(input.workflowYaml);

  if (
    input.expectedActionRef &&
    !input.workflowYaml.includes(input.expectedActionRef)
  ) {
    missingRequirements.push("action_ref_supports_provider");
  }

  if (input.providerKind === "claude") {
    if (!input.workflowYaml.includes("CLAUDE_CODE_OAUTH_TOKEN")) {
      missingRequirements.push("secret_pass_through");
    }
    if (
      workflowStyle === "explicit" &&
      !input.workflowYaml.includes("Install Claude Code CLI")
    ) {
      missingRequirements.push("cli_install_step");
    }
  }

  if (input.providerKind === "openrouter") {
    if (!input.workflowYaml.includes("OPENROUTER_API_KEY")) {
      missingRequirements.push("secret_pass_through");
    }
    if (
      workflowStyle === "explicit" &&
      !input.workflowYaml.includes("Install Codex CLI")
    ) {
      missingRequirements.push("cli_install_step");
    }
  }

  if (
    workflowStyle === "explicit" &&
    !input.workflowYaml.includes("Skip fork pull requests")
  ) {
    missingRequirements.push("fork_pr_secret_skip");
  }

  if (
    workflowStyle === "reusable" &&
    !input.workflowYaml.includes(reusableReviewWorkflowPath)
  ) {
    missingRequirements.push("trusted_reusable_workflow_ref");
  }

  return {
    providerKind: input.providerKind,
    supported: missingRequirements.length === 0,
    missingRequirements,
  };
}

export function getWorkflowProviderContentMarkerGroups(input: {
  readonly providerKind: ProviderKind;
}): readonly (readonly string[])[] {
  switch (input.providerKind) {
    case "claude":
      return [
        [reusableReviewWorkflowPath, "CLAUDE_CODE_OAUTH_TOKEN"],
        [
          "Install Claude Code CLI",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "Skip fork pull requests",
        ],
      ];
    case "openrouter":
      return [
        [reusableReviewWorkflowPath, "OPENROUTER_API_KEY"],
        ["Install Codex CLI", "OPENROUTER_API_KEY", "Skip fork pull requests"],
      ];
    case "codex":
      return [];
  }
}

export function getWorkflowSetupContentMarkerGroups(input: {
  readonly providerKind?: ProviderKind | undefined;
  readonly conflictReviewFallbackEnabled?: boolean | undefined;
}): readonly (readonly string[])[] {
  const providerMarkerGroups = input.providerKind
    ? getWorkflowProviderContentMarkerGroups({
        providerKind: input.providerKind,
      })
    : [];

  if (input.conflictReviewFallbackEnabled !== true) {
    return providerMarkerGroups;
  }

  const reusableProviderMarkerGroups = providerMarkerGroups.filter((markers) =>
    markers.includes(reusableReviewWorkflowPath),
  );
  const baseMarkerGroups =
    reusableProviderMarkerGroups.length > 0
      ? reusableProviderMarkerGroups
      : [[reusableReviewWorkflowPath]];

  return baseMarkerGroups.map((markers) => [
    ...markers,
    reusableConflictReviewWorkflowPath,
    "repository_dispatch:",
    `types: [${conflictReviewDispatchEventType}]`,
    "conflict-review:",
    "github.event_name == 'repository_dispatch'",
    `github.event.action == '${conflictReviewDispatchEventType}'`,
    `review_kind: ${conflictReviewKind}`,
    "conflict_repository_id:",
    "conflict_dispatch_event_type:",
    "conflict_dispatch_id:",
  ]);
}

export function getCodexRotatingWorkflowSetupContentMarkerGroups(input: {
  readonly providerInstanceId: string;
  readonly claudeCodeOAuthTokenSecret?: boolean | undefined;
  readonly openRouterApiKeySecret?: boolean | undefined;
  readonly forkAgenticSandboxEnabled?: boolean | undefined;
  readonly reviewActionV2Mode?: CodexRotatingReviewActionV2Mode | undefined;
  readonly workflowSchemaVersion?:
    | CodexRotatingT0WorkflowSchemaVersion
    | undefined;
  readonly activeSecretNamespace?: VersionedProviderSecretNamespace;
}): readonly (readonly string[])[] {
  if (
    input.reviewActionV2Mode === CodexRotatingReviewActionV2Mode.T0 &&
    isClientTriggeredT0WorkflowSchemaVersion(input.workflowSchemaVersion)
  ) {
    const workflowSchemaVersion = input.workflowSchemaVersion;
    const defaultTimeoutMinutes = codexRotatingT0DefaultTimeoutMinutesForSchema(
      workflowSchemaVersion,
    );
    const reviewEventName =
      isTrustedDefaultBranchTriggeredCodexWorkflowSchemaVersion(
        workflowSchemaVersion,
      )
        ? "pull_request_target"
        : "pull_request";
    const markers = [
      input.activeSecretNamespace
        ? `name: ReviewRouter Codex OAuth [namespace=${input.activeSecretNamespace.namespaceId};epoch=${input.activeSecretNamespace.epoch};secret=${input.activeSecretNamespace.name}]`
        : "name: ReviewRouter Codex OAuth",
      "run-name: ${{ format('ReviewRouter review PR {0} at {1}'",
      `${reviewEventName}:`,
      "permissions: {}\n\njobs:",
      `github.event_name == '${reviewEventName}'`,
      "    permissions:\n      contents: read\n      pull-requests: read\n      id-token: write",
      ".github/workflows/reviewrouter-t0-reusable.yml@",
      `provider_instance_id: ${JSON.stringify(input.providerInstanceId)}`,
      `workflow_schema_version: ${workflowSchemaVersion}`,
      `max_changed_lines: \${{ vars.${codexRotatingMaxChangedLinesVariableName} }}`,
      `review_timeout_minutes: \${{ fromJSON(vars.${codexRotatingTimeoutMinutesVariableName} || '${defaultTimeoutMinutes}') }}`,
      `CODEX_AUTH_JSON: \${{ secrets.${input.activeSecretNamespace?.name ?? codexRotatingSecretName} }}`,
    ];

    if (input.claudeCodeOAuthTokenSecret === true) {
      markers.push(
        "CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
      );
    }
    if (input.openRouterApiKeySecret === true) {
      markers.push("OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}");
    }

    return [markers];
  }

  const markers = [
    input.activeSecretNamespace
      ? `name: ReviewRouter Codex OAuth [namespace=${input.activeSecretNamespace.namespaceId};epoch=${input.activeSecretNamespace.epoch};secret=${input.activeSecretNamespace.name}]`
      : "name: ReviewRouter Codex OAuth",
    "permissions: {}\n\njobs:",
    "pull_request_target:",
    "    permissions:\n      id-token: write",
    "mode: codex-oauth-rotating",
    `vars.${codexRotatingReviewDraftsVariableName} == 'true'`,
    `review-drafts: \${{ vars.${codexRotatingReviewDraftsVariableName} == 'true' }}`,
    `max-changed-lines: \${{ vars.${codexRotatingMaxChangedLinesVariableName} }}`,
    `timeout-minutes: \${{ fromJSON(vars.${codexRotatingTimeoutMinutesVariableName} || '60') }}`,
    `review-timeout-minutes: \${{ vars.${codexRotatingTimeoutMinutesVariableName} || '60' }}`,
    `provider-instance-id: ${JSON.stringify(input.providerInstanceId)}`,
    `auth-json: \${{ secrets.${input.activeSecretNamespace?.name ?? codexRotatingSecretName} }}`,
  ];

  if (input.claudeCodeOAuthTokenSecret === true) {
    markers.push(
      "claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
  }
  if (input.openRouterApiKeySecret === true) {
    markers.push("openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}");
  }
  if (input.forkAgenticSandboxEnabled === true) {
    markers.push(
      "pull_request_target:",
      "fork-sandbox-review:",
      "vars.REVIEW_ROUTER_FORK_AGENTIC_SANDBOX == 'certified'",
      "mode: fork-agentic-sandbox",
      "REVIEW_ROUTER_PR_WORKSPACE: ${{ github.workspace }}/safe-workspace",
    );
  }

  return [markers];
}

export function getLegacyReviewRouterWorkflowDeletionMarkerGroups(): readonly (readonly string[])[] {
  return [
    ["name: ReviewRouter", reusableReviewWorkflowPath],
    [
      "name: ReviewRouter",
      "uses: 777genius/review-router@",
      "REVIEW_AUTH_MODE",
    ],
  ];
}

export function getLegacyReviewRouterInteractionWorkflowDeletionMarkerGroups(): readonly (readonly string[])[] {
  return [
    ["name: ReviewRouter Interaction", reusableInteractionWorkflowPath],
    ["name: ReviewRouter Interaction", "pull_request_review_comment:"],
  ];
}

export function analyzeConflictReviewWorkflowCapability(input: {
  readonly workflowYaml: string;
}):
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string } {
  const workflow = input.workflowYaml;
  if (workflow.includes("pull_request_target")) {
    return { supported: false, reason: "pull_request_target_forbidden" };
  }
  if (!/^ {2}repository_dispatch:\s*$/m.test(workflow)) {
    return { supported: false, reason: "repository_dispatch_missing" };
  }
  if (
    !new RegExp(
      `^ {4}types:\\s*\\[${escapeRegExp(conflictReviewDispatchEventType)}\\]\\s*$`,
      "m",
    ).test(workflow)
  ) {
    return { supported: false, reason: "conflict_dispatch_type_missing" };
  }
  if (!workflow.includes(reusableReviewWorkflowPath)) {
    return { supported: false, reason: "reusable_review_workflow_missing" };
  }
  if (!workflow.includes(reusableConflictReviewWorkflowPath)) {
    return { supported: false, reason: "conflict_reusable_workflow_missing" };
  }
  if (!isCompactReusableCallerWorkflow(workflow)) {
    return {
      supported: false,
      reason: "conflict_fallback_workflow_shape_untrusted",
    };
  }
  const reusableRuntimeRefs = extractReusableCallerRuntimeRefs(workflow);
  if (
    reusableRuntimeRefs.length === 0 ||
    new Set(reusableRuntimeRefs).size !== 1 ||
    !reusableRuntimeRefs.every(isTrustedConflictReviewReusableRuntimeRef)
  ) {
    return {
      supported: false,
      reason: "conflict_reusable_workflow_ref_untrusted",
    };
  }
  const permissionsSection =
    getTopLevelSection(workflow, "permissions:", "concurrency:") ??
    getTopLevelSection(workflow, "permissions:", "jobs:");
  if (
    permissionsSection &&
    (permissionsSection.includes(": write") ||
      permissionsSection.includes("write-all") ||
      permissionsSection.includes("read-all"))
  ) {
    return { supported: false, reason: "workflow_write_permissions_forbidden" };
  }
  if (!hasSafeConflictReviewJobPermissions(workflow)) {
    return {
      supported: false,
      reason: "conflict_workflow_write_permissions_forbidden",
    };
  }
  const concurrencySection = getTopLevelSection(
    workflow,
    "concurrency:",
    "jobs:",
  );
  if (
    !concurrencySection ||
    !concurrencySection.includes("github.run_id") ||
    concurrencySection.includes("client_payload")
  ) {
    return { supported: false, reason: "conflict_concurrency_missing" };
  }
  if (
    !workflow.includes(`review_kind:`) ||
    !workflow.includes(conflictReviewKind)
  ) {
    return { supported: false, reason: "conflict_review_kind_missing" };
  }
  if (
    ![
      "conflict_dispatch_id:",
      "conflict_dispatch_event_type:",
      "conflict_dispatch_nonce:",
      "conflict_repository_id:",
      "conflict_head_sha:",
      "conflict_base_ref:",
      "conflict_base_sha:",
    ].every((marker) => workflow.includes(marker))
  ) {
    return { supported: false, reason: "conflict_dispatch_inputs_missing" };
  }
  return { supported: true };
}

function isCompactReusableCallerWorkflow(workflowYaml: string): boolean {
  if (/^\s+(runs-on|steps|run):/m.test(workflowYaml)) {
    return false;
  }
  const reviewJob = getJobSection(workflowYaml, "review");
  const conflictReviewJob = getJobSection(workflowYaml, "conflict-review");
  if (!reviewJob || !conflictReviewJob) {
    return false;
  }
  const allJobUses = extractJobLevelUses(workflowYaml);
  if (allJobUses.length !== 2 || !hasExactReusableCallerJobs(allJobUses)) {
    return false;
  }
  return (
    extractJobLevelUses(reviewJob).length === 1 &&
    extractJobLevelUses(conflictReviewJob).length === 1 &&
    reviewJob.includes(
      "if: ${{ github.event_name != 'repository_dispatch' }}",
    ) &&
    conflictReviewJob.includes("github.event_name == 'repository_dispatch'") &&
    conflictReviewJob.includes(
      `github.event.action == '${conflictReviewDispatchEventType}'`,
    )
  );
}

function hasSafeConflictReviewJobPermissions(workflowYaml: string): boolean {
  const conflictReviewJob = getJobSection(workflowYaml, "conflict-review");
  if (!conflictReviewJob) {
    return false;
  }
  const permissionsSection = getJobNestedSection(
    conflictReviewJob,
    "permissions:",
  );
  if (!permissionsSection) {
    return false;
  }
  if (
    !permissionsSection.includes("      contents: read") ||
    !permissionsSection.includes("      id-token: write")
  ) {
    return false;
  }
  if (
    permissionsSection.includes("write-all") ||
    permissionsSection.includes("read-all")
  ) {
    return false;
  }
  const permissionEntries = permissionsSection
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "permissions:");
  return (
    permissionEntries.length === 2 &&
    permissionEntries.every(
      (line) => line === "contents: read" || line === "id-token: write",
    )
  );
}

function extractReusableCallerRuntimeRefs(
  workflowYaml: string,
): readonly string[] {
  return extractJobLevelUses(workflowYaml)
    .map(
      (uses) =>
        /^777genius\/review-router\/\.github\/workflows\/reviewrouter-reusable\.ya?ml@(\S+)$/i.exec(
          uses,
        ) ??
        /^777genius\/review-router\/\.github\/workflows\/reviewrouter-conflict-reusable\.ya?ml@(\S+)$/i.exec(
          uses,
        ),
    )
    .flatMap((match) => (match?.[1] ? [match[1]] : []));
}

function extractJobLevelUses(workflowYaml: string): readonly string[] {
  return [...workflowYaml.matchAll(/^ {4}uses:\s+(\S+)$/gm)].map(
    (match) => match[1] ?? "",
  );
}

function hasExactReusableCallerJobs(jobUses: readonly string[]): boolean {
  return (
    jobUses.some((uses) =>
      /^777genius\/review-router\/\.github\/workflows\/reviewrouter-reusable\.ya?ml@\S+$/i.test(
        uses,
      ),
    ) &&
    jobUses.some((uses) =>
      /^777genius\/review-router\/\.github\/workflows\/reviewrouter-conflict-reusable\.ya?ml@\S+$/i.test(
        uses,
      ),
    )
  );
}

function getJobSection(workflowYaml: string, jobId: string): string | null {
  const startMatch = new RegExp(`^ {2}${escapeRegExp(jobId)}:\\s*$`, "m").exec(
    workflowYaml,
  );
  if (!startMatch) {
    return null;
  }
  const start = startMatch.index;
  const afterStart = start + startMatch[0].length;
  const remainder = workflowYaml.slice(afterStart);
  const nextJobMatch = /^ {2}[A-Za-z0-9_-]+:\s*$/m.exec(remainder);
  const end = nextJobMatch
    ? afterStart + nextJobMatch.index
    : workflowYaml.length;
  return workflowYaml.slice(start, end);
}

function getJobNestedSection(
  jobSection: string,
  nestedMarker: string,
): string | null {
  const startMatch = new RegExp(
    `^ {4}${escapeRegExp(nestedMarker)}\\s*$`,
    "m",
  ).exec(jobSection);
  if (!startMatch) {
    return null;
  }
  const start = startMatch.index;
  const afterStart = start + startMatch[0].length;
  const remainder = jobSection.slice(afterStart);
  const nextNestedMatch = /^ {4}[A-Za-z0-9_-]+:\s*/m.exec(remainder);
  const end = nextNestedMatch
    ? afterStart + nextNestedMatch.index
    : jobSection.length;
  return jobSection.slice(start, end);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTrustedConflictReviewReusableRuntimeRef(
  runtimeRef: string,
): boolean {
  return /^(v1|v1\.[0-9]+\.[0-9]+|[a-fA-F0-9]{40})$/i.test(runtimeRef);
}

function getTopLevelSection(
  workflowYaml: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const start = workflowYaml.indexOf(startMarker);
  if (start === -1) return null;
  const end = workflowYaml.indexOf(endMarker, start);
  return workflowYaml.slice(start, end === -1 ? undefined : end);
}

function inferWorkflowStyle(workflowYaml: string): ReviewRouterWorkflowStyle {
  return workflowYaml.includes(`${reusableWorkflowRuntimeRepository}/`)
    ? "reusable"
    : "explicit";
}

export function renderReviewRouterWorkflowFiles(
  options: ReviewRouterWorkflowOptions,
): readonly ReviewRouterWorkflowFile[] {
  if (options.codexRotatingProviderInstanceId) {
    if (options.conflictReviewFallbackEnabled === true) {
      throw new Error("codex_rotating_conflict_review_unsupported");
    }
    return [
      {
        path: defaultCodexRotatingWorkflowPath,
        content: renderCodexRotatingAdvisoryWorkflow({
          actionRef: options.actionRef,
          apiUrl: options.apiUrl,
          providerInstanceId: options.codexRotatingProviderInstanceId,
          ...(options.codexRotatingActiveSecretNamespace
            ? {
                activeSecretNamespace:
                  options.codexRotatingActiveSecretNamespace,
              }
            : {}),
          ...(options.codexRotatingWorkflowSchemaVersion !== undefined
            ? {
                workflowSchemaVersion:
                  options.codexRotatingWorkflowSchemaVersion,
              }
            : {}),
          ...(options.codexRotatingReviewActionV2Mode
            ? {
                reviewActionV2Mode: options.codexRotatingReviewActionV2Mode,
              }
            : {}),
          ...codexRotatingProviderSecretInputsForRuntimeEnv(
            options.staticRuntimeEnv,
          ),
          forkAgenticSandboxEnabled: options.forkAgenticSandboxEnabled === true,
        }),
      },
      {
        path: defaultWorkflowPath,
        operation: "delete",
        markerGroups: getLegacyReviewRouterWorkflowDeletionMarkerGroups(),
      },
      {
        path: defaultInteractionWorkflowPath,
        content: renderCodexRotatingInteractionWorkflow({
          actionRef: options.actionRef,
          apiUrl: options.apiUrl,
          runtimeConfigMode: options.runtimeConfigMode,
        }),
      },
    ];
  }

  if (options.forkAgenticSandboxEnabled === true) {
    throw new Error("fork_agentic_sandbox_requires_codex_rotating");
  }

  if (
    options.conflictReviewFallbackEnabled === true &&
    (options.workflowStyle ?? "reusable") !== "reusable"
  ) {
    throw new Error("conflict_review_explicit_workflow_unsupported");
  }

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

function codexRotatingProviderSecretInputsForRuntimeEnv(
  runtimeEnv: Readonly<Record<string, string>> | undefined,
): {
  readonly claudeCodeOAuthTokenSecret: boolean;
  readonly openRouterApiKeySecret: boolean;
} {
  const providers = runtimeEnv?.REVIEW_PROVIDERS ?? "";
  return {
    claudeCodeOAuthTokenSecret: providers
      .split(",")
      .some((provider) => provider.trim().startsWith("claude/")),
    openRouterApiKeySecret: providers
      .split(",")
      .some((provider) => provider.trim().startsWith("openrouter/")),
  };
}

function prepareReusableWorkflowTemplate(
  options: ReviewRouterWorkflowOptions,
): {
  readonly runtimeRef: string;
  readonly staticRuntimeEnvJsonBlock: string;
} {
  assertSafeApiUrl(options.apiUrl);
  const runtimeRef = extractReusableRuntimeRef(options.actionRef);
  if (
    options.conflictReviewFallbackEnabled === true &&
    !isTrustedConflictReviewReusableRuntimeRef(runtimeRef)
  ) {
    throw new Error("invalid_conflict_review_reusable_workflow_runtime_ref");
  }
  const staticRuntimeEnv = options.staticRuntimeEnv ?? {};
  for (const [key, value] of Object.entries(staticRuntimeEnv)) {
    assertSafeEnvKey(key);
    if (typeof value !== "string") {
      throw new Error("invalid_workflow_env_value");
    }
  }

  return {
    runtimeRef,
    staticRuntimeEnvJsonBlock: indentMultiline(
      JSON.stringify(staticRuntimeEnv, null, 2),
      "        ",
    ),
  };
}

function indentMultiline(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
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
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("invalid_workflow_api_url");
  }
  const local = isLoopbackHostname(parsed.hostname);
  if (parsed.protocol === "https:" && !local) {
    return;
  }
  if (parsed.protocol === "http:" && local) {
    return;
  }

  throw new Error("invalid_workflow_api_url");
}

function assertSafeEnvKey(key: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error("invalid_workflow_env_key");
  }
}
