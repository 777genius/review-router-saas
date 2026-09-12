import { createHash } from "node:crypto";
import { readFileSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const recoveryJournalKey = "REVIEW_ROUTER_PG17_RECOVERY_PHASE";
export const recoveryRoles = Object.freeze(["api", "worker", "web"]);
const phases = [
  "validated",
  "frozen",
  "prepared",
  "fleet_verified_closed",
  "complete",
];
const effects = [
  "pending",
  "resume_intent",
  "resumed",
  "deploy_intent",
  "deploy_bound",
  "verified",
];
const fail = (condition, code) => {
  if (!condition) throw new Error(`recovery_${code}`);
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const equal = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sha = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

// Inspect raw JSON before native parsing can erase duplicate object members.
// Each object has its own decoded-key set, including escaped-equivalent keys.
// Bound input, recursion and total values independently of the supplied shape.
export function parseRecoveryJson(raw) {
  return parseBoundedRecoveryJson(raw, 1024 * 1024, 100000);
}

function parseBoundedRecoveryJson(raw, maxBytes, maxValues) {
  fail(
    typeof raw === "string" && Buffer.byteLength(raw, "utf8") <= maxBytes,
    "json_size",
  );
  const parse = (input) => {
    try {
      return JSON.parse(input);
    } catch {
      // Native syntax errors can include response bytes containing credentials.
      throw new Error("recovery_json_syntax");
    }
  };
  let offset = 0;
  let values = 0;
  const whitespace = () => {
    while (" \t\r\n".includes(raw[offset] ?? "\0")) offset++;
  };
  const string = () => {
    const start = offset;
    fail(raw[offset++] === '"', "json_syntax");
    while (offset < raw.length) {
      const char = raw[offset++];
      if (char === '"') return raw.slice(start, offset);
      if (char === "\\") offset++;
    }
    throw new Error("recovery_json_syntax");
  };
  const value = (depth) => {
    fail(depth <= 64 && ++values <= maxValues, "json_complexity");
    whitespace();
    const char = raw[offset];
    if (char === "{" || char === "[") {
      const object = char === "{";
      const end = object ? "}" : "]";
      const keys = new Set();
      offset++;
      whitespace();
      if (raw[offset] === end) {
        offset++;
        return;
      }
      while (offset < raw.length) {
        if (object) {
          whitespace();
          const key = parse(string());
          fail(!keys.has(key), "json_duplicate_member");
          keys.add(key);
          whitespace();
          fail(raw[offset++] === ":", "json_syntax");
        }
        value(depth + 1);
        whitespace();
        if (raw[offset] === end) {
          offset++;
          return;
        }
        fail(raw[offset++] === ",", "json_syntax");
      }
      throw new Error("recovery_json_syntax");
    }
    if (char === '"') {
      string();
      return;
    }
    const start = offset;
    while (offset < raw.length && !" \t\r\n,]}".includes(raw[offset])) offset++;
    fail(offset > start, "json_syntax");
  };
  value(0);
  whitespace();
  fail(offset === raw.length, "json_syntax");
  // Native parsing validates string escapes, literals and number grammar.
  return parse(raw);
}

// Replicas repeat the same bounded journal three times. The transport envelope
// has its own bound; it never enlarges the authority accepted for one journal.
export function parseRecoveryReplicaResponse(raw) {
  const replicas = parseBoundedRecoveryJson(raw, 3 * 1024 * 1024 + 64, 300004);
  fail(Array.isArray(replicas) && replicas.length === 3, "replica_count");
  return replicas.map((value) => parseRecoveryJson(JSON.stringify(value)));
}

// Read one bounded response from stdin before parsing. No response is placed in
// argv/environment, and temporary byte buffers are cleared even on rejection.
export function readRecoveryJsonInput() {
  const bytes = Buffer.alloc(1024 * 1024 + 1);
  let used = 0;
  try {
    while (used < bytes.length) {
      const count = readSync(0, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    fail(used <= 1024 * 1024, "json_size");
    const raw = new globalThis.TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, used),
    );
    parseRecoveryJson(raw);
    return raw;
  } finally {
    bytes.fill(0);
  }
}

// Only bounded journal reference metadata is excluded. Every runtime key, including
// credentials, participates; the returned digest never contains its values.
export function recoveryConfigFingerprint(environment) {
  const entries = recoveryEnvironmentEntries(environment);
  return sha(
    entries
      .filter((entry) => entry.key !== recoveryJournalKey)
      .map(({ key, value }) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
}

export function recoveryEnvironmentEntries(environment) {
  if (typeof environment === "string")
    environment = parseRecoveryJson(environment);
  fail(Array.isArray(environment), "environment_shape");
  const entries = environment.map((entry) => {
    fail(
      entry && typeof entry === "object" && !Array.isArray(entry),
      "environment_entry",
    );
    const wrapped = Object.hasOwn(entry, "envVar");
    fail(
      Object.keys(entry).every((key) =>
        (wrapped ? ["envVar", "cursor"] : ["key", "value"]).includes(key),
      ),
      "environment_entry",
    );
    fail(
      !wrapped ||
        !Object.hasOwn(entry, "cursor") ||
        typeof entry.cursor === "string",
      "environment_entry",
    );
    const value = wrapped ? entry.envVar : entry;
    fail(
      value && typeof value === "object" && !Array.isArray(value),
      "environment_entry",
    );
    fail(
      Object.keys(value).length === 2 &&
        Object.keys(value).every((key) => ["key", "value"].includes(key)),
      "environment_entry",
    );
    fail(
      typeof value.key === "string" &&
        value.key.length > 0 &&
        typeof value.value === "string",
      "environment_entry",
    );
    fail(
      !wrapped ||
        (!Object.hasOwn(entry, "key") && !Object.hasOwn(entry, "value")),
      "environment_entry",
    );
    return value;
  });
  fail(
    new Set(entries.map((entry) => entry.key)).size === entries.length,
    "environment_duplicate",
  );
  return entries;
}

// Runtime environments retain bounded history references. The complete history
// stays at the provider/evidence boundary and is reread after runner loss. Its
// immutable identities (including order and count) must match before use; status
// changes never supply new identity authority. The original live head is kept
// for the predecessor-overlap check.
const historyIdentity = (inventory) =>
  inventory.map(
    ({
      serviceId,
      deployId,
      createdAt,
      deploymentIdentityKind,
      observedCommitSha,
      observedImageDigest,
    }) => ({
      serviceId,
      deployId,
      createdAt,
      deploymentIdentityKind,
      observedCommitSha,
      observedImageDigest,
    }),
  );

export function compactRecoveryJournal(journal) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  const histories = {};
  for (const role of recoveryRoles) {
    histories[role] = {};
    for (const key of ["beforeInventory", "deployBeforeInventory"]) {
      const inventory = state.services[role][key];
      if (!inventory) continue;
      fail(
        inventory.slice(1).every((item) => item.statusClass === "terminal"),
        "history_competing_predecessor",
      );
      histories[role][key] = {
        count: inventory.length,
        sha256: sha(historyIdentity(inventory)),
      };
      state.services[role][key] = [inventory[0]];
    }
  }
  const reference = { schemaVersion: 3, journal: state, histories };
  validateRecoveryJournalReference(reference);
  return reference;
}

function validateRecoveryJournalReference(reference) {
  fail(
    reference?.schemaVersion === 3 &&
      equal(Object.keys(reference).sort(), [
        "histories",
        "journal",
        "schemaVersion",
      ]) &&
      Buffer.byteLength(JSON.stringify(reference)) <= 16384,
    "journal_reference",
  );
  const state = loadRecoveryJournal(
    reference.journal,
    reference.journal?.tuple,
  );
  fail(
    equal(
      Object.keys(reference.histories ?? {}).sort(),
      [...recoveryRoles].sort(),
    ),
    "history_roles",
  );
  for (const role of recoveryRoles) {
    const keys = ["beforeInventory", "deployBeforeInventory"].filter(
      (key) => state.services[role][key],
    );
    fail(
      equal(Object.keys(reference.histories[role]).sort(), [...keys].sort()),
      "history_keys",
    );
    for (const key of keys) {
      const history = reference.histories[role][key];
      fail(
        state.services[role][key].length === 1 &&
          equal(Object.keys(history).sort(), ["count", "sha256"]) &&
          Number.isSafeInteger(history.count) &&
          history.count > 0 &&
          history.count <= 1000 &&
          /^[a-f0-9]{64}$/.test(history.sha256),
        "history_reference",
      );
    }
  }
  return reference;
}

export function expandRecoveryJournal(reference, inventories) {
  validateRecoveryJournalReference(reference);
  const state = globalThis.structuredClone(reference.journal);
  for (const role of recoveryRoles) {
    const inventory = inventories[role];
    validateInventory(inventory, state.tuple.services[role].id);
    for (const [key, history] of Object.entries(reference.histories[role])) {
      const head = state.services[role][key][0];
      const index = inventory.findIndex(
        (item) => item.deployId === head.deployId,
      );
      fail(index >= 0, "history_head_missing");
      const retained = inventory.slice(index);
      fail(
        retained.length === history.count &&
          sha(historyIdentity(retained)) === history.sha256,
        "history_digest_mismatch",
      );
      state.services[role][key] = [head, ...retained.slice(1)];
    }
  }
  return loadRecoveryJournal(state, state.tuple);
}

export function readRecoveryPhaseResponse(response, referenceOnly = false) {
  // Authority readers require raw bytes; accepting pre-parsed responses would
  // make duplicate-member rejection dependent on every caller's discipline.
  const entries = recoveryEnvironmentEntries(parseRecoveryJson(response));
  const entry = entries.find((value) => value.key === recoveryJournalKey);
  if (!entry) return null;
  const journal = parseRecoveryJson(entry.value);
  fail(
    journal && typeof journal === "object" && !Array.isArray(journal),
    "journal_value_shape",
  );
  if (journal.schemaVersion !== 3)
    return loadRecoveryJournal(journal, journal.tuple);
  validateRecoveryJournalReference(journal);
  if (referenceOnly) return journal;
  // A one-record history is fully retained in its head; no provider read is
  // needed to resolve it. Longer histories always require digest-checked reads.
  if (
    recoveryRoles.every((role) =>
      Object.values(journal.histories[role]).every(
        (history) => history.count === 1,
      ),
    )
  )
    return expandRecoveryJournal(
      journal,
      Object.fromEntries(
        recoveryRoles.map((role) => [
          role,
          journal.journal.services[role].beforeInventory,
        ]),
      ),
    );
  return journal;
}

export function validateRecoveryTuple(tuple) {
  fail(tuple && typeof tuple === "object", "tuple_missing");
  for (const key of ["operationId", "targetDbId", "ownerId", "environmentId"])
    fail(
      typeof tuple[key] === "string" && tuple[key].length > 0,
      `tuple_${key}`,
    );
  fail(/^[a-f0-9]{40}$/.test(tuple.releaseCommitSha), "tuple_release");
  fail(
    equal(Object.keys(tuple.services ?? {}).sort(), [...recoveryRoles].sort()),
    "tuple_roles",
  );
  const ids = [];
  for (const role of recoveryRoles) {
    const service = tuple.services[role];
    fail(
      service.name === `reviewrouter-${role}` &&
        service.type ===
          (role === "worker" ? "background_worker" : "web_service"),
      "tuple_role_binding",
    );
    fail(/^srv-[a-z0-9-]+$/.test(service.id), "tuple_service_id");
    fail(
      service.repo === "https://github.com/777genius/review-router-saas" &&
        service.branch === "main" &&
        service.autoDeploy === "no",
      "tuple_git_source",
    );
    fail(
      service.ownerId === tuple.ownerId &&
        service.environmentId === tuple.environmentId,
      "tuple_scope",
    );
    fail(/^[a-f0-9]{64}$/.test(service.configFingerprint), "tuple_config");
    ids.push(service.id);
  }
  fail(new Set(ids).size === 3, "tuple_duplicate_service");
  return globalThis.structuredClone(tuple);
}

// Render timestamps are UTC RFC3339, with optional subsecond precision. Date.parse
// alone normalizes impossible dates; require a calendar round trip as well.
function recoveryTimestamp(value) {
  fail(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value),
    "deployment_created_at",
  );
  const seconds = value.replace(/\.\d+Z$/, "Z");
  const epoch = Date.parse(seconds);
  fail(
    Number.isFinite(epoch) &&
      new Date(epoch).toISOString().replace(".000Z", "Z") === seconds,
    "deployment_created_at",
  );
  return Date.parse(value) / 1000;
}

function recoveryTimestampInWindow(value, start, end) {
  recoveryTimestamp(value);
  const whole = Date.parse(value.replace(/\.\d+Z$/, "Z")) / 1000;
  // Compare fractional boundary values without Date.parse millisecond truncation
  // or floating-point rounding accepting a timestamp just after the deadline.
  return (
    whole >= start &&
    (whole < end || (whole === end && !/\.\d*[1-9]\d*Z$/.test(value)))
  );
}

function validateInventory(inventory, serviceId) {
  fail(Array.isArray(inventory) && inventory.length > 0, "inventory_missing");
  fail(
    inventory.every(
      (item) =>
        item.serviceId === serviceId &&
        /^dep-[a-z0-9-]+$/.test(item.deployId) &&
        ["active", "terminal"].includes(item.statusClass) &&
        ((item.deploymentIdentityKind === "git" &&
          /^[a-f0-9]{40}$/.test(item.observedCommitSha) &&
          item.observedImageDigest === null) ||
          (item.deploymentIdentityKind === "image" &&
            /^sha256:[a-f0-9]{64}$/.test(item.observedImageDigest) &&
            item.observedCommitSha === null)),
    ),
    "inventory_identity",
  );
  for (const item of inventory) recoveryTimestamp(item.createdAt);
  fail(
    new Set(inventory.map((item) => item.deployId)).size === inventory.length,
    "inventory_duplicate",
  );
}

// Registration uses the same replicated journal and ordered intent/effect
// transitions. Its immutable binding distinguishes it from database recovery;
// neither operation may reinterpret the other's retained authority.
export function validateRegistrationBinding(binding) {
  const keys = [
    "actionCommitSha",
    "operatorRepository",
    "operatorWorkspaceId",
    "investigationRolloutProfile",
    "investigationRepositoryConnectionId",
    "investigationProducerReleaseId",
  ];
  fail(
    binding &&
      equal(Object.keys(binding).sort(), keys.sort()) &&
      keys.every((key) => typeof binding[key] === "string"),
    "registration_binding",
  );
  fail(
    /^[a-f0-9]{40}$/.test(binding.actionCommitSha) &&
      ["preserve", "shadow", "production"].includes(
        binding.investigationRolloutProfile,
      ),
    "registration_binding",
  );
  return globalThis.structuredClone(binding);
}

export function createRegistrationJournal(tuple, inventories, binding) {
  let state = createRecoveryJournal(tuple, inventories);
  state.registration = validateRegistrationBinding(binding);
  for (const role of recoveryRoles)
    assertRecoveryPreEffectInventory(state, role, inventories[role]);
  state = advanceRecoveryPhase(state, "frozen");
  return advanceRecoveryPhase(state, "prepared");
}

export function loadRegistrationReplicas(replicas, expectedTuple, binding) {
  const state = loadRecoveryReplicas(replicas, expectedTuple);
  fail(
    equal(state.registration, validateRegistrationBinding(binding)),
    "registration_binding_mismatch",
  );
  fail(state.phase === "prepared", "registration_phase");
  return state;
}

export function retainRegistrationConfiguration(journal, fingerprints, result) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  validateRegistrationBinding(state.registration);
  validateRuntimeFingerprints(state, fingerprints);
  if (state.runtimeConfigFingerprints !== undefined) {
    fail(
      equal(state.runtimeConfigFingerprints, fingerprints),
      "registration_configuration_drift",
    );
    return state;
  }
  fail(
    recoveryRoles.every((role) => state.services[role].phase === "pending"),
    "registration_configuration_missing",
  );
  validateRegistrationResult(state, result);
  state.runtimeConfigFingerprints = globalThis.structuredClone(fingerprints);
  state.registrationResult = globalThis.structuredClone(result);
  state.revision += 1;
  return loadRecoveryJournal(state, state.tuple);
}

function validateRegistrationResult(state, result) {
  fail(
    result?.actionCommitSha === state.registration.actionCommitSha &&
      ["created", "restored"].includes(result.releaseStatus) &&
      typeof result.producerReleaseId === "string" &&
      result.producerReleaseId.length > 0,
    "registration_result",
  );
}

function validateRuntimeFingerprints(state, fingerprints) {
  fail(
    fingerprints &&
      equal(Object.keys(fingerprints).sort(), [...recoveryRoles].sort()),
    "preparation_roles",
  );
  for (const role of recoveryRoles)
    fail(
      fingerprints[role].serviceId === state.tuple.services[role].id &&
        /^[a-f0-9]{64}$/.test(fingerprints[role].fingerprint),
      "preparation_configuration",
    );
}

export function createRecoveryJournal(tuple, inventories) {
  validateRecoveryTuple(tuple);
  const services = {};
  for (const role of recoveryRoles) {
    validateInventory(inventories[role], tuple.services[role].id);
    services[role] = {
      phase: "pending",
      beforeInventory: globalThis.structuredClone(inventories[role]),
    };
  }
  return {
    schemaVersion: 2,
    revision: 0,
    tuple: globalThis.structuredClone(tuple),
    phase: "validated",
    services,
  };
}

// Loading is deliberately separate from creation: an absent, legacy or damaged
// retained journal is never interpreted as permission for fresh effects.
export function loadRecoveryJournal(value, expectedTuple) {
  validateRecoveryTuple(expectedTuple);
  const state =
    typeof value === "string"
      ? parseRecoveryJson(value)
      : globalThis.structuredClone(value);
  fail(
    state?.schemaVersion === 2 &&
      Number.isSafeInteger(state.revision) &&
      state.revision >= 0,
    "journal_version",
  );
  fail(equal(state.tuple, expectedTuple), "journal_tuple_mismatch");
  fail(phases.includes(state.phase), "journal_phase");
  fail(
    equal(Object.keys(state.services ?? {}).sort(), [...recoveryRoles].sort()),
    "journal_services",
  );
  for (const role of recoveryRoles) {
    const service = state.services[role];
    fail(effects.includes(service.phase), "journal_effect_phase");
    validateInventory(service.beforeInventory, state.tuple.services[role].id);
    if (effects.indexOf(service.phase) >= effects.indexOf("deploy_intent")) {
      fail(
        Number.isSafeInteger(service.intentEpoch) && service.intentEpoch > 0,
        "journal_intent_time",
      );
      fail(
        Number.isSafeInteger(service.intentDeadlineEpoch) &&
          service.intentDeadlineEpoch === service.intentEpoch + 120,
        "journal_intent_deadline",
      );
      validateInventory(
        service.deployBeforeInventory,
        state.tuple.services[role].id,
      );
    }
    if (["deploy_bound", "verified"].includes(service.phase))
      fail(
        /^dep-[a-z0-9-]+$/.test(service.deployId) &&
          !service.deployBeforeInventory.some(
            (item) => item.deployId === service.deployId,
          ),
        "journal_deploy_id",
      );
  }
  const indexes = recoveryRoles.map((role) =>
    effects.indexOf(state.services[role].phase),
  );
  fail(
    indexes.every(
      (index, position) =>
        position === 0 ||
        index === 0 ||
        indexes[position - 1] === effects.length - 1,
    ),
    "journal_service_order",
  );
  if (phases.indexOf(state.phase) < phases.indexOf("prepared"))
    fail(
      indexes.every((index) => index === 0),
      "journal_premature_effect",
    );
  if (["fleet_verified_closed", "complete"].includes(state.phase))
    fail(
      indexes.every((index) => index === effects.length - 1),
      "journal_incomplete_fleet",
    );
  if (state.registration !== undefined) {
    validateRegistrationBinding(state.registration);
    fail(
      state.workerFence === undefined &&
        state.bootstrapCompensationFence === undefined &&
        state.bootstrapPhase === undefined,
      "registration_recovery_evidence",
    );
    if (state.runtimeConfigFingerprints !== undefined) {
      validateRuntimeFingerprints(state, state.runtimeConfigFingerprints);
      validateRegistrationResult(state, state.registrationResult);
    }
    if (indexes.some((index) => index > 0))
      fail(
        state.runtimeConfigFingerprints !== undefined,
        "registration_configuration_missing",
      );
  }
  if (state.bootstrapCompensationFence !== undefined) {
    fail(
      equal(
        planWorkerEffectFence(state.bootstrapCompensationFence.before),
        state.bootstrapCompensationFence,
      ),
      "bootstrap_compensation_evidence",
    );
    if (state.workerFence !== undefined)
      fail(
        equal(state.workerFence, state.bootstrapCompensationFence),
        "bootstrap_compensation_changed",
      );
  }
  return state;
}

// This is the original ACL observation, retained before compensation removes
// UPDATE. An already-fenced snapshot alone never authorizes a future GRANT.
export function retainBootstrapCompensationFence(journal, observed) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  fail(
    recoveryContinuationMode(state) === "bootstrap",
    "bootstrap_compensation_phase",
  );
  if (state.bootstrapCompensationFence !== undefined) {
    reconcileBootstrapCompensationFence(state, observed);
    return state;
  }
  state.bootstrapCompensationFence = planWorkerEffectFence(observed);
  state.revision += 1;
  return loadRecoveryJournal(state, state.tuple);
}

