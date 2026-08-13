# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:65932751ed4073ed02f5c04e494e4b2572a891b7dbea0568a863dc80341bf848 AS build

WORKDIR /app

ENV CI=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.33.0 --activate

# The optional private dependency is fetched only in this build stage. The SSH
# key is a BuildKit secret and is never copied into an image layer.
COPY . .
RUN --mount=type=secret,id=subscription_runtime_deploy_key_b64 \
  set -eu; \
  key_file=/tmp/subscription-runtime-key; \
  known_hosts=/tmp/subscription-runtime-known-hosts; \
  if [ -s /run/secrets/subscription_runtime_deploy_key_b64 ]; then \
    base64 -d /run/secrets/subscription_runtime_deploy_key_b64 > "$key_file"; \
    chmod 0600 "$key_file"; \
    printf '%s\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5K9okWi0dh2l9GKJl' > "$known_hosts"; \
    GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o UserKnownHostsFile=$known_hosts -o StrictHostKeyChecking=yes" \
      pnpm install --frozen-lockfile; \
    rm -f "$key_file" "$known_hosts"; \
  else \
    pnpm install --frozen-lockfile; \
  fi; \
  pnpm db:generate; \
  pnpm build; \
  pnpm store prune

FROM node:24-bookworm-slim@sha256:65932751ed4073ed02f5c04e494e4b2572a891b7dbea0568a863dc80341bf848 AS runtime

ARG IMAGE_REVISION
ARG IMAGE_VERSION

LABEL org.opencontainers.image.source="https://github.com/777genius/review-router-saas" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.version="${IMAGE_VERSION}"

WORKDIR /app

ENV CI=1 \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable \
  && corepack prepare pnpm@10.33.0 --activate

COPY --from=build --chown=node:node /app /app
COPY --chown=root:root deploy/render-runtime/entrypoint.sh /usr/local/bin/reviewrouter-runtime
RUN chmod 0555 /usr/local/bin/reviewrouter-runtime

USER node

EXPOSE 10000

ENTRYPOINT ["/usr/local/bin/reviewrouter-runtime"]
