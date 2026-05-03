export function renderSpikeWorkflow(options: {
  audience: string;
  endpointUrl: string;
}): string {
  return `name: ReviewRouter SaaS Spike

on:
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  id-token: write
  pull-requests: write
  issues: write

jobs:
  oidc-claims:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false

      - name: Request OIDC token and print safe claims
        shell: bash
        env:
          AUDIENCE: ${options.audience}
          REVIEWROUTER_ENDPOINT_URL: ${options.endpointUrl}
        run: |
          set -euo pipefail
          if [ -z "\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] || [ -z "\${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
            echo "OIDC request env is missing. Check id-token: write permission."
            exit 1
          fi
          token_json=$(curl -fsSL -H "Authorization: bearer \${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" "\${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=\${AUDIENCE}")
          token=$(node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(data.value)" <<< "$token_json")
          payload=$(node -e "const token=process.argv[1]; const payload=JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); delete payload.jti; console.log(JSON.stringify(payload, null, 2));" "$token")
          echo "ReviewRouter OIDC safe claims:"
          echo "$payload"
          if [ -n "\${REVIEWROUTER_ENDPOINT_URL}" ]; then
            curl -fsSL -X POST "\${REVIEWROUTER_ENDPOINT_URL}/api/action/v1/session/exchange" \
              -H 'content-type: application/json' \
              --data "$(node -e "console.log(JSON.stringify({token: process.argv[1]}))" "$token")" >/dev/null
            echo "ReviewRouter OIDC exchange succeeded"
          fi
`;
}
