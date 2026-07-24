import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ReviewMutationAuthorityCommandKind,
  ReviewMutationAuthorityPreflightStatus,
  ReviewMutationLaneKind,
  ProducerReleaseState,
  ReviewSafetyCapability,
  ReviewSafetyPolicyScope,
  ReviewSafetyRolloutMode,
  ScmProvider,
  canonicalReviewOperationalSloProfile,
  canonicalReviewProtocolLimits,
  reviewMutationAuthorityProofReference,
  type ProducerReleaseCandidate,
  type ReviewOperationalSloThresholds,
  type ReviewProtocolLimits,
} from "@reviewrouter/features-review-run-control";
import {
  AuthenticatedReviewMutationAuthorityOperatorService,
  HashedReviewMutationOperatorAuthenticator,
  ReviewMutationOperatorPermission,
} from "@reviewrouter/features-review-run-control/composition";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { composeReviewActionV2ProductionRunControl } from "./review-action-v2-production-composition.js";

const requiredRuntimeEnv = Object.freeze([
  "DATABASE_URL",
  "GITHUB_APP_ID",
  "REVIEW_ROUTER_ACTION_OIDC_AUDIENCE",
  "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID",
  "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON",
  "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID",
  "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON",
  "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON",
  "REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON",
  "REVIEW_ROUTER_REVIEW_V2_PROJECTION_POLICY_VERSION",
  "REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256",
]);

const allSafetyCapabilities = Object.freeze(
  Object.values(ReviewSafetyCapability),
);

export type ReviewV2CohortRolloutModes = Readonly<{
  global: ReviewSafetyRolloutMode | null;
  repository: ReviewSafetyRolloutMode;
}>;

export type ReviewV2CohortOperation =
  | "stage-t0"
  | "shadow-context-reuse"
  | "enable-context-reuse"
  | "disable-context-reuse";

export function reviewV2CohortRolloutModes(
  capability: ReviewSafetyCapability,
  operation: ReviewV2CohortOperation = "stage-t0",
): ReviewV2CohortRolloutModes | null {
  switch (capability) {
    case ReviewSafetyCapability.RunAuthorizationV2:
    case ReviewSafetyCapability.EvidenceWritesV2:
    case ReviewSafetyCapability.EvidenceReuseV2:
    case ReviewSafetyCapability.PublicationOperationsV2:
    case ReviewSafetyCapability.MutationEpochV2:
      return operation === "stage-t0"
        ? {
            global: ReviewSafetyRolloutMode.Allowlisted,
            repository: ReviewSafetyRolloutMode.Enabled,
          }
        : null;
    case ReviewSafetyCapability.PromptOnlyReuse:
      return null;
    case ReviewSafetyCapability.ContextGatewayReuse: {
      switch (operation) {
        case "stage-t0":
          return null;
        case "shadow-context-reuse":
          return {
            global: ReviewSafetyRolloutMode.Allowlisted,
            repository: ReviewSafetyRolloutMode.Shadow,
          };
        case "enable-context-reuse":
          return {
            global: ReviewSafetyRolloutMode.Allowlisted,
            repository: ReviewSafetyRolloutMode.Enabled,
          };
        case "disable-context-reuse":
          return {
            global: null,
            repository: ReviewSafetyRolloutMode.Disabled,
          };
        default: {
          const exhaustiveOperation: never = operation;
          return exhaustiveOperation;
        }
      }
    }
    default: {
      const exhaustiveCapability: never = capability;
      return exhaustiveCapability;
    }
  }
}

export function reviewV2CohortEmergencyInitialization(
  existing: { readonly stopped: boolean } | null,
) {
  if (existing) return null;
  return {
    expectedVersion: 0,
    stopped: false,
    reason: "review-v2-cohort-staged",
  } as const;
}

