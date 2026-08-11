# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app

ENV CI=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl postgresql-client \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.33.0 --activate

FROM base AS build
ARG REVIEW_ROUTER_WEB_URL
ARG REVIEW_ROUTER_API_URL
ARG REVIEW_ROUTER_PUBLIC_WEB_URL
ARG REVIEW_ROUTER_PUBLIC_API_URL
ENV REVIEW_ROUTER_WEB_URL=${REVIEW_ROUTER_WEB_URL} \
    REVIEW_ROUTER_API_URL=${REVIEW_ROUTER_API_URL} \
    REVIEW_ROUTER_PUBLIC_WEB_URL=${REVIEW_ROUTER_PUBLIC_WEB_URL} \
    REVIEW_ROUTER_PUBLIC_API_URL=${REVIEW_ROUTER_PUBLIC_API_URL}
COPY . .
RUN pnpm --filter @reviewrouter/api... --filter @reviewrouter/worker... --filter @reviewrouter/web... install --frozen-lockfile \
  && pnpm --filter @reviewrouter/platform-db db:generate \
  && pnpm --filter @reviewrouter/api... --filter @reviewrouter/worker... --filter @reviewrouter/web... build \
  && node scripts/rewrite-dist-esm-imports.mjs \
  && pnpm store prune

FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0

COPY --from=build --chown=node:node /app /app

USER node

EXPOSE 3000 4000

CMD ["pnpm", "api:start"]
