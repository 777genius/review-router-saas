#!/bin/sh
set -eu

case "${REVIEW_ROUTER_RUNTIME_ROLE:-}" in
  web)
    exec pnpm web:start
    ;;
  api)
    exec pnpm api:start
    ;;
  worker)
    exec pnpm worker:start
    ;;
  *)
    echo "REVIEW_ROUTER_RUNTIME_ROLE must be web, api, or worker" >&2
    exit 64
    ;;
esac
