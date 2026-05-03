# ADR-016: Cyberpunk-Future Visual Direction

## Status

Accepted.

## Context

ReviewRouter needs to feel memorable and credible. A generic SaaS dashboard would weaken the brand and make the product look interchangeable with every other GitHub App dashboard.

The user-selected direction is cyberpunk future.

## Decision

Use a cyberpunk-future command-center visual direction.

This means:

- dark operational base
- neon accents used with restraint
- strong grid, terminal, code, and routing metaphors
- high contrast status cards
- precise severity colors
- sharp but readable typography
- subtle atmospheric backgrounds
- no noisy gamer aesthetic
- no generic purple-on-white SaaS look

## Implementation

Product design tokens and visual rules live in [`../product/08-visual-direction.md`](../product/08-visual-direction.md).

UI implementation rules live in:

- [`../architecture/35-dashboard-frontend-architecture.md`](../architecture/35-dashboard-frontend-architecture.md)
- [`../architecture/36-ui-component-wrapper-conventions.md`](../architecture/36-ui-component-wrapper-conventions.md)
- [`../architecture/37-frontend-clean-architecture.md`](../architecture/37-frontend-clean-architecture.md)

## Consequences

Benefits:

- stronger brand memory
- dashboard can feel like an AI review control room
- visual language naturally fits routing, signals, findings, severity, and CI/CD status

Risks:

- cyberpunk can become noisy fast
- dark UI can hide accessibility issues if tokens are not disciplined
- too much motion or glow can reduce trust

Mitigations:

- define tokens before components
- keep neon as accent, not background
- use semantic status colors consistently
- require contrast checks for primary text, controls, and severity labels
- keep motion purposeful and low amplitude
