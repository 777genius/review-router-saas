import { createHash } from "node:crypto";

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
  fail(
    typeof raw === "string" && Buffer.byteLength(raw, "utf8") <= 1024 * 1024,
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
    fail(depth <= 64 && ++values <= 100000, "json_complexity");
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

// Only save-only journal metadata is excluded. Every runtime key, including
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

function recoveryEnvironmentEntries(environment) {
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

export function readRecoveryPhaseResponse(response) {
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
  return loadRecoveryJournal(journal, journal.tuple);
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
  return state;
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
// broader privilege revocation. The evidence contains ACL metadata only.
export const workerFenceSnapshotSql = `SELECT jsonb_build_object(
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

// Missing retained evidence cannot authorize restoration. Compensation may
// nevertheless prove an already-fenced ACL and retain a local REVOKE-only plan.
export function planWorkerCompensationFence(observed) {
  if (
    observed?.effectiveUpdate !== false ||
    observed?.effectiveColumnUpdate !== false
  )
    return planWorkerEffectFence(observed);
  const before = globalThis.structuredClone(observed);
  before.tableAcl.push({
    grantee: "reviewrouter_worker",
    grantor: before.owner,
    privilege: "UPDATE",
    grantable: false,
  });
  before.effectiveUpdate = true;
  before.effectiveColumnUpdate = true;
  const plan = planWorkerEffectFence(before);
  fail(equal(plan.fenced, observed), "compensation_fenced_snapshot");
  return plan;
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
  fail(
    equal(Object.keys(fingerprints).sort(), [...recoveryRoles].sort()),
    "preparation_roles",
  );
  for (const role of recoveryRoles) {
    fail(
      fingerprints[role].serviceId === state.tuple.services[role].id &&
        /^[a-f0-9]{64}$/.test(fingerprints[role].fingerprint),
      "preparation_configuration",
    );
  }
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
        state.revision === 0 && state.bootstrapPhase === undefined,
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
  const journals = replicas.map((value) =>
    loadRecoveryJournal(value, expectedTuple),
  );
  const fences = journals.map((state) => state.workerFence ?? null);
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
    !inventory.some(
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

// Production identity is anchored in the checked-in workspace/environment and
// the latest successful, protected-main recovery receipt, never dispatch IDs.
export const recoveryProductionScope = Object.freeze({
  ownerId: "tea-d11m6c0dl3ps73cuh2gg",
  environmentId: "evm-d7s67t0g4nts73d4l40g",
  repository: "777genius/review-router-saas",
});

export async function authenticateRecoveryTopology(token, trustedMainSha) {
  const { execFileSync } = await import("node:child_process");
  const { readExactZipEntries } =
    await import("./lib/github-actions-trusted-evidence.mjs");
  fail(/^[a-f0-9]{40}$/.test(trustedMainSha), "topology_trusted_main");
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
    repository.full_name === recoveryProductionScope.repository,
    "topology_repository",
  );
  const path = ".github/workflows/codex-rotating-release-migration.yml";
  const listing = await get(
    "/actions/workflows/codex-rotating-release-migration.yml/runs?branch=main&status=success&per_page=100",
  );
  fail(
    Array.isArray(listing.workflow_runs) && listing.workflow_runs.length > 0,
    "topology_history_missing",
  );
  // API ordering is newest first. Never skip a broken recovery receipt to adopt
  // older IDs; skipped registration-only runs cannot confer recovery authority.
  for (const run of listing.workflow_runs) {
    fail(
      run.path === path &&
        run.head_branch === "main" &&
        run.event === "workflow_dispatch" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.repository?.id === repository.id &&
        run.head_repository?.id === repository.id &&
        /^[a-f0-9]{40}$/.test(run.head_sha),
      "topology_run_identity",
    );
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", run.head_sha, trustedMainSha],
      { stdio: "pipe" },
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
    const recovery = jobs.jobs.filter(
      (job) => job.name === "Complete restored PG17 cutover",
    );
    fail(recovery.length === 1, "topology_recovery_job");
    if (recovery[0].conclusion === "skipped") continue;
    for (const name of [
      "Verify protected main dispatch",
      "Verify exact recovery release evidence",
      "Complete restored PG17 cutover",
    ]) {
      const matching = jobs.jobs.filter((job) => job.name === name);
      fail(
        matching.length === 1 &&
          matching[0].conclusion === "success" &&
          matching[0].status === "completed" &&
          matching[0].head_sha === run.head_sha &&
          matching[0].run_id === run.id &&
          matching[0].run_attempt === run.run_attempt,
        "topology_trusted_job",
      );
    }
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
    const manifest = JSON.parse(bytes.toString("utf8"));
    fail(
      String(manifest.recoveryRunId) === String(run.id) &&
        manifest.targetVersion === 17 &&
        /^[a-f0-9]{40}$/.test(manifest.releaseCommitSha),
      "topology_manifest_identity",
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
      sourceRunId: String(run.id),
      artifactDigest: artifact.digest,
    };
  }
  throw new Error("recovery_topology_history_missing");
}
