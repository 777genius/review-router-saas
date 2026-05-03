# Visual Direction

## Direction

Cyberpunk-future command center.

ReviewRouter should feel like an operational cockpit for AI code review routing. The UI should be sharp, technical, and slightly futuristic, but still trustworthy for engineering teams.

## What It Is

- high-contrast dashboard
- dark graphite/void surfaces
- cyan, magenta, and lime accents
- code and terminal-inspired details
- grid, routing, signal, scan, and circuit motifs
- crisp status/severity language
- compact but breathable information density
- keyboard-first interactions

## What It Is Not

- not generic SaaS white cards
- not purple-gradient AI template
- not gamer neon overload
- not low-contrast dark mode
- not decorative animation everywhere
- not cyberpunk at the cost of readability

## Typography

Recommended:

```text
Display/headings: Space Grotesk
Body/UI: IBM Plex Sans
Code/commands: JetBrains Mono
```

Rules:

- headings can be expressive
- body copy must stay readable
- commands and GitHub workflow snippets use mono
- do not use default Inter/Roboto/system stack as the primary brand expression

## Core Tokens

Initial token direction:

```css
:root {
  --rr-color-void: #05070d;
  --rr-color-bg: #070b14;
  --rr-color-surface: #0b1020;
  --rr-color-surface-raised: #11182d;
  --rr-color-surface-glass: rgba(13, 20, 38, 0.74);

  --rr-color-text: #e6f7ff;
  --rr-color-text-muted: #8ea4b8;
  --rr-color-text-subtle: #607086;

  --rr-color-cyan: #00e5ff;
  --rr-color-magenta: #ff2bd6;
  --rr-color-lime: #a6ff00;
  --rr-color-amber: #ffb000;
  --rr-color-red: #ff3b5f;

  --rr-color-border: rgba(144, 202, 249, 0.18);
  --rr-color-border-strong: rgba(0, 229, 255, 0.38);
  --rr-color-focus: #00e5ff;

  --rr-shadow-glow-cyan: 0 0 24px rgba(0, 229, 255, 0.22);
  --rr-shadow-glow-magenta: 0 0 24px rgba(255, 43, 214, 0.18);
}
```

Severity colors:

```text
Critical: red
Major: amber
Minor: cyan
Info: muted blue
Success: lime
```

Provider colors:

```text
Codex: cyan
OpenAI API: lime/cyan blend
OpenRouter: magenta
Future providers: assign distinct semantic accents, not random colors
```

## Layout Style

Use:

- command-center panels
- thin neon borders
- subtle grid backgrounds
- strong section headers
- compact status chips
- timeline/activity surfaces
- terminal-like command blocks
- route/path visual metaphors for provider routing

Avoid:

- too many gradients inside cards
- glowing every button
- unreadable translucent panels
- overusing magenta
- cards without hierarchy

## Motion

Allowed:

- subtle page enter
- setup step progression
- health status pulse
- command copy feedback
- provider route animation in diagrams

Forbidden:

- constant shimmer on normal content
- distracting animated backgrounds
- animation that delays setup
- motion required to understand state

## Accessibility Rules

Cyberpunk styling must not weaken accessibility.

Required:

- visible focus ring
- keyboard navigable dialogs/menus/selects
- contrast check for body text and controls
- reduced-motion support
- severity never communicated by color alone
- icons and labels for critical statuses

## First Screens To Design

Prioritize visual consistency on:

- getting started page
- repository setup page
- provider setup command step
- workflow PR status card
- last review health card
- audit log table

These screens define the product's first impression and should guide the component system.
