# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app

ENV CI=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.33.0 --activate

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm db:generate \
  && pnpm build \
  && pnpm store prune

FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0

COPY --from=build --chown=node:node /app /app

USER node

EXPOSE 3000 4000

CMD ["pnpm", "api:start"]