export function reconcileBootstrapCompensationFence(journal, observed) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  const fence = state.bootstrapCompensationFence;
  fail(
    fence !== undefined &&
      (equal(observed, fence.before) || equal(observed, fence.fenced)),
    "bootstrap_compensation_snapshot",
  );
  return globalThis.structuredClone(fence);
}

export function advanceRecoveryPhase(journal, nextPhase) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  fail(
    phases.indexOf(nextPhase) === phases.indexOf(state.phase) + 1,
    "phase_transition",
  );
  state.phase = nextPhase;
  state.revision += 1;
  return loadRecoveryJournal(state, journal.tuple);
}

// The caller persists and reads back the returned state BEFORE executing any
// resume/deploy request. Retained deploy intent grants observation only; a
// suspended service may be resumed idempotently after re-proving its fences.
export function advanceRecoveryService(
  journal,
  role,
  nextPhase,
  evidence = {},
) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  fail(
    state.phase === "prepared" && recoveryRoles.includes(role),
    "service_transition_scope",
  );
  const service = state.services[role];
  fail(
    effects.indexOf(nextPhase) === effects.indexOf(service.phase) + 1,
    "service_transition",
  );
  const index = recoveryRoles.indexOf(role);
  fail(
    index === 0 ||
      state.services[recoveryRoles[index - 1]].phase === "verified",
    "service_transition_order",
  );
  if (nextPhase === "deploy_intent") {
    assertRecoveryPreEffectInventory(state, role, evidence.inventory);
    fail(
      Number.isSafeInteger(evidence.intentEpoch) && evidence.intentEpoch > 0,
      "intent_time",
    );
    service.deployBeforeInventory = globalThis.structuredClone(
      evidence.inventory,
    );
    service.intentEpoch = evidence.intentEpoch;
    service.intentDeadlineEpoch = evidence.intentEpoch + 120;
  }
  if (nextPhase === "deploy_bound") service.deployId = evidence.deployId;
  if (nextPhase === "verified")
    assertRecoveryDeploymentInventory(state, role, evidence.inventory);
  service.phase = nextPhase;
  state.revision += 1;
  return loadRecoveryJournal(state, journal.tuple);
}

