# Outbox claim fencing rollout

Outbox delivery uses an infrastructure-only claim term:
`claimId`, database-generated `claimVersion`, `claimOwnerHash`, and `claimUntil`.
Completion, retry, dead-letter, recovery, and heartbeat mutations compare the exact
term. A stale worker receives `stale_claim` and cannot mutate delivery state.

## Safety invariants

- `claimVersion` comes only from `OutboxEvent_claimVersion_seq` and is never reused.
- A worker claims only handlers available in that process plus unknown poison
  deliveries. Known but disabled handlers remain pending.
- Handler side effects remain business-idempotent. Delivery fencing cannot undo an
  external effect committed before a crash.
- The transition guard is disabled by the expand migration. Enabling it is a
  separate, audited operator action.
- After guard activation, an unfenced worker binary must never be deployed. Roll
  back to the last fenced-capable worker or pause delivery.

## Expand and cutover

1. Deploy migration `000028_outbox_claim_fencing`.
2. Deploy a fenced-capable worker with
   `REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED=0`.
3. Confirm all delivery workers run the fenced-capable release, then stop and drain
   them. Wait longer than the configured maximum handler duration.
4. Inspect state without mutation:

   ```bash
   node scripts/activate-outbox-fencing.mjs --status
   ```

5. Classify every legacy `processing` row. If rows are proven abandoned, activate
   with the explicit reset acknowledgement; otherwise repair them manually first.

   ```bash
   node scripts/activate-outbox-fencing.mjs \
     --activate \
     --confirm-workers-drained \
     --confirm-waited-max-handler-duration \
     --reset-proven-abandoned-legacy-processing \
     --confirm-legacy-processing-abandoned \
     --actor=operator@example.com
   ```

6. Start the fenced-capable worker with
   `REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED=1`.
7. Watch `staleClaims`, recovered claims, claim age, retry, and dead-letter metrics.

The activation command takes a transaction-scoped advisory lock, refuses a second
activation, refuses undisposed legacy processing rows, records the operator, and
enables the database transition guard atomically.

## Incident response

If stale-claim or claim-age rates breach their SLO, pause v2 writers and delivery.
Do not disable the guard to recover. Reconcile external effects, repair canonical
business state, and resume with a fenced-capable worker. Never treat an outbox
dead-letter retry as permission to invent a business terminal state.
