FROM node:24-bookworm-slim

ARG IMAGE_SOURCE="https://github.com/777genius/review-router-saas"
ARG IMAGE_REVISION="unknown"
ARG IMAGE_VERSION="v1"

LABEL org.opencontainers.image.title="ReviewRouter GitLab Runtime"
LABEL org.opencontainers.image.description="ReviewRouter CI runtime for GitLab merge request reviews"
LABEL org.opencontainers.image.source="${IMAGE_SOURCE}"
LABEL org.opencontainers.image.revision="${IMAGE_REVISION}"
LABEL org.opencontainers.image.version="${IMAGE_VERSION}"

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && npm install -g @openai/codex@0.135.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/features/review-publishing/package.json packages/features/review-publishing/package.json

RUN pnpm install --frozen-lockfile --filter @reviewrouter/features-review-publishing...

COPY packages/shared packages/shared
COPY packages/features/review-publishing packages/features/review-publishing

RUN pnpm --filter @reviewrouter/shared build \
  && pnpm --filter @reviewrouter/features-review-publishing build \
  && pnpm exec esbuild packages/features/review-publishing/src/interface/cli/reviewrouter-gitlab-review.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node24 \
    --outfile=/usr/local/lib/reviewrouter-gitlab-review.mjs \
  && printf '%s\n' '#!/bin/sh' 'exec node /usr/local/lib/reviewrouter-gitlab-review.mjs "$@"' > /usr/local/bin/reviewrouter-gitlab-review \
  && chmod +x /usr/local/bin/reviewrouter-gitlab-review

ENV NODE_ENV=production
ENV PATH="/usr/local/bin:${PATH}"

CMD ["reviewrouter-gitlab-review", "--help"]