export function recoveryRestartAction(journal, role) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  fail(recoveryRoles.includes(role), "restart_role");
  if (["fleet_verified_closed", "complete"].includes(state.phase))
    return "already_complete";
  const service = state.services[role];
  return {
    pending: "prepare_resume_intent",
    resume_intent: "observe_resume",
    resumed: "prepare_deploy_intent",
    deploy_intent: "reconcile_deploy",
    deploy_bound: "observe_exact_deploy",
    verified: "verify_exact_deploy",
  }[service.phase];
}

export function reconcileRecoveryDeploy(
  journal,
  role,
  inventory,
  observationEpoch,
) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  fail(recoveryRoles.includes(role), "reconciliation_role");
  const service = state.services[role];
  fail(service.phase === "deploy_intent", "reconciliation_phase");
  fail(
    Number.isSafeInteger(observationEpoch) &&
      observationEpoch >= service.intentEpoch,
    "reconciliation_time",
  );
  validateInventory(inventory, state.tuple.services[role].id);
  const beforeIds = service.deployBeforeInventory.map((item) => item.deployId);
  fail(
    beforeIds.every((id) => inventory.some((item) => item.deployId === id)),
    "reconciliation_missing_history",
  );
  const additions = inventory.filter(
    (item) => !beforeIds.includes(item.deployId),
  );
  // A zero-candidate result stays unknown, even after an observation deadline.
  fail(
    additions.length === 1,
    additions.length ? "reconciliation_ambiguous" : "reconciliation_unknown",
  );
  const candidate = additions[0];
  fail(
    candidate.deploymentIdentityKind === "git" &&
      candidate.observedCommitSha === state.tuple.releaseCommitSha &&
      candidate.observedImageDigest === null &&
      recoveryTimestampInWindow(
        candidate.createdAt,
        service.intentEpoch,
        Math.min(observationEpoch, service.intentDeadlineEpoch),
      ),
    "reconciliation_candidate",
  );
  return advanceRecoveryService(state, role, "deploy_bound", {
    deployId: candidate.deployId,
  });
}