type ParsedArguments = Readonly<{
  positionals: readonly string[];
  options: Readonly<Record<string, string | true>>;
}>;

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.options.help === true || parsed.positionals.length === 0) {
    printUsage();
    return;
  }
  if (parsed.positionals[0] === "env-preflight") {
    printJson(inspectEnvironment(process.env));
    return;
  }

  const prisma = createPrismaClient();
  try {
    const runtime = composeReviewActionV2ProductionRunControl({
      env: process.env,
      prisma,
    });
    const command = parsed.positionals.join(" ");
    if (command === "release register") {
      await authenticateOperator(runtime.digest, process.env);
      requireConfirmation(parsed, "release");
      printJson(await registerRelease(parsed, runtime));
      return;
    }

    const repository = requireOption(parsed, "repo");
    const target = await resolveRepositoryTarget(prisma, runtime, repository);
    if (command === "status") {
      printJson(await readStatus(runtime, target));
      return;
    }

    const credential = requiredEnv(
      process.env,
      "REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL",
    );
    const authentication = createOperatorAuthentication(
      runtime.digest,
      process.env,
    );
    await authenticateOperator(runtime.digest, process.env);
    requireConfirmation(parsed, repository);

    const cohortOperation = reviewV2CohortOperationForCommand(command);
    if (cohortOperation) {
      printJson(
        await updateRepositoryCohortPolicies(runtime, target, cohortOperation),
      );
      return;
    }

    const operator = new AuthenticatedReviewMutationAuthorityOperatorService({
      authentication,
      useCases: runtime.runControl.mutationAuthority,
    });
    printJson(
      await runMutationCommand({
        command,
        parsed,
        credential,
        operator,
        runtime,
        target,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function runMutationCommand(input: {
  readonly command: string;
  readonly parsed: ParsedArguments;
  readonly credential: string;
  readonly operator: AuthenticatedReviewMutationAuthorityOperatorService;
  readonly runtime: ReturnType<
    typeof composeReviewActionV2ProductionRunControl
  >;
  readonly target: Awaited<ReturnType<typeof resolveRepositoryTarget>>;
}) {
  const base = {
    credential: input.credential,
    scmRepositoryIdentityId: input.target.identity.scmRepositoryIdentityId,
  } as const;
  if (input.command === "mutation initialize-v1") {
    return input.operator.initializeV1(base);
  }

  const authority = await requireAuthority(input.runtime, input.target);
  if (input.command === "mutation begin-drain") {
    const release = await requireInstalledRelease(
      input.parsed,
      input.runtime,
      input.target,
    );
    const slo =
      await input.runtime.repositories.producerReleases.findOperationalSloProfileById(
        release.operationalSloProfileId,
      );
    if (!slo) throw new Error("review_v2_operational_slo_missing");
    const drainWindowMs = readPositiveIntegerOption(
      input.parsed,
      "window-ms",
      slo.v1DrainMs,
    );
    if (drainWindowMs < slo.v1DrainMs) {
      throw new Error("review_v2_drain_window_below_release_slo");
    }
    return input.operator.beginDrain({
      ...base,
      expectedVersion: authority.version,
      drainPolicyVersion: readPositiveIntegerOption(
        input.parsed,
        "policy-version",
        1,
      ),
      drainWindowMs,
    });
  }
  if (input.command === "mutation pause") {
    return input.operator.pause({
      ...base,
      expectedVersion: authority.version,
    });
  }
  const operation = operationForProofedCommand(input.command);
  const preflight = await input.operator.preflight({ ...base, operation });
  if (
    preflight.status !== ReviewMutationAuthorityPreflightStatus.Ready ||
    !preflight.proof
  ) {
    throw new Error(
      `review_v2_mutation_preflight_blocked:${
        "blockers" in preflight
          ? preflight.blockers.join(",")
          : preflight.status
      }`,
    );
  }
  const proof = reviewMutationAuthorityProofReference(preflight.proof);
  if (input.command === "mutation activate") {
    return input.operator.activate({
      ...base,
      expectedVersion: authority.version,
      proof,
    });
  }
  if (input.command === "mutation abort-drain") {
    return input.operator.abortDrain({
      ...base,
      expectedVersion: authority.version,
      proof,
    });
  }
  if (input.command === "mutation resume") {
    return input.operator.resume({
      ...base,
      expectedVersion: authority.version,
      proof,
    });
  }
  throw new Error(`review_v2_operator_command_unknown:${input.command}`);
}

function operationForProofedCommand(command: string) {
  switch (command) {
    case "mutation activate":
      return ReviewMutationAuthorityCommandKind.Activate;
    case "mutation abort-drain":
      return ReviewMutationAuthorityCommandKind.AbortDrain;
    case "mutation resume":
      return ReviewMutationAuthorityCommandKind.Resume;
    default:
      throw new Error(`review_v2_operator_command_unknown:${command}`);
  }
}

async function updateRepositoryCohortPolicies(
  runtime: ReturnType<typeof composeReviewActionV2ProductionRunControl>,
  target: Awaited<ReturnType<typeof resolveRepositoryTarget>>,
  operation: ReviewV2CohortOperation,
) {
  const updatedBy = "review-v2-operator";
  const globalScope = { scope: ReviewSafetyPolicyScope.Global } as const;
  const repositoryScope = {
    scope: ReviewSafetyPolicyScope.Repository,
    workspaceId: target.identity.currentWorkspaceId!,
    repositoryConnectionId: target.identity.currentRepositoryConnectionId!,
    scmRepositoryIdentityId: target.identity.scmRepositoryIdentityId,
  } as const;
  const results = [];
  for (const capability of allSafetyCapabilities) {
    const rolloutModes = reviewV2CohortRolloutModes(capability, operation);
    if (!rolloutModes) continue;
    if (rolloutModes.global !== null) {
      const global =
        await runtime.repositories.safetyControls.findReviewSafetyPolicy({
          scope: globalScope,
          capability,
        });
      results.push(
        await runtime.runControl.safetyControls.updateReviewSafetyPolicy({
          expectedVersion: global?.version ?? 0,
          scope: globalScope,
          capability,
          rolloutMode: rolloutModes.global,
          updatedBy,
        }),
      );
    }
    const repository =
      await runtime.repositories.safetyControls.findReviewSafetyPolicy({
        scope: repositoryScope,
        capability,
      });
    results.push(
      await runtime.runControl.safetyControls.updateReviewSafetyPolicy({
        expectedVersion: repository?.version ?? 0,
        scope: repositoryScope,
        capability,
        rolloutMode: rolloutModes.repository,
        updatedBy,
      }),
    );
  }
  if (operation === "stage-t0") {
    for (const scope of [globalScope, repositoryScope]) {
      const existing =
        await runtime.repositories.safetyControls.findReviewSafetyEmergencyControl(
          scope,
        );
      const initialization = reviewV2CohortEmergencyInitialization(existing);
      if (!initialization) continue;
      results.push(
        await runtime.runControl.safetyControls.setReviewSafetyEmergencyStop({
          ...initialization,
          scope,
          updatedBy,
        }),
      );
    }
  }
  return { repository: target.repository.fullName, operation, results };
}

export function reviewV2CohortOperationForCommand(
  command: string,
): ReviewV2CohortOperation | null {
  switch (command) {
    case "cohort stage":
      return "stage-t0";
    case "cohort context-reuse shadow":
      return "shadow-context-reuse";
    case "cohort context-reuse enable":
      return "enable-context-reuse";
    case "cohort context-reuse disable":
      return "disable-context-reuse";
    default:
      return null;
  }
}

async function registerRelease(
  parsed: ParsedArguments,
  runtime: ReturnType<typeof composeReviewActionV2ProductionRunControl>,
) {
  const bundle = await readJsonObject(requireOption(parsed, "bundle"));
  const limits = requireObject(bundle, "limits") as ReviewProtocolLimits;
  const thresholds = requireObject(
    bundle,
    "thresholds",
  ) as ReviewOperationalSloThresholds;
  const ownerRefs = requireStringArray(bundle, "ownerRefs");
  const runbookRefs = requireStringArray(bundle, "runbookRefs");
  const candidate = requireObject(
    bundle,
    "candidate",
  ) as ProducerReleaseCandidate;
  const protocolLimitsProfileId = requireString(
    bundle,
    "protocolLimitsProfileId",
  );
  const operationalSloProfileId = requireString(
    bundle,
    "operationalSloProfileId",
  );
  const limitsDigest = await runtime.digest.digestUtf8(
    canonicalReviewProtocolLimits(limits),
  );
  const sloDigest = await runtime.digest.digestUtf8(
    canonicalReviewOperationalSloProfile({
      thresholds,
      ownerRefs,
      runbookRefs,
    }),
  );
  const limitsResult =
    await runtime.runControl.producerReleases.registerProtocolLimitsProfile({
      protocolLimitsProfileId,
      limitsDigest,
      limits,
    });
  const sloResult =
    await runtime.runControl.producerReleases.registerOperationalSloProfile({
      operationalSloProfileId,
      sloDigest,
      thresholds,
      ownerRefs,
      runbookRefs,
    });
  const releaseResult =
    await runtime.runControl.producerReleases.registerProducerRelease({
      candidate: {
        ...candidate,
        protocolLimitsProfileId,
        operationalSloProfileId,
      },
      expectedProtocolLimitsDigest: limitsDigest,
      expectedOperationalSloDigest: sloDigest,
    });
  return { limitsResult, sloResult, releaseResult };
}

async function readStatus(
  runtime: ReturnType<typeof composeReviewActionV2ProductionRunControl>,
  target: Awaited<ReturnType<typeof resolveRepositoryTarget>>,
) {
  const authority =
    await runtime.repositories.mutationAuthorities.findReviewMutationAuthority({
      scmRepositoryIdentityId: target.identity.scmRepositoryIdentityId,
      laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
    });
  const policies = [];
  for (const capability of allSafetyCapabilities) {
    policies.push({
      capability,
      global: await runtime.repositories.safetyControls.findReviewSafetyPolicy({
        scope: { scope: ReviewSafetyPolicyScope.Global },
        capability,
      }),
      repository:
        await runtime.repositories.safetyControls.findReviewSafetyPolicy({
          scope: {
            scope: ReviewSafetyPolicyScope.Repository,
            workspaceId: target.identity.currentWorkspaceId!,
            repositoryConnectionId:
              target.identity.currentRepositoryConnectionId!,
            scmRepositoryIdentityId: target.identity.scmRepositoryIdentityId,
          },
          capability,
        }),
    });
  }
  return {
    repository: target.repository.fullName,
    identity: target.identity,
    authority,
    policies,
  };
}

async function requireAuthority(
  runtime: ReturnType<typeof composeReviewActionV2ProductionRunControl>,
  target: Awaited<ReturnType<typeof resolveRepositoryTarget>>,
) {
  const authority =
    await runtime.repositories.mutationAuthorities.findReviewMutationAuthority({
      scmRepositoryIdentityId: target.identity.scmRepositoryIdentityId,
      laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
    });
  if (!authority) throw new Error("review_v2_mutation_authority_missing");
  return authority;
}

async function resolveRepositoryTarget(
  prisma: ReturnType<typeof createPrismaClient>,
  runtime: ReturnType<typeof composeReviewActionV2ProductionRunControl>,
  fullName: string,
) {
  const repository = await prisma.repositoryConnection.findFirst({
    where: {
      provider: "github",
      fullName,
      selected: true,
      archived: false,
    },
    select: {
      id: true,
      workspaceId: true,
      fullName: true,
      externalRepositoryId: true,
      scmRepositoryIdentityId: true,
    },
  });
  if (!repository) throw new Error("review_v2_repository_not_found");
  const actionRepository =
    await runtime.actionRepositories.findSelectedRepositoryByGithubId(
      repository.externalRepositoryId,
    );
  if (
    !actionRepository ||
    actionRepository.repositoryId !== repository.id ||
    actionRepository.workspaceId !== repository.workspaceId
  ) {
    throw new Error("review_v2_action_repository_unbound");
  }
  const identity = repository.scmRepositoryIdentityId
    ? await runtime.repositories.repositoryIdentities.findScmRepositoryIdentityById(
        repository.scmRepositoryIdentityId,
      )
    : await runtime.repositories.repositoryIdentities.findScmRepositoryIdentityByExternalIdentity(
        {
          provider: ScmProvider.GitHub,
          normalizedSourceBaseUrl: "https://github.com",
          externalRepositoryId: repository.externalRepositoryId,
        },
      );
  if (
    !identity ||
    identity.currentWorkspaceId !== repository.workspaceId ||
    identity.currentRepositoryConnectionId !== repository.id
  ) {
    throw new Error("review_v2_repository_identity_unbound");
  }
  return { repository, actionRepository, identity } as const;
}

async function requireInstalledRelease(
  parsed: ParsedArguments,
  runtime: ReturnType<typeof composeReviewActionV2ProductionRunControl>,
  target: Awaited<ReturnType<typeof resolveRepositoryTarget>>,
) {
  const release =
    await runtime.repositories.producerReleases.findProducerReleaseById(
      requireOption(parsed, "release"),
    );
  if (!release || release.state !== ProducerReleaseState.Registered) {
    throw new Error("review_v2_registered_release_missing");
  }
  const inventory =
    await runtime.workflowInventory.inspectReviewV2ManagedWorkflowInventory({
      githubInstallationId: target.actionRepository.githubInstallationId,
      githubRepositoryId: target.actionRepository.githubRepositoryId,
      repositoryFullName: target.actionRepository.fullName,
      owner: target.actionRepository.owner,
    });
  if (
    !inventory.compatible ||
    inventory.actionCommitSha !== release.actionCommitSha
  ) {
    throw new Error("review_v2_release_workflow_mismatch");
  }
  return release;
}

function createOperatorAuthentication(
  digest: ReturnType<
    typeof composeReviewActionV2ProductionRunControl
  >["digest"],
  env: Readonly<Record<string, string | undefined>>,
) {
  return new HashedReviewMutationOperatorAuthenticator(digest, [
    {
      operatorId: "review-v2-operator",
      credentialSha256: requiredEnv(
        env,
        "REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256",
      ),
      permissions: [ReviewMutationOperatorPermission.ControlMutationAuthority],
    },
  ]);
}

async function authenticateOperator(
  digest: ReturnType<
    typeof composeReviewActionV2ProductionRunControl
  >["digest"],
  env: Readonly<Record<string, string | undefined>>,
) {
  const authentication = createOperatorAuthentication(digest, env);
  const principal = await authentication.authenticate({
    credential: requiredEnv(env, "REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL"),
    operation: ReviewMutationAuthorityCommandKind.InitializeV1,
  });
  if (!principal) throw new Error("review_v2_operator_unauthorized");
  return principal;
}

export function inspectEnvironment(
  env: Readonly<Record<string, string | undefined>>,
) {
  const missing = requiredRuntimeEnv.filter((name) => !env[name]?.trim());
  if (!readPrivateKey(env)) missing.push("GITHUB_APP_PRIVATE_KEY");
  const invalid: string[] = [];
  for (const name of [
    "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON",
    "REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON",
    "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON",
    "REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON",
  ]) {
    const value = env[name];
    if (!value) continue;
    try {
      JSON.parse(value);
    } catch {
      invalid.push(name);
    }
  }
  const credential = env.REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL;
  const expected = env.REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256;
  if (
    credential &&
    expected &&
    createHash("sha256").update(credential, "utf8").digest("hex") !== expected
  ) {
    invalid.push("REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256");
  }
  return {
    ready: missing.length === 0 && invalid.length === 0,
    missing: [...new Set(missing)].sort(),
    invalid: [...new Set(invalid)].sort(),
  } as const;
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[name] = true;
      continue;
    }
    options[name] = next;
    index += 1;
  }
  return { positionals, options };
}

function requireConfirmation(parsed: ParsedArguments, expected: string) {
  if (parsed.options.confirm !== expected) {
    throw new Error(`review_v2_confirmation_required:${expected}`);
  }
}

function requireOption(parsed: ParsedArguments, name: string): string {
  const value = parsed.options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`review_v2_option_required:${name}`);
  }
  return value;
}

