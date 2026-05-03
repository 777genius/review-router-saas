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