// During replacement only a retained live predecessor may overlap. Final
// verification requires the exact retained target to be the sole active ID.
export function assertRecoveryDeploymentInventory(
  journal,
  role,
  inventory,
  allowPredecessor = false,
) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  fail(recoveryRoles.includes(role), "deployment_role");
  const service = state.services[role];
  fail(
    ["deploy_bound", "verified"].includes(service.phase),
    "deployment_unbound",
  );
  validateInventory(inventory, state.tuple.services[role].id);
  const before = service.deployBeforeInventory;
  const identity = ({
    serviceId,
    deployId,
    createdAt,
    deploymentIdentityKind,
    observedCommitSha,
    observedImageDigest,
  }) => ({
    serviceId,
    deployId,
    createdAt,
    deploymentIdentityKind,
    observedCommitSha,
    observedImageDigest,
  });
  fail(
    before.every((item) =>
      inventory.some((observed) => equal(identity(item), identity(observed))),
    ),
    "deployment_missing_or_changed_history",
  );
  fail(
    inventory
      .filter(
        (item) =>
          !before.some((previous) => previous.deployId === item.deployId),
      )
      .every((item) => item.deployId === service.deployId),
    "deployment_unrelated_history",
  );
  const target = inventory.find((item) => item.deployId === service.deployId);
  fail(
    target &&
      target.deploymentIdentityKind === "git" &&
      target.observedCommitSha === state.tuple.releaseCommitSha &&
      target.observedImageDigest === null,
    "deployment_identity",
  );
  fail(
    recoveryTimestampInWindow(
      target.createdAt,
      service.intentEpoch,
      service.intentDeadlineEpoch,
    ),
    "deployment_intent_window",
  );
  const predecessors = service.deployBeforeInventory
    .filter((item) => item.observedStatus === "live")
    .map((item) => item.deployId);
  fail(
    inventory
      .filter((item) => item.statusClass === "active")
      .every(
        (item) =>
          item.deployId === service.deployId ||
          (allowPredecessor &&
            predecessors.includes(item.deployId) &&
            item.observedStatus === "live"),
      ),
    "deployment_competitor",
  );
  fail(inventory[0].deployId === service.deployId, "deployment_replaced");
  if (!allowPredecessor)
    fail(
      target.observedStatus === "live" && target.statusClass === "active",
      "deployment_not_live",
    );
  else fail(target.statusClass === "active", "deployment_failed");
  return globalThis.structuredClone(target);
}

// Conservative topology: membership (including SET ROLE), ownership, grant
// options, PUBLIC and column UPDATE paths require operator repair, never a
// broader privilege revocation. Evidence contains generation and ACL metadata.
export const workerFenceSnapshotSql = `SELECT jsonb_build_object(
  'database', (SELECT jsonb_build_object(
    'name', current_database(), 'oid', d.oid::text,
    'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
    'boundSystemIdentifier', (shobj_description(d.oid, 'pg_database')::jsonb)->>'systemIdentifier',
    'recoveryWitnessSha256', (shobj_description(d.oid, 'pg_database')::jsonb)->>'recoveryWitnessSha256'
  ) FROM pg_database d WHERE d.datname = current_database()),
  'owner', pg_get_userbyid(c.relowner),
  'role', (SELECT jsonb_build_object('name', rolname, 'superuser', rolsuper,
    'createRole', rolcreaterole, 'bypassRls', rolbypassrls) FROM pg_roles
    WHERE rolname = 'reviewrouter_worker'),
  'memberships', (SELECT coalesce(jsonb_agg(r.rolname ORDER BY r.rolname), '[]'::jsonb)
    FROM pg_roles r WHERE r.rolname <> 'reviewrouter_worker'
    AND pg_has_role('reviewrouter_worker', r.oid, 'MEMBER')),
  'tableAcl', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
    'grantor', pg_get_userbyid(a.grantor), 'privilege', a.privilege_type,
    'grantable', a.is_grantable) ORDER BY a.grantee, a.grantor, a.privilege_type), '[]'::jsonb)
    FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a),
  'columnAcl', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'column', x.attname, 'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
    'grantor', pg_get_userbyid(a.grantor), 'privilege', a.privilege_type,
    'grantable', a.is_grantable) ORDER BY x.attnum, a.grantee, a.grantor, a.privilege_type), '[]'::jsonb)
    FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a
    WHERE x.attrelid = c.oid AND x.attnum > 0 AND NOT x.attisdropped),
  'effectiveUpdate', has_table_privilege('reviewrouter_worker', c.oid, 'UPDATE'),
  'effectiveColumnUpdate', has_any_column_privilege('reviewrouter_worker', c.oid, 'UPDATE')
) FROM pg_class c WHERE c.oid = 'public."OutboxEvent"'::regclass`;

