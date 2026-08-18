# Self-hosted web fonts

These Latin variable WOFF2 files are the Space Grotesk and JetBrains Mono
assets previously emitted by Next.js from the Google Fonts versions used by
the web app. They are checked in so production and self-hosted Docker builds do
not depend on Google Fonts network availability.

Both fonts are licensed under the SIL Open Font License 1.1. The license text
is in [OFL.txt](./OFL.txt).

- Space Grotesk: Copyright 2018 The Space Grotesk Project Authors
  (https://github.com/floriankarsten/space-grotesk)
- JetBrains Mono: Copyright 2020 The JetBrains Mono Project Authors
  (https://github.com/JetBrains/JetBrainsMono)

When updating either font, replace the corresponding Latin variable WOFF2,
retain its upstream family name and supported weight range, and run
`pnpm exec vitest run apps/web/app/font-loading.contract.test.ts` plus the web
typecheck and production build.
