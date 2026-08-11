#!/bin/sh

unset REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL
exec node "${0%/*}/deploy-render-hosted-beta.mjs" "$@"