export function planWorkerEffectFence(before) {
  fail(
    typeof before?.database?.name === "string" &&
      before.database.name.length > 0 &&
      /^[1-9][0-9]*$/.test(before.database.oid) &&
      /^[1-9][0-9]*$/.test(before.database.systemIdentifier) &&
      before.database.boundSystemIdentifier ===
        before.database.systemIdentifier &&
      /^[a-f0-9]{64}$/.test(before.database.recoveryWitnessSha256),
    "worker_database_generation",
  );
  fail(before?.role?.name === "reviewrouter_worker", "worker_identity");
  fail(
    before.role.superuser === false &&
      before.role.createRole === false &&
      before.role.bypassRls === false &&
      before.owner !== "reviewrouter_worker",
    "worker_authority",
  );
  fail(
    Array.isArray(before.memberships) && before.memberships.length === 0,
    "worker_inherited_update",
  );
  fail(
    Array.isArray(before.tableAcl) && Array.isArray(before.columnAcl),
    "worker_acl_shape",
  );
  const update = before.tableAcl.filter(
    (a) => a.privilege === "UPDATE" && a.grantee === "reviewrouter_worker",
  );
  fail(
    update.length === 1 &&
      update[0].grantor === before.owner &&
      update[0].grantable === false,
    "worker_direct_update",
  );
  fail(
    !before.tableAcl.some(
      (a) => a.grantee === "PUBLIC" && a.privilege === "UPDATE",
    ),
    "worker_public_update",
  );
  fail(
    !before.columnAcl.some(
      (a) =>
        ["PUBLIC", "reviewrouter_worker"].includes(a.grantee) &&
        a.privilege === "UPDATE",
    ),
    "worker_column_update",
  );
  fail(
    before.effectiveUpdate === true && before.effectiveColumnUpdate === true,
    "worker_effective_update",
  );
  const fenced = globalThis.structuredClone(before);
  fenced.tableAcl = fenced.tableAcl.filter(
    (a) => !(a.privilege === "UPDATE" && a.grantee === "reviewrouter_worker"),
  );
  fenced.effectiveUpdate = false;
  fenced.effectiveColumnUpdate = false;
  return { before: globalThis.structuredClone(before), fenced };
}

export function workerEffectFenceSql(evidence, restore = false) {
  const plan = planWorkerEffectFence(evidence.before);
  fail(equal(plan, evidence), "worker_evidence_mismatch");
  const quote = (value) =>
    `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const expected = restore ? plan.fenced : plan.before;
  const result = restore ? plan.before : plan.fenced;
  const owner = `"${plan.before.owner.replaceAll('"', '""')}"`;
  return `BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public."OutboxEvent" IN ACCESS EXCLUSIVE MODE;
DO $fence$ DECLARE observed jsonb; BEGIN
  ${workerFenceSnapshotSql} INTO observed;
  IF observed IS DISTINCT FROM ${quote(expected)} AND observed IS DISTINCT FROM ${quote(result)} THEN RAISE EXCEPTION 'worker fence before-state mismatch'; END IF;
END $fence$;
SET LOCAL ROLE ${owner};
${restore ? 'GRANT UPDATE ON public."OutboxEvent" TO reviewrouter_worker' : 'REVOKE UPDATE ON public."OutboxEvent" FROM reviewrouter_worker'};
RESET ROLE;
DO $fence$ DECLARE observed jsonb; BEGIN
  ${workerFenceSnapshotSql} INTO observed;
  IF observed IS DISTINCT FROM ${quote(result)} THEN RAISE EXCEPTION 'worker fence after-state mismatch'; END IF;
END $fence$;
COMMIT;`;
}

// Replicas are an admission boundary, not a quorum. A torn write can conceal
// whether an effect happened; never select the largest revision and proceed.
export function loadRecoveryReplicas(replicas, expectedTuple) {
  fail(Array.isArray(replicas) && replicas.length === 3, "replica_count");
  const journals = replicas.map((value) =>
    loadRecoveryJournal(value, expectedTuple),
  );
  fail(
    journals.every((value) => equal(value, journals[0])),
    "replica_disagreement",
  );
  return journals[0];
}

export function attachRecoveryPreparation(journal, fingerprints, workerFence) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  fail(state.phase === "frozen", "preparation_phase");
  validateRuntimeFingerprints(state, fingerprints);
  fail(
    equal(planWorkerEffectFence(workerFence.before), workerFence),
    "preparation_worker_evidence",
  );
  state.runtimeConfigFingerprints = globalThis.structuredClone(fingerprints);
  state.workerFence = globalThis.structuredClone(workerFence);
  return advanceRecoveryPhase(state, "prepared");
}

export function validateRecoveryPreparation(journal) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  fail(
    ["prepared", "fleet_verified_closed", "complete"].includes(state.phase),
    "preparation_missing",
  );
  const frozen = {
    ...state,
    phase: "frozen",
    services: Object.fromEntries(
      recoveryRoles.map((role) => [
        role,
        {
          phase: "pending",
          beforeInventory: state.services[role].beforeInventory,
        },
      ]),
    ),
  };
  attachRecoveryPreparation(
    frozen,
    state.runtimeConfigFingerprints,
    state.workerFence,
  );
  return state;
}

export function recoveryContinuationMode(journal) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  fail(state.registration === undefined, "registration_not_recovery");
  fail(
    !["fleet_verified_closed", "complete"].includes(state.phase),
    "already_complete",
  );
  if (
    state.phase === "validated" ||
    (state.phase === "frozen" && state.bootstrapPhase === "services_suspended")
  ) {
    fail(
      state.workerFence === undefined &&
        state.runtimeConfigFingerprints === undefined,
      "bootstrap_retained_effects",
    );
    if (state.phase === "validated")
      fail(
        state.revision ===
          (state.bootstrapCompensationFence === undefined ? 0 : 1) &&
          state.bootstrapPhase === undefined,
        "bootstrap_validated_history",
      );
    return "bootstrap";
  }
  // Credential values are deliberately absent from journal metadata. After
  // rotation intent, an incomplete bootstrap cannot mint replacements on replay.
  validateRecoveryPreparation(state);
  return "fleet";
}

// A torn phase write never grants activation authority. Its unchanged, fully
// validated ACL evidence can still authorize the exact compensating REVOKE.
// This returns no phase, deploy ID, credentials or permission to restore UPDATE.
export function recoveryCompensationFence(replicas, expectedTuple) {
  fail(Array.isArray(replicas) && replicas.length === 3, "replica_count");
  fail(
    replicas.every((value) => value !== null),
    "compensation_restoration_evidence_missing",
  );
  const journals = replicas.map((value) =>
    loadRecoveryJournal(value, expectedTuple),
  );
  const fences = journals.map(
    (state) => state.workerFence ?? state.bootstrapCompensationFence ?? null,
  );
  if (fences.every((value) => value === null)) return null;
  fail(
    fences.every((value) => value !== null && equal(value, fences[0])),
    "compensation_evidence_disagreement",
  );
  const evidence = fences[0];
  fail(
    equal(planWorkerEffectFence(evidence.before), evidence),
    "compensation_evidence_invalid",
  );
  return globalThis.structuredClone(evidence);
}

export function assertRecoveryPreEffectInventory(journal, role, inventory) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  fail(recoveryRoles.includes(role), "preintent_role");
  validateInventory(inventory, state.tuple.services[role].id);
  const identity = (items) =>
    items.map((item) => ({
      deployId: item.deployId,
      createdAt: item.createdAt,
      kind: item.deploymentIdentityKind,
      sha: item.observedCommitSha,
      image: item.observedImageDigest,
    }));
  fail(
    equal(identity(inventory), identity(state.services[role].beforeInventory)),
    "unexpected_preintent_history",
  );
  fail(
    state.registration !== undefined
      ? inventory[0].observedCommitSha === state.tuple.releaseCommitSha &&
          inventory[0].deploymentIdentityKind === "git"
      : !inventory.some(
          (item) => item.observedCommitSha === state.tuple.releaseCommitSha,
        ),
    "observed_preintent_effect",
  );
  fail(
    inventory[0].observedStatus === "live" &&
      inventory[0].statusClass === "active" &&
      inventory.filter((item) => item.statusClass === "active").length === 1,
    "preintent_not_quiescent",
  );
}

