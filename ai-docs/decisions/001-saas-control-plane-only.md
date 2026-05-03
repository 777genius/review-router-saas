# ADR-001: SaaS as Control Plane Only in v1

## Status

Accepted.

## Decision

ReviewRouter SaaS v1 is a control plane, not a review execution cloud.

The actual review runs in customer CI/CD, normally GitHub Actions, using the ReviewRouter Action installed in the customer repository.

## Rationale

This preserves the main product benefits while avoiding the two hardest early-stage risks:

- high LLM/review compute load on our infrastructure
- custody of private repository code and sensitive model credentials

The SaaS still delivers value through:

- GitHub App installation flow
- repository discovery and sync
- config management
- workflow provisioning and updates
- audit logs
- health checks
- skip/override visibility
- team permissions
- future billing and entitlements

## Consequences

Positive:

- lower server cost
- easier security story
- easier trust story for private repos
- Codex OAuth remains customer-owned
- faster path to public beta

Negative:

- customer still needs a workflow file
- runtime behavior depends on customer CI/CD environment
- support must handle GitHub Actions failures
- cannot fully guarantee review execution latency

## Future Option

A cloud execution tier may be added later, but it should be explicitly opt-in and use API-key/managed-credit billing. Customer ChatGPT/Codex OAuth custody should remain out of scope unless OpenAI provides a formal delegated enterprise mechanism for that use case.
