#!/usr/bin/env bash
# Runs the project's wrangler. Default: plain wrangler, authenticated by `wrangler login` or a
# CLOUDFLARE_API_TOKEN you export. If the Cloudflare `cf` CLI is installed and logged in (and no
# token is exported), its OAuth token is used instead: `cf auth whoami` refreshes it hourly.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]] && command -v cf >/dev/null && whoami=$(cf auth whoami 2>/dev/null); then
  CLOUDFLARE_ACCOUNT_ID=$(jq -r '.accounts[0].id' <<<"$whoami")
  CLOUDFLARE_API_TOKEN=$(jq -r '.oauth_token' "${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare/config/default.json")
  export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
fi

exec node_modules/.bin/wrangler "$@"