// Admission at every retained checkpoint precedes resuming any predecessor.
// A retained POST intent permits observation only, including zero candidates;
// changed history, competing jobs, and effects outside its window reject.
export function assertRecoveryRetainedInventory(journal, role, inventory) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  fail(recoveryRoles.includes(role), "retained_role");
  const service = state.services[role];
  if (["pending", "resume_intent", "resumed"].includes(service.phase))
    return assertRecoveryPreEffectInventory(state, role, inventory);
  if (["deploy_bound", "verified"].includes(service.phase))
    return assertRecoveryDeploymentInventory(
      state,
      role,
      inventory,
      service.phase !== "verified",
    );
  validateInventory(inventory, state.tuple.services[role].id);
  const beforeIds = new Set(
    service.deployBeforeInventory.map((item) => item.deployId),
  );
  const additions = inventory.filter((item) => !beforeIds.has(item.deployId));
  if (additions.length === 0) {
    return assertRecoveryPreEffectInventory(
      {
        ...state,
        services: {
          ...state.services,
          [role]: {
            ...service,
            beforeInventory: service.deployBeforeInventory,
          },
        },
      },
      role,
      inventory,
    );
  }
  const bound = reconcileRecoveryDeploy(
    state,
    role,
    inventory,
    service.intentDeadlineEpoch,
  );
  return assertRecoveryDeploymentInventory(bound, role, inventory, true);
}

// Render's saved environment is replacement configuration, not the suspended
// deployment's effective configuration. Read its existing durable runtime
// canary instead: the SECURITY DEFINER responder authenticates session_user,
// local service/release/provenance and the physical database recovery witness.
// Never manufacture a challenge or a principal proof in the recovery runner.
export function workerRuntimeObservationSql(journal, inventory) {
  const state = loadRecoveryJournal(journal, journal.tuple);
  assertRecoveryRetainedInventory(state, "worker", inventory);
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  return `SELECT jsonb_build_object(
    'fence', (${workerFenceSnapshotSql}),
    'proofProtected', (SELECT count(*) = 2 AND bool_and(
      pg_get_userbyid(c.relowner) <> 'reviewrouter_worker'
      AND NOT has_table_privilege('reviewrouter_worker', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_any_column_privilege('reviewrouter_worker', c.oid, 'INSERT,UPDATE')
      AND NOT has_table_privilege('public', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_any_column_privilege('public', c.oid, 'INSERT,UPDATE'))
      FROM pg_class c WHERE c.oid IN ('public."RuntimeCanaryChallengeProof"'::regclass,
        'public."RuntimeCanaryChallenge"'::regclass)),
    'proof', (SELECT jsonb_build_object(
      'runtime', to_jsonb(p) || jsonb_build_object('provedAt', to_char(p."provedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'challenge', to_jsonb(c) || jsonb_build_object(
        'requestedAt', to_char(c."requestedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'expiresAt', to_char(c."expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      FROM public."RuntimeCanaryChallengeProof" p
      JOIN public."RuntimeCanaryChallenge" c ON c."nonce" = p."nonce"
      WHERE p."runtimeRole" = 'worker'
        AND p."serviceId" = ${literal(state.tuple.services.worker.id)}
        AND p."deployId" = ${literal(inventory[0].deployId)}
      ORDER BY p."provedAt" DESC, p."nonce" LIMIT 1)
  );`;
}

// This receipt comes from the protected release environment, independently of
// Render's editable saved configuration and the target DB's proof tables. The
// release operator retains it from the authenticated runtime observation: the
// digest covers BOTH canary rows, and the receipt binds their original database
// name/OID and independently verified service postcondition. Missing historical
// binding is not reconstructed from whichever database is queried now.
export function validateRecoveryWorkerSource(source) {
  fail(
    source?.schemaVersion === 1 &&
      equal(Object.keys(source).sort(), [
        "database",
        "deployId",
        "proofSha256",
        "releaseCommitSha",
        "schemaVersion",
        "serviceId",
        "servicePostconditionSha256",
      ]) &&
      typeof source.database?.name === "string" &&
      source.database.name.length > 0 &&
      /^[1-9][0-9]*$/.test(source.database.oid) &&
      /^[1-9][0-9]*$/.test(source.database.systemIdentifier) &&
      /^[a-f0-9]{64}$/.test(source.database.recoveryWitnessSha256) &&
      equal(Object.keys(source.database).sort(), [
        "name",
        "oid",
        "recoveryWitnessSha256",
        "systemIdentifier",
      ]) &&
      /^srv-[a-z0-9-]+$/.test(source.serviceId) &&
      /^dep-[a-z0-9-]+$/.test(source.deployId) &&
      /^[a-f0-9]{40}$/.test(source.releaseCommitSha) &&
      /^[a-f0-9]{64}$/.test(source.proofSha256) &&
      /^sha256:[a-f0-9]{64}$/.test(source.servicePostconditionSha256),
    "worker_runtime_retained_source",
  );
  return source;
}

export function assertRecoveryWorkerRuntime(
  journal,
  inventory,
  observed,
  retainedSource,
) {
  const state = validateRecoveryPreparation(journal);
  assertRecoveryRetainedInventory(state, "worker", inventory);
  fail(
    equal(observed?.fence, state.workerFence.fenced),
    "worker_runtime_fence",
  );
  fail(observed.proofProtected === true, "worker_runtime_evidence_authority");
  const runtime = observed.proof?.runtime;
  const challenge = observed.proof?.challenge;
  const deployment = inventory[0];
  const database = state.workerFence.fenced.database;
  fail(runtime && challenge, "worker_runtime_evidence_missing");
  const source = validateRecoveryWorkerSource(retainedSource);
  fail(
    source.database.name === database.name &&
      source.database.oid === database.oid &&
      source.database.systemIdentifier === database.systemIdentifier &&
      source.database.recoveryWitnessSha256 === database.recoveryWitnessSha256,
    "worker_runtime_database_binding",
  );
  fail(
    source.serviceId === runtime.serviceId &&
      source.deployId === runtime.deployId &&
      source.releaseCommitSha === runtime.releaseCommitSha &&
      source.servicePostconditionSha256 ===
        runtime.servicePostconditionSha256 &&
      source.proofSha256 === sha(observed.proof),
    "worker_runtime_source_binding",
  );
  fail(
    runtime.runtimeRole === "worker" &&
      runtime.databaseRole === "reviewrouter_worker" &&
      runtime.serviceId === state.tuple.services.worker.id &&
      runtime.deployId === deployment.deployId &&
      deployment.observedStatus === "live" &&
      deployment.deploymentIdentityKind === "git" &&
      runtime.deploymentProvenance === deployment.observedCommitSha &&
      runtime.releaseCommitSha === deployment.observedCommitSha &&
      // The responder proves its immutable provenance; the challenge supplies
      // the deploy ID. A reused provenance cannot distinguish two runtimes.
      inventory.filter(
        (item) => item.observedCommitSha === runtime.deploymentProvenance,
      ).length === 1,
    "worker_runtime_identity",
  );
  fail(
    runtime.systemIdentifier === database.systemIdentifier &&
      runtime.recoveryWitnessSha256 === database.recoveryWitnessSha256 &&
      challenge.systemIdentifier === runtime.systemIdentifier &&
      challenge.recoveryWitnessSha256 === runtime.recoveryWitnessSha256,
    "worker_runtime_generation",
  );
  fail(
    /^[a-f0-9]{48}$/.test(runtime.nonce) &&
      runtime.nonce === challenge.nonce &&
      challenge.releaseCommitSha === runtime.releaseCommitSha &&
      typeof challenge.rolloutId === "string" &&
      challenge.rolloutId.length > 0 &&
      /^sha256:[a-f0-9]{64}$/.test(runtime.servicePostconditionSha256) &&
      Array.isArray(challenge.serviceFacts) &&
      challenge.serviceFacts.length === 3 &&
      equal(
        challenge.serviceFacts.map((fact) => fact.runtimeRole).sort(),
        [...recoveryRoles].sort(),
      ) &&
      challenge.serviceFacts.filter((fact) => fact.runtimeRole === "worker")
        .length === 1 &&
      equal(
        challenge.serviceFacts.find((fact) => fact.runtimeRole === "worker"),
        {
          runtimeRole: "worker",
          serviceId: runtime.serviceId,
          deployId: runtime.deployId,
          deploymentProvenance: runtime.deploymentProvenance,
          servicePostconditionSha256: runtime.servicePostconditionSha256,
        },
      ) &&
      recoveryTimestamp(challenge.requestedAt) >=
        recoveryTimestamp(deployment.createdAt) &&
      recoveryTimestamp(challenge.expiresAt) -
        recoveryTimestamp(challenge.requestedAt) ===
        10 &&
      recoveryTimestamp(runtime.provedAt) >=
        recoveryTimestamp(challenge.requestedAt) &&
      recoveryTimestamp(runtime.provedAt) <=
        recoveryTimestamp(challenge.expiresAt),
    "worker_runtime_configuration",
  );
  return globalThis.structuredClone(runtime);
}

