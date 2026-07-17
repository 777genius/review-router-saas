FROM node:24-bookworm-slim AS builder

WORKDIR /build

RUN npm install --no-save --no-package-lock --ignore-scripts esbuild@0.28.0 zod@4.4.2

COPY tsconfig.base.json tsconfig.base.json
COPY packages/shared packages/shared
COPY packages/features/review-publishing packages/features/review-publishing

RUN ./node_modules/.bin/esbuild packages/features/review-publishing/src/interface/cli/reviewrouter-gitlab-review.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node24 \
    --alias:@reviewrouter/shared=/build/packages/shared/src/index.ts \
    --outfile=/build/reviewrouter-gitlab-review.mjs

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

RUN npm install -g @openai/codex@0.135.0

COPY --from=builder /build/reviewrouter-gitlab-review.mjs /usr/local/lib/reviewrouter-gitlab-review.mjs

RUN printf '%s\n' '#!/bin/sh' 'exec node /usr/local/lib/reviewrouter-gitlab-review.mjs "$@"' > /usr/local/bin/reviewrouter-gitlab-review \
  && chmod +x /usr/local/bin/reviewrouter-gitlab-review

ENV NODE_ENV=production
ENV PATH="/usr/local/bin:${PATH}"

CMD ["reviewrouter-gitlab-review", "--help"]
