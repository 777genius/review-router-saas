#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const sourceRoots = [
  ".github",
  "action-dist",
  "apps",
  "deploy",
  "packages",
  "scripts",
];
const runtimeSecretGateway =
  "apps/api/src/github/octokit-codex-rotating-github-secret-gateway.ts";
const allowedOneShotTransport =
  "apps/api/src/github/one-shot-github-secret-put.ts";
const rotatingInstaller = "scripts/seed-codex-rotating-auth.sh";
const rotatingReseedInstaller = "scripts/reseed-codex-rotating-auth.sh";
const legacyInstaller = "scripts/seed-codex-auth.sh";
const runtimeDispatcher =
  "packages/features/action-control-plane/src/application/services/codex-rotating-versioned-writeback-dispatcher.ts";
const runtimeLedger =
  "packages/features/action-control-plane/src/infrastructure/prisma/prisma-codex-rotating-oauth-repository.ts";
const runtimeComposition = "apps/api/src/app.ts";

export function checkCodexSecretWriteBoundary(checkoutRoot = root) {
  const failures = [];
  for (const file of walkSources(checkoutRoot)) {
    const path = relative(checkoutRoot, file).replaceAll("\\", "/");
    if (
      path === "scripts/check-codex-secret-write-boundary.mjs" ||
      path === "scripts/check-codex-secret-write-boundary.test.ts"
    )
      continue;
    const source = readFileSync(file, "utf8");
    const directGhSecretSetCount =
      path.endsWith(".sh") ||
      /\b(?:execFile|exec|spawn|execa)\s*\([\s\S]{0,500}\bgh\s+secret\s+set\b/u.test(
        source,
      )
        ? (source.match(/\bgh\s+secret\s+set\b/gu)?.length ?? 0)
        : 0;
    if (
      directGhSecretSetCount > 0 &&
      path !== rotatingInstaller &&
      path !== legacyInstaller &&
      !path.endsWith(".test.ts")
    ) {
      failures.push(`${path}: direct gh secret set outside audited installer`);
    }
    if (source.includes("GH_HTTP_RETRY_MAX")) {
      failures.push(`${path}: unsupported GH_HTTP_RETRY_MAX`);
    }
    if (/REVIEWROUTER_CODEX_AUTH_JSON_V[0-9<]/u.test(source)) {
      failures.push(`${path}: conflicting V namespace contract`);
    }
    if (
      source.includes("createOrUpdateRepoSecret") &&
      path !== allowedOneShotTransport &&
      !path.endsWith(".test.ts")
    ) {
      failures.push(
        `${path}: direct Octokit secret PUT outside audited gateway`,
      );
    }
    if (path === rotatingInstaller) {
      const rotatingWrites =
        source.match(
          /gh\s+secret\s+set\s+"\$SECRET_NAME"[^\n]*(?:\\\n[^\n]*)?/gu,
        ) ?? [];
      const curlConfig = extractShellFunction(source, "write_github_secret");
      const providerConfigBoundary = curlConfig.match(
        /provider_status="\$\(\{([\s\S]*?)\}\s*\|\s*curl\s+-q\s+--config\s+-\s+--data-binary\s+"@\$provider_body"\)/u,
      );
      const providerConfigProducer = providerConfigBoundary?.[1] ?? "";
      const sensitiveCurlInvocations = extractShellCurlInvocations(source);
      const ledgerFunctions = [
        "fetch_setup_manifest",
        "prepare_secret_payload_v2",
        "setup_claim_status",
        "retire_journal_attempt_or_fail",
        "authorize_new_dispatch",
        "record_definite_dispatch_success",
      ].map((name) => extractShellFunction(source, name));
      const ledgerUrlValidation = extractShellFunction(
        source,
        "validate_versioned_ledger_urls",
      );
      const ledgerUrlResolution = extractShellFunction(
        source,
        "resolve_versioned_ledger_urls",
      );
      const installerMain = extractShellFunction(source, "main");
      if (
        directGhSecretSetCount !== 1 ||
        rotatingWrites.length !== 1 ||
        !/--no-store(?:\s|\\|$)/u.test(rotatingWrites[0]) ||
        !curlConfig.includes('url = "https://api.github.com/repos/') ||
        !curlConfig.includes("'http1.1'") ||
        !curlConfig.includes("'no-location'") ||
        !curlConfig.includes("'no-keepalive'") ||
        !curlConfig.includes("'retry = 0'") ||
        !curlConfig.includes("'proto = \"=https\"'") ||
        curlConfig.includes("'data-binary =") ||
        !providerConfigBoundary ||
        providerConfigProducer.includes("provider_body") ||
        /fresh-connect|forbid-reuse|location\s*=\s*false/u.test(curlConfig) ||
        !/\|\s*curl\s+-q\s+--config\s+-\s+--data-binary\s+"@\$provider_body"\)/u.test(
          curlConfig,
        ) ||
        sensitiveCurlInvocations.length !== 7 ||
        sensitiveCurlInvocations.some(
          ({ firstArgument }) =>
            firstArgument !== "-q" && firstArgument !== "--disable",
        ) ||
        ledgerFunctions.some(
          (body) =>
            !body.includes("curl -q -fsS --max-redirs 0") ||
            /\s(?:-L|--location)(?:\s|$)/u.test(body),
        ) ||
        ![
          "SETUP_URL",
          "SETUP_PREPARE_URL",
          "SETUP_DISPATCH_URL",
          "SETUP_DISPATCH_OUTCOME_URL",
          "SETUP_STATUS_URL",
        ].every((endpoint) => ledgerUrlValidation.includes(endpoint)) ||
        !source.includes('parsed.protocol !== "https:"') ||
        !source.includes(".origin !== manifestEndpoint.origin") ||
        !ledgerUrlResolution.includes("validate_versioned_ledger_urls") ||
        installerMain.indexOf("resolve_versioned_ledger_urls") < 0 ||
        installerMain.indexOf("resolve_versioned_ledger_urls") >
          installerMain.indexOf("fetch_setup_manifest") ||
        (source.includes(
          "REVIEW_ROUTER_CODEX_ROTATING_CURL_TEST_UNIX_SOCKET",
        ) &&
          !source.includes('[ "${REVIEW_ROUTER_SEED_LIBRARY_ONLY:-0}" = "1" ]'))
      ) {
        failures.push(
          `${path}: rotating write is not the pinned one-shot adapter`,
        );
      }
    }
    if (path === rotatingReseedInstaller) {
      const reseedCurlInvocations = extractShellCurlInvocations(source);
      if (
        reseedCurlInvocations.length !== 1 ||
        reseedCurlInvocations[0]?.firstArgument !== "-q" ||
        !reseedCurlInvocations[0]?.line.includes("--max-redirs 0") ||
        !source.includes("Authorization: Bearer")
      ) {
        failures.push(
          `${path}: authenticated reseed curl does not disable ambient config and redirects`,
        );
      }
    }
    if (
      path === legacyInstaller &&
      (!source.includes("REVIEW_ROUTER_ENABLE_LEGACY_CODEX_AUTH_SEED") ||
        !/main\(\)\s*\{[\s\S]{0,300}is_true\s+"\$ENABLE_LEGACY_CODEX_AUTH_SEED"\s+\|\|\s+fatal/u.test(
          source,
        ))
    ) {
      failures.push(`${path}: legacy fixed-name writer is not opt-in gated`);
    }

    const isAuditedRuntimeWriter = path === allowedOneShotTransport;
    const providerPutCount = countProviderSecretPutSites(source);
    if (
      providerPutCount > 0 &&
      path !== rotatingInstaller &&
      !isAuditedRuntimeWriter &&
      !path.endsWith(".test.ts")
    ) {
      failures.push(`${path}: provider secret PUT outside audited adapter`);
    }
    if (path === allowedOneShotTransport && providerPutCount !== 1) {
      failures.push(
        `${path}: runtime gateway must expose exactly one provider PUT`,
      );
    }
  }
  requireRuntimeWritebackAudit(checkoutRoot, failures);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return {
    status: "pass",
    auditedAdapters: [
      rotatingInstaller,
      rotatingReseedInstaller,
      runtimeSecretGateway,
      allowedOneShotTransport,
      runtimeDispatcher,
      runtimeLedger,
      runtimeComposition,
    ],
  };
}

function extractShellCurlInvocations(source) {
  const invocations = [];
  // Shell continuations form one command. Scan logical lines so security flags
  // cannot be missed merely because formatting moved them below `curl`.
  const logicalSource = source.replace(/\\\r?\n[ \t]*/gu, " ");
  for (const line of logicalSource.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    for (const match of line.matchAll(/(?:^|[($|])\s*curl\s+([^\s\\]+)/gu)) {
      invocations.push({ firstArgument: match[1], line });
    }
  }
  return invocations;
}

function countProviderSecretPutSites(source) {
  const methodSites = [
    ...source.matchAll(
      /(?:method\s*:\s*|request\s*\(\s*)["']PUT(?:\s+|["'])/gu,
    ),
    ...source.matchAll(/method\s*:\s*\[\s*["']P["']\s*,\s*["']UT["']\s*\]/gu),
  ];
  const hasConstructedSecretPath =
    /["'`]repos["'`]/u.test(source) &&
    /["'`]actions["'`]/u.test(source) &&
    /["'`]secrets["'`]/u.test(source) &&
    !/["'`]public-key["'`]/u.test(source);
  return methodSites.filter((match) => {
    const start = Math.max(0, (match.index ?? 0) - 1_500);
    const end = Math.min(source.length, (match.index ?? 0) + 1_500);
    const window = source.slice(start, end);
    const literalPath = /actions\/secrets\/(?!public-key)/u.test(window);
    const constructedPath = hasConstructedSecretPath;
    return literalPath || constructedPath;
  }).length;
}

function requireRuntimeWritebackAudit(checkoutRoot, failures) {
  if (!existsSync(resolve(checkoutRoot, "package.json"))) return;
  const dispatcher = readFileSync(
    resolve(checkoutRoot, runtimeDispatcher),
    "utf8",
  );
  const ledger = readFileSync(resolve(checkoutRoot, runtimeLedger), "utf8");
  const composition = readFileSync(
    resolve(checkoutRoot, runtimeComposition),
    "utf8",
  );
  const orderedDispatcherCapabilities = [
    "prepareVersionedWriteback",
    "putEncryptedRepositorySecret",
    "confirmVersionedProviderWrite",
    "publishAndVerifyVersionedWorkflow",
    "activateVersionedWriteback",
  ];
  let cursor = -1;
  for (const capability of orderedDispatcherCapabilities) {
    cursor = dispatcher.indexOf(capability, cursor + 1);
    if (cursor < 0) {
      failures.push(
        `${runtimeDispatcher}: missing ordered ${capability} capability`,
      );
      break;
    }
  }
  if (
    !dispatcher.includes("retireAmbiguousVersionedWriteback") ||
    !dispatcher.includes(
      "RuntimeVersionedDurableMarker.ProviderPutOutcomeUnknown",
    ) ||
    !dispatcher.includes(
      "RuntimeVersionedDurableMarker.ProviderConfirmationOutcomeUnknown",
    ) ||
    !dispatcher.includes(
      "RuntimeVersionedDurableMarker.WorkflowOrActivationOutcomeUnknown",
    )
  ) {
    failures.push(
      `${runtimeDispatcher}: ambiguous edges are not all tombstoned`,
    );
  }
  for (const token of [
    "mapActiveVersionedProviderSecretNamespace",
    "readDatabaseIncarnation",
    "assertDatabaseIncarnation",
    'status: "dispatch_authorized"',
    'status: "retired_ambiguous"',
    "activeAccountIdentityHash",
    'mutationOwner: "runtime"',
    "mutationEpoch: { increment: 1 }",
  ]) {
    if (!ledger.includes(token)) {
      failures.push(`${runtimeLedger}: missing audited invariant ${token}`);
    }
  }
  if (ledger.includes("allocateVersionedProviderSecretNamespace")) {
    failures.push(
      `${runtimeLedger}: runtime refresh must not allocate a workflow-bound namespace`,
    );
  }
  if (
    !/new CodexRotatingVersionedWritebackDispatcher\(\s*codexRotatingOAuth,\s*codexRotatingGitHubSecretGateway,\s*codexRotatingGitHubSecretGateway,/su.test(
      composition,
    )
  ) {
    failures.push(
      `${runtimeComposition}: production versioned writer is not wired`,
    );
  }
}

function extractShellFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) return "";
  const next = source.indexOf("\n}\n", start);
  return next < 0 ? "" : source.slice(start, next + 3);
}

function walkSources(checkoutRoot) {
  const files = [];
  for (const sourceRoot of sourceRoots) {
    const start = resolve(checkoutRoot, sourceRoot);
    try {
      visit(start, files);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return files;
}

function visit(path, files) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (["node_modules", ".next", "dist", "coverage"].includes(name))
        continue;
      visit(resolve(path, name), files);
    }
  } else if (
    [
      ".bash",
      ".cjs",
      ".cts",
      ".js",
      ".mjs",
      ".mts",
      ".sh",
      ".ts",
      ".tsx",
      ".yaml",
      ".yml",
    ].includes(extname(path))
  ) {
    files.push(path);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.stdout.write(`${JSON.stringify(checkCodexSecretWriteBoundary())}\n`);
}