function readPositiveIntegerOption(
  parsed: ParsedArguments,
  name: string,
  fallback: number,
) {
  const value = parsed.options[name];
  if (value === undefined) return fallback;
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`review_v2_option_invalid:${name}`);
  }
  return parsedValue;
}

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`review_v2_env_required:${name}`);
  return value;
}

function readPrivateKey(env: Readonly<Record<string, string | undefined>>) {
  return (
    env.GITHUB_APP_PRIVATE_KEY?.trim() || env.GITHUB_APP_PRIVATE_KEY_B64?.trim()
  );
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("review_v2_bundle_invalid");
  }
  return parsed as Record<string, unknown>;
}

function requireObject(input: Record<string, unknown>, name: string) {
  const value = input[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`review_v2_bundle_field_invalid:${name}`);
  }
  return value as Record<string, unknown>;
}

function requireString(input: Record<string, unknown>, name: string) {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`review_v2_bundle_field_invalid:${name}`);
  }
  return value;
}

function requireStringArray(input: Record<string, unknown>, name: string) {
  const value = input[name];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`review_v2_bundle_field_invalid:${name}`);
  }
  return value as string[];
}

function printJson(value: unknown) {
  process.stdout.write(`${serializeOperatorCliJson(value)}\n`);
}

export function serializeOperatorCliJson(value: unknown) {
  return JSON.stringify(
    value,
    (_key, candidate) =>
      typeof candidate === "bigint" ? candidate.toString() : candidate,
    2,
  );
}

function printUsage() {
  process.stdout.write(`ReviewRouter review-v2 admin\n\n`);
  process.stdout.write(`  env-preflight\n`);
  process.stdout.write(`  status --repo OWNER/REPO\n`);
  process.stdout.write(`  release register --bundle FILE --confirm release\n`);
  process.stdout.write(
    `  cohort stage --repo OWNER/REPO --confirm OWNER/REPO\n`,
  );
  process.stdout.write(
    `  cohort context-reuse shadow|enable|disable --repo OWNER/REPO --confirm OWNER/REPO\n`,
  );
  process.stdout.write(
    `  mutation initialize-v1 --repo OWNER/REPO --confirm OWNER/REPO\n`,
  );
  process.stdout.write(
    `  mutation begin-drain --repo OWNER/REPO --release RELEASE_ID --confirm OWNER/REPO [--window-ms N]\n`,
  );
  process.stdout.write(
    `  mutation activate|abort-drain|pause|resume --repo OWNER/REPO --confirm OWNER/REPO\n`,
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