// Production identity is anchored in the checked-in workspace/environment and
// the latest successful, protected-main recovery receipt, never dispatch IDs.
export const recoveryProductionScope = Object.freeze({
  ownerId: "tea-d11m6c0dl3ps73cuh2gg",
  environmentId: "evm-d7s67t0g4nts73d4l40g",
  repository: "777genius/review-router-saas",
});

// First recovery has no historical receipt. This reviewed, source-controlled
// tuple is the sole bootstrap authority; dispatch inputs and repository secrets
// cannot replace it. Historical registration runs establish absence only.
export const recoveryBootstrapBoundary = Object.freeze({
  headSha: "42134d9b8c263915340f910786b6826824bf30b5",
  workflowBlob: "351255c5592d58460f3c58b1bf38ff87428a0d11",
});
export const recoveryBootstrapTopology = Object.freeze({
  ...recoveryProductionScope,
  targetDbId: "dpg-da32ipmk1f9s73dttm90-a",
  services: Object.freeze({
    api: Object.freeze({ id: "srv-d7s6hgbeo5us73djlp00" }),
    worker: Object.freeze({ id: "srv-d7s6hhjeo5us73djlqn0" }),
    web: Object.freeze({ id: "srv-d7s6hf3eo5us73djlndg" }),
  }),
});

// The local authority file preserves the distinction between source bootstrap
// and an immutable Actions receipt. Never fabricate a historical artifact ID.
export function recoveryTopologyAuthorityValid(topology, sourceSha) {
  if (topology.sourceKind === "protected_main_bootstrap") {
    return (
      sha(sourceSha) &&
      equal(topology, {
        ...recoveryBootstrapTopology,
        sourceKind: "protected_main_bootstrap",
        sourceSha,
        boundarySha: recoveryBootstrapBoundary.headSha,
        environment: "production-release",
      })
    );
  }
  return (
    topology.sourceKind === undefined &&
    /^[1-9][0-9]*$/.test(topology.sourceRunId) &&
    /^sha256:[a-f0-9]{64}$/.test(topology.artifactDigest)
  );
}

