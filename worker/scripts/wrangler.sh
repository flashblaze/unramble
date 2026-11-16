#!/usr/bin/env bash
# Run the project's wrangler with the `cf` CLI login. wrangler's own OAuth login lacks the
# Workers/Workers AI scopes; the cf login has them. `cf auth whoami` refreshes the hourly token.
set -euo pipefail
cd "$(dirname "$0")/.."

whoami=$(cf auth whoami)
CLOUDFLARE_ACCOUNT_ID=$(jq -r '.accounts[0].id' <<<"$whoami")
CLOUDFLARE_API_TOKEN=$(jq -r '.oauth_token' "${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare/config/default.json")
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN

exec node_modules/.bin/wrangler "$@"
