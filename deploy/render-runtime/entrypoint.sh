#!/bin/sh
set -eu

# Every writer role refuses to start unless its plaintext recovery witness
# matches the W2 fingerprint staged for the restored database generation.
node --conditions=production scripts/record-runtime-generation-witness-proof.mjs
# Each role independently answers only fresh challenges matching its local
# service and immutable deployment provenance. The API route waits for all
# three role-bound responses before returning a canary proof.
node --conditions=production scripts/respond-runtime-canary-challenges.mjs &

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