export async function authenticateRecoveryTopology(token, trustedMainSha) {
  const { execFileSync } = await import("node:child_process");
  const { readExactZipEntries, gitBlobSha } =
    await import("./lib/github-actions-trusted-evidence.mjs");
  const path = ".github/workflows/codex-rotating-release-migration.yml";
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim();
  fail(sha(trustedMainSha), "topology_trusted_main");
  git(
    "merge-base",
    "--is-ancestor",
    recoveryBootstrapBoundary.headSha,
    trustedMainSha,
  );
  fail(
    process.env.GITHUB_REPOSITORY === recoveryProductionScope.repository &&
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      process.env.GITHUB_REF === "refs/heads/main" &&
      process.env.GITHUB_SHA === trustedMainSha &&
      process.env.GITHUB_WORKFLOW_SHA === trustedMainSha &&
      process.env.GITHUB_WORKFLOW_REF ===
        `${recoveryProductionScope.repository}/${path}@refs/heads/main`,
    "topology_dispatch_identity",
  );
  const prefix = `https://api.github.com/repos/${recoveryProductionScope.repository}`;
  const get = async (path) => {
    const response = await globalThis.fetch(`${prefix}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: globalThis.AbortSignal.timeout(20000),
    });
    fail(response.ok, "topology_authenticated_read");
    return response.json();
  };
  const repository = await get("");
  fail(
    repository.full_name === recoveryProductionScope.repository &&
      Number.isSafeInteger(repository.id) &&
      repository.id > 0,
    "topology_repository",
  );
  const branch = await get("/branches/main");
  fail(
    branch.protected === true && branch.commit?.sha === trustedMainSha,
    "topology_protected_main",
  );
  const environment = await get("/environments/production-release");
  const reviewers = environment.protection_rules?.filter(
    (rule) => rule.type === "required_reviewers",
  );
  fail(
    environment.name === "production-release" &&
      reviewers?.length === 1 &&
      Array.isArray(reviewers[0].reviewers) &&
      reviewers[0].reviewers.length > 0 &&
      reviewers[0].prevent_self_review === true &&
      environment.deployment_branch_policy?.protected_branches === true &&
      environment.deployment_branch_policy?.custom_branch_policies === false,
    "topology_environment_policy",
  );

  // Prove absence over the complete bounded history, not just its first page.
  // A truncated/changed listing is never permission to bootstrap. Inspect all
  // successful runs before selecting the newest recovery, irrespective of order.
  const runs = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const listing = await get(
      `/actions/workflows/codex-rotating-release-migration.yml/runs?branch=main&status=success&per_page=100&page=${page}`,
    );
    total ??= listing.total_count;
    fail(
      Number.isSafeInteger(total) &&
        total >= 0 &&
        total <= 1000 &&
        listing.total_count === total &&
        Array.isArray(listing.workflow_runs) &&
        listing.workflow_runs.length === Math.min(100, total - runs.length),
      "topology_run_inventory",
    );
    runs.push(...listing.workflow_runs);
    if (runs.length === total) break;
  }
  fail(
    runs.length === total &&
      new Set(runs.map((run) => run.id)).size === runs.length,
    "topology_run_inventory",
  );
  const workflow = await get(
    "/actions/workflows/codex-rotating-release-migration.yml",
  );
  fail(
    Number.isSafeInteger(workflow.id) &&
      workflow.id > 0 &&
      workflow.path === path &&
      workflow.state === "active",
    "topology_workflow_identity",
  );
  const receipts = [];
  for (const run of runs) {
    fail(
      run.path === path &&
        run.workflow_id === workflow.id &&
        Number.isSafeInteger(run.id) &&
        run.id > 0 &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0 &&
        run.head_branch === "main" &&
        run.event === "workflow_dispatch" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.repository?.id === repository.id &&
        run.head_repository?.id === repository.id &&
        sha(run.head_sha),
      "topology_run_identity",
    );
    git("merge-base", "--is-ancestor", run.head_sha, trustedMainSha);
    const blob = git("rev-parse", `${run.head_sha}:${path}`);
    const historical = blob === recoveryBootstrapBoundary.workflowBlob;
    if (historical)
      git(
        "merge-base",
        "--is-ancestor",
        run.head_sha,
        recoveryBootstrapBoundary.headSha,
      );
    else {
      fail(
        run.head_sha !== recoveryBootstrapBoundary.headSha,
        "topology_workflow_version",
      );
      git(
        "merge-base",
        "--is-ancestor",
        recoveryBootstrapBoundary.headSha,
        run.head_sha,
      );
    }
    const requiredNames = [
      "Verify protected main dispatch",
      ...(!historical ? ["Verify exact recovery release evidence"] : []),
      "Complete restored PG17 cutover",
      "Register verified Review Action release",
    ];
    const sourceNames = [
      ...git("show", `${run.head_sha}:${path}`).matchAll(/^ {4}name: (.+)$/gm),
    ].map((match) => match[1]);
    fail(
      equal(sourceNames.sort(), [...requiredNames].sort()),
      "topology_workflow_version",
    );
    const jobs = await get(
      `/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    );
    fail(
      Array.isArray(jobs.jobs) &&
        jobs.total_count === jobs.jobs.length &&
        jobs.total_count <= 100,
      "topology_job_inventory",
    );
    fail(
      equal(jobs.jobs.map((job) => job.name).sort(), [...requiredNames].sort()),
      "topology_job_set",
    );
    const recovery = jobs.jobs.find(
      (job) => job.name === "Complete restored PG17 cutover",
    );
    for (const job of jobs.jobs) {
      const skipped =
        job.name ===
        (recovery.conclusion === "skipped"
          ? "Complete restored PG17 cutover"
          : "Register verified Review Action release");
      fail(
        job.conclusion === (skipped ? "skipped" : "success") &&
          job.status === "completed" &&
          job.head_sha === run.head_sha &&
          job.run_id === run.id &&
          job.run_attempt === run.run_attempt,
        "topology_trusted_job",
      );
    }
    if (recovery.conclusion === "skipped") continue;
    // There is no accepted historical recovery artifact at this boundary.
    // An alleged historical success blocks bootstrap; it cannot confer authority.
    fail(!historical, "topology_unaccepted_historical_receipt");
    receipts.push(run);
  }
  // Even an expired/missing/malformed newest receipt must fail below, with no
  // catch/fallback. Once recovery has succeeded, source bootstrap is unusable.
  for (const run of receipts.sort((a, b) => b.id - a.id)) {
    const artifacts = await get(
      `/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    fail(
      Array.isArray(artifacts.artifacts) &&
        artifacts.total_count === artifacts.artifacts.length &&
        artifacts.total_count <= 100,
      "topology_artifact_inventory",
    );
    const matching = artifacts.artifacts.filter(
      (item) => item.name === `reviewrouter-pg17-recovery-${run.id}`,
    );
    fail(matching.length === 1, "topology_receipt_ambiguous");
    const artifact = matching[0];
    fail(
      Number.isSafeInteger(artifact.id) &&
        artifact.id > 0 &&
        artifact.expired === false &&
        artifact.workflow_run?.id === run.id &&
        /^sha256:[a-f0-9]{64}$/.test(artifact.digest),
      "topology_receipt_identity",
    );
    const response = await globalThis.fetch(
      `${prefix}/actions/artifacts/${artifact.id}/zip`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: globalThis.AbortSignal.timeout(20000),
      },
    );
    fail(response.ok, "topology_receipt_download");
    const finalUrl = new URL(response.url);
    fail(
      finalUrl.protocol === "https:" &&
        (finalUrl.hostname === "api.github.com" ||
          finalUrl.hostname.endsWith(".githubusercontent.com") ||
          finalUrl.hostname.endsWith(".blob.core.windows.net")),
      "topology_receipt_host",
    );
    const archive = Buffer.from(await response.arrayBuffer());
    fail(
      archive.length > 0 &&
        archive.length <= 32 * 1024 * 1024 &&
        `sha256:${createHash("sha256").update(archive).digest("hex")}` ===
          artifact.digest,
      "topology_receipt_digest",
    );
    const bytes = readExactZipEntries(archive).get("recovery-manifest.json");
    fail(bytes, "topology_receipt_missing");
    const manifest = parseRecoveryJson(bytes.toString("utf8"));
    fail(
      String(manifest.recoveryRunId) === String(run.id) &&
        manifest.targetVersion === 17 &&
        /^dpg-[a-z0-9-]+$/.test(manifest.targetDbId) &&
        /^[a-f0-9]{40}$/.test(manifest.releaseCommitSha),
      "topology_manifest_identity",
    );
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", manifest.releaseCommitSha, run.head_sha],
      { stdio: "pipe" },
    );
    const services = {};
    fail(
      manifest.resumedServices?.length === 3 &&
        manifest.serviceRevisions?.length === 3,
      "topology_manifest_fleet",
    );
    for (const role of recoveryRoles) {
      const matches = manifest.resumedServices.filter(
        (service) => service.role === role,
      );
      fail(matches.length === 1, "topology_manifest_role");
      const service = matches[0];
      fail(
        /^srv-[a-z0-9-]+$/.test(service.serviceId) &&
          service.suspended === "not_suspended" &&
          service.type ===
            (role === "worker" ? "background_worker" : "web_service"),
        "topology_manifest_service",
      );
      const revisions = manifest.serviceRevisions.filter(
        (item) => item.serviceId === service.serviceId,
      );
      fail(
        revisions.length === 1 &&
          revisions[0].observedCommitSha === manifest.releaseCommitSha &&
          revisions[0].deploymentIdentityKind === "git" &&
          revisions[0].observedImageDigest === null &&
          revisions[0].observedStatus === "live",
        "topology_manifest_revision",
      );
      services[role] = { id: service.serviceId };
    }
    fail(
      new Set(Object.values(services).map((service) => service.id)).size === 3,
      "topology_duplicate_id",
    );
    return {
      ...recoveryProductionScope,
      services,
      targetDbId: manifest.targetDbId,
      sourceRunId: String(run.id),
      artifactDigest: artifact.digest,
    };
  }
  // Source must be exactly the protected dispatch commit. In particular an
  // older release checkout, edited helper, or replay at the parent cannot use
  // the bootstrap tuple. This is checked only after ruling out every receipt.
  fail(
    trustedMainSha !== recoveryBootstrapBoundary.headSha &&
      git("rev-parse", "HEAD") === trustedMainSha &&
      git(
        "rev-parse",
        `${trustedMainSha}:scripts/render-recovery-journal.mjs`,
      ) === gitBlobSha(readFileSync(new URL(import.meta.url))) &&
      git("rev-parse", `${trustedMainSha}:${path}`) ===
        gitBlobSha(readFileSync(path)),
    "topology_bootstrap_source",
  );
  return {
    ...recoveryBootstrapTopology,
    sourceKind: "protected_main_bootstrap",
    sourceSha: trustedMainSha,
    boundarySha: recoveryBootstrapBoundary.headSha,
    environment: "production-release",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const raw = readRecoveryJsonInput();
  if (process.argv[2] === "read-phase")
    process.stdout.write(
      JSON.stringify(
        readRecoveryPhaseResponse(raw, process.argv[3] === "reference"),
      ) + "\n",
    );
  else if (process.argv[2] === "read-environment")
    process.stdout.write(
      JSON.stringify(recoveryEnvironmentEntries(raw)) + "\n",
    );
  else fail(process.argv[2] === "validate-json", "command");
}
