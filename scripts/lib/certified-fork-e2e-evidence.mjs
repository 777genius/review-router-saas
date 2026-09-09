// Offline checkpoint only. References are data, NOT authenticated attestations.
// No production adapter or accepted certified workflow exists in this lane.
const unmetGates = Object.freeze([
  "accepted-certified-workflow-contract",
  "owner-supplied-durable-effect-witnesses",
  "authenticated-live-observation-adapter",
  "external-fork-live-scenarios",
]);

export function certifiedForkPlan() {
  return {
    evidenceVersion: 1,
    scenario: "certified-fork",
    mode: "offline-plan",
    status: "blocked",
    authenticity: "unverified",
    unmetGates: [...unmetGates],
  };
}

// Unknown certified switches must not fall through to the ordinary live runner.
export function certifiedForkRoute(args) {
  if (!args.some((arg) => arg.startsWith("--certified-fork"))) return null;
  const plan = args.length === 1 && args[0] === "--certified-fork-plan";
  return {
    exitCode: plan ? 0 : 1,
    evidence: {
      ...certifiedForkPlan(),
      ...(plan ? {} : { routingError: "unsupported-certified-invocation" }),
    },
  };
}

const sha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
const repository = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u;
const id = /^[1-9][0-9]*$/u;
const ref = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/u;
const integer = (v) => Number.isSafeInteger(v) && v > 0;
const matches = (pattern) => (v) => typeof v === "string" && pattern.test(v);
const oneOf =
  (...values) =>
  (v) =>
    values.includes(v);
const witnessRef = { reference: matches(ref), sha256: matches(digest) };
const tupleShape = {
  baseRepository: matches(repository),
  baseRepositoryId: matches(id),
  sourceRepository: matches(repository),
  sourceRepositoryId: matches(id),
  pullRequestNumber: integer,
  baseSha: matches(sha),
  reviewHeadSha: matches(sha),
  trustDomain: oneOf("fork"),
};
const identityShape = {
  installationId: matches(id),
  providerInstanceId: matches(ref),
  appId: matches(id),
  appSlug: matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
};
const workflowShape = {
  saasCommit: matches(sha),
  actionRepository: matches(repository),
  actionSha: matches(sha),
  runtimeRepository: matches(repository),
  runtimeSha: matches(sha),
  runtimePath: oneOf(".github/workflows/reviewrouter-t0-reusable.yml"),
  workflowPath: oneOf(".github/workflows/reviewrouter-codex.yml"),
  workflowCommit: matches(sha),
  workflowBlob: matches(sha),
  contentSha256: matches(digest),
  semanticSha256: matches(digest),
  // Recognized existing T0 schemas, not accepted certified-fork contracts.
  observedSchema: oneOf(2, 3, 4, 5),
  executionMode: oneOf("client-triggered-t0"),
};
const bindingShape = {
  tuple: tupleShape,
  identity: identityShape,
  workflow: workflowShape,
  runId: matches(id),
  runAttempt: integer,
  contextHash: matches(digest),
  outputHash: matches(digest),
};
const witnessShape = { ...witnessRef, binding: bindingShape };

