# Iteration 09 - Free Entitlements and Future Billing Boundary

## Goal

Add entitlement checks without enabling payments.

## Scope

- Entitlement aggregate
- free plan defaults
- entitlement policy service
- feature flags for future paid features
- UI labels for beta/free status

## Rule

Do not scatter plan checks in React components or route handlers. Use application policy services.

## Tests

- free entitlement allows MVP features
- disabled future feature returns clear error
- entitlement audit events where relevant

## Done When

- adding payment later does not require rewriting every feature

## Implemented Baseline

- `features-entitlements` owns free beta plan defaults, feature flags, inactive entitlement denial, and denial audit events.
- Dashboard mutations enforce entitlements before side effects:
  - repository dashboard actions: manual repository sync and outbox retry
  - workflow provisioning: setup PR creation
  - action control plane: review config save
- Action Control Plane has an `ActionEntitlementPolicyPort`.
- API composition adapts that port to `features-entitlements` through `PrismaActionEntitlementPolicy`.
- CI action session exchange and runtime config fetch both re-check `action_control_plane` entitlement, so a paused workspace stops receiving control-plane config even if a short-lived session was issued earlier.
- Denials are mapped to safe public errors:
  - dashboard: `entitlement_denied`
  - action API: `action_control_plane_entitlement_denied`

## Verification

```bash
pnpm test -- packages/features/entitlements/src/tests/entitlements.test.ts
pnpm test -- packages/features/action-control-plane/src/tests/action-control-plane.test.ts apps/api/src/app.test.ts
pnpm typecheck
pnpm build
pnpm lint
pnpm format:check
pnpm local:check
```
