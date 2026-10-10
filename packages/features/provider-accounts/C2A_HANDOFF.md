# C2a PR494 pending-selection correction

F1/P1 from the delivered independent REQUEST_CHANGES review is repaired in the
existing domain eligibility guard: any non-null pendingFence denies selection,
including an active authorized rebind. Live authorization, current state,
independent stored counters, retained intent and exact ACK CAS are unchanged.
After the exact retained policy-2 ACK clears intent, current policy/binding 3/3
may select; ACK revision need not equal current policy revision. Revoked state
still denies after ACK. Unknown, wrong and stale receipts cannot lift denial
while intent remains.

Only these five owned files changed: domain/provider-account.ts,
binding-policy.test.mts, use-cases.test.mts, postgres-fences.ts and this handoff.
The separate historical rehearsal reader fix and all protected source bytes were
preserved. No schema, SQL, ports, reconciliation, SDK, UI, runtime or dependency
change was made. No commit, push, deploy, provider, credential or real-project
agent action occurred.

Normative53, Q and the complete independent review were read before editing;
the three delivered SHA256 values matched INPUT-MANIFEST.json. Supplied current
head is described as d5 by the request; observed Git HEAD/parent and index-lock
state remain UNVERIFIED. The single Git preflight exited128 because the linked
metadata points to unavailable source-c2a-qualified-root-6d8d/.git/worktrees/
c2a-pending-selection-fix. No repeated Git administrative probe or repair ran.
Requested lane: gpt-6.1-sol/high/default, NOFAST, preferredw; controller provenance
is not independently certified here.

Observed on Node24.21.0:

- Corrected nearest tests against the captured old production domain in an
  isolated copied-source overlay: exit1, 31 tests, 29 pass, 2 fail, zero skips.
  Failures are missing pending-selection exception/rejection in the domain and
  actual exported rebind use case; no missing-module failure substitutes for them.
- Repaired worktree, same four-file focused command: exit0, 31/31 pass, zero skips.
- Existing PostgreSQL scenario syntax check: exit0. This is NOT a typecheck or
  PostgreSQL execution receipt. Actual PG and meaningful TS/MTS typechecks are
  NOT_RUN here; primary owns them in its existing isolated qualified environment.
  command -v tsc found no compiler. No dependency/Prisma/Docker retry or install ran.

The existing PG restart scenario now grants3/3 retaining policy2, denies before
and after unknown delivery/wrong ACK/lost local write/new-client and fresh-process
readback, then
uses actual Prisma exact ACK CAS and selects3/3 with ACK2. A new revoke4 leaves a
still-valid pending receipt for the original blocked stale-ACK race; that race
now replaces4 with5 and checks the prior ACK survives. The subsequent existing
grant/revoke/rebind scenario advances accordingly and denies the last rebind
until its own ACK7, then selects8/8. X/Y and account-mirror assertions remain.
These are written scenarios, not observed SQL/remote-gateway proof. Gateway
responses remain boundary doubles. Full actual MiMo tools/final/App is unproved.

Run from the qualified checkout root:

```sh
node --import ./packages/features/provider-accounts/tests/register-source-loader.mjs --test packages/features/provider-accounts/tests/use-cases.test.mts packages/features/provider-accounts/tests/binding-policy.test.mts packages/features/provider-accounts/tests/fences.test.mts packages/features/provider-accounts/tests/database-target.test.mts
pnpm --filter @reviewrouter/features-provider-accounts typecheck
# Set the existing guarded disposable PG fixture variables, then:
node --experimental-transform-types --import ./packages/features/provider-accounts/tests/register-source-loader.mjs --test packages/features/provider-accounts/tests/postgres.test.mts
```

Exact five-path repair.patch, nearest-tests.patch, original preimages/, before/
after hashes.json, protected source hashes and observed logs are in:
/srv/worker-state/jobs/review-router/account-gateway-v1/jobs/review-router-account-gateway-v1-c2a-pending-selection-fix/tmp/agent/c2a-pending-selection-fix-artifacts/
Apply only against matching preimages; integration/controller owns actual gates
and Git lifecycle. Source diff remains intact; qualification stays pending.
