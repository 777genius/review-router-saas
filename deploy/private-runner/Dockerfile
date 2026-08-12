FROM node:24-bookworm-slim@sha256:65932751ed4073ed02f5c04e494e4b2572a891b7dbea0568a863dc80341bf848 AS builder
WORKDIR /build
COPY tsconfig.base.json ./
COPY packages/features/release-rollout ./packages/features/release-rollout
RUN npm install --no-save typescript@6.0.3 @types/node@22.19.17 @octokit/app@16.1.2 \
  && ./node_modules/.bin/tsc -p packages/features/release-rollout/tsconfig.build.json

FROM node:24-bookworm-slim@sha256:65932751ed4073ed02f5c04e494e4b2572a891b7dbea0568a863dc80341bf848
ARG GITHUB_ACTIONS_RUNNER_VERSION
ARG GITHUB_ACTIONS_RUNNER_SHA256
RUN test -n "$GITHUB_ACTIONS_RUNNER_VERSION" && test -n "$GITHUB_ACTIONS_RUNNER_SHA256" \
  && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 runner \
  && mkdir -p /runner/_work /runner/tmp \
  && curl --fail --silent --show-error --location "https://github.com/actions/runner/releases/download/v${GITHUB_ACTIONS_RUNNER_VERSION}/actions-runner-linux-x64-${GITHUB_ACTIONS_RUNNER_VERSION}.tar.gz" --output /tmp/runner.tgz \
  && echo "${GITHUB_ACTIONS_RUNNER_SHA256}  /tmp/runner.tgz" | sha256sum --check --strict \
  && tar --extract --gzip --file /tmp/runner.tgz --directory /runner \
  && rm /tmp/runner.tgz \
  && chown -R runner:runner /runner
WORKDIR /app
COPY --from=builder /build/packages/features/release-rollout/dist ./packages/features/release-rollout/dist
COPY --from=builder /build/node_modules ./node_modules
COPY deploy/private-runner/bootstrap.mjs /runner/bootstrap.mjs
COPY deploy/private-runner/launch-and-cleanup.mjs /runner/launch-and-cleanup.mjs
RUN chown root:root /runner/bootstrap.mjs /runner/launch-and-cleanup.mjs \
  && chmod 0555 /runner/bootstrap.mjs /runner/launch-and-cleanup.mjs \
  && mkdir -p /run/reviewrouter /run/secrets \
  && chmod 0700 /run/reviewrouter /run/secrets
USER root
CMD ["node", "/runner/bootstrap.mjs"]