function check(value, shape, path) {
  if (typeof shape === "function") {
    if (!shape(value)) throw new Error(path);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(path);
  const keys = Object.keys(shape);
  if (Object.keys(value).length !== keys.length) throw new Error(path);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}`);
    check(value[key], shape[key], `${path}.${key}`);
  }
}

// Order-independent equality after exact shape validation. No normalization of
// SHAs, attempts or repository names can hide a mixed observation.
function same(left, right) {
  if (left && typeof left === "object")
    return Object.keys(left).every((key) => same(left[key], right[key]));
  return left === right;
}

/**
 * Validate a candidate evidence document's structure and internal consistency.
 * Even a complete fixture returns blocked/unverified, NEVER live pass. Witness
 * references must later be resolved/authenticated by an owner-supplied adapter.
 * Do not put credentials, OIDC tokens, comment bodies or witness payloads here.
 * @param {unknown} evidence
 */
export function validateCertifiedForkEvidence(evidence) {
  const result = { ...certifiedForkPlan(), mode: "evidence-validation" };
  try {
    check(
      evidence,
      {
        evidenceVersion: oneOf(1),
        scenario: oneOf("certified-fork"),
        binding: bindingShape,
        witnesses: {
          preparation: witnessShape,
          prepublication: witnessShape,
          command: witnessShape,
          receipt: witnessShape,
          effect: witnessShape,
          trustedExecution: witnessShape,
        },
        reconciliation: {
          outcome: oneOf("confirmed", "refused", "reconciliation-required"),
          witness: witnessShape,
        },
        zeroEffects: {
          scope: oneOf("fork-content-execution"),
          observation: witnessShape,
        },
        disposable: {
          baseRepositoryId: matches(id),
          sourceRepositoryId: matches(id),
          provenance: witnessShape,
          cleanup: oneOf("completed", "retained", "pending"),
          cleanupWitness: witnessShape,
        },
        comments: Array.isArray,
      },
      "evidence",
    );
    // check() narrows at runtime; this module deliberately accepts unknown JSON.
    const e = /** @type {any} */ (evidence);
    const { tuple, identity } = e.binding;
    if (identity.appSlug === "github-actions")
      throw new Error("invalid-configured-app");
    if (
      tuple.baseRepositoryId === tuple.sourceRepositoryId ||
      tuple.baseRepository.toLowerCase() ===
        tuple.sourceRepository.toLowerCase()
    )
      throw new Error("external-fork-identity");
    if (
      e.disposable.baseRepositoryId !== tuple.baseRepositoryId ||
      e.disposable.sourceRepositoryId !== tuple.sourceRepositoryId
    )
      throw new Error("disposable-identity");
    const witnesses = [
      ...Object.values(e.witnesses),
      e.reconciliation.witness,
      e.zeroEffects.observation,
      e.disposable.provenance,
      e.disposable.cleanupWitness,
    ];
    const references = new Set();
    for (const witness of witnesses) {
      if (!same(e.binding, witness.binding))
        throw new Error("mixed-witness-binding");
      if (references.has(witness.reference))
        throw new Error("ambiguous-witness-reference");
      references.add(witness.reference);
    }
    const commentIds = new Set();
    for (const comment of e.comments) {
      check(
        comment,
        {
          id: integer,
          surface: oneOf("advisory", "inline"),
          author: oneOf(`${identity.appSlug}[bot]`),
          appId: oneOf(identity.appId),
          reviewedCommit: matches(sha),
          observation: witnessShape,
        },
        "comment",
      );
      if (
        comment.reviewedCommit !== tuple.reviewHeadSha ||
        !same(e.binding, comment.observation.binding)
      )
        throw new Error("mixed-comment-binding");
      const key = `${comment.surface}:${comment.id}`;
      if (commentIds.has(key) || references.has(comment.observation.reference))
        throw new Error("ambiguous-comment");
      commentIds.add(key);
      references.add(comment.observation.reference);
    }
    const outcome = e.reconciliation.outcome;
    if (
      (outcome === "confirmed" && e.comments.length === 0) ||
      (outcome === "refused" && e.comments.length !== 0)
    )
      throw new Error("effect-comment-mismatch");
    return {
      ...result,
      dataStatus: "valid",
      unmetGates: [
        ...unmetGates,
        ...(outcome === "reconciliation-required"
          ? ["effect-reconciliation"]
          : []),
        ...(e.disposable.cleanup === "pending" ? ["disposable-cleanup"] : []),
      ],
    };
  } catch (error) {
    return {
      ...result,
      dataStatus: "invalid",
      errors: [error instanceof Error ? error.message : "invalid-evidence"],
    };
  }
}

/**
 * Project real REST observations without retaining comment bodies. Authorship
 * here checks the observed login only; it cannot authenticate an App or bind a
 * comment to a certified run. Callers must fetch all pages of both surfaces.
 * @param {{advisory: readonly any[], inline: readonly any[], expectedAuthor: string}} input
 */
export function captureReviewRouterComments(input) {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*\[bot\]$/u.test(input.expectedAuthor) ||
    input.expectedAuthor === "github-actions[bot]"
  )
    throw new Error("invalid-configured-app-author");
  const observations = [];
  const seen = new Set();
  for (const [surface, comments, marker] of [
    ["advisory", input.advisory, "<!-- reviewrouter:codex-oauth-rotating"],
    ["inline", input.inline, "<!-- review-router-inline:"],
  ]) {
    if (!Array.isArray(comments)) throw new Error("invalid-comment-list");
    for (const comment of comments) {
      if (typeof comment?.body !== "string")
        throw new Error("invalid-comment-body");
      if (!comment.body.includes(marker)) continue;
      if (!integer(comment.id) || comment.user?.login !== input.expectedAuthor)
        throw new Error(`invalid-${surface}-app-comment`);
      const key = `${surface}:${comment.id}`;
      if (seen.has(key)) throw new Error("duplicate-comment-observation");
      seen.add(key);
      if (surface === "inline" && !matches(sha)(comment.commit_id))
        throw new Error("invalid-inline-reviewed-commit");
      observations.push({
        id: comment.id,
        surface,
        author: comment.user.login,
        reviewedCommit: surface === "inline" ? comment.commit_id : null,
      });
    }
  }
  return observations;
}
