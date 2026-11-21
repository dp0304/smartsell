#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."

: "${DATABASE_URL:?set DATABASE_URL for the app_rw login}"
: "${PUBLIC_ORIGIN:?set the public HTTPS origin}"
: "${APP_SECRET:?set the application secret}"
if [[ -n ${MEDIA_DIRECTORY:-} && -e $MEDIA_DIRECTORY/.restore-hold ]]; then
  if [[ ${ROLE:-all} != api || -n ${BACKGROUND_DATABASE_URL:-} || -n ${SETUP_TOKEN:-} ||
        ${SMARTSELL_COMMERCE_PROVIDER_CREDENTIALS:-'{}'} != '{}' || ${SMARTSELL_SHOPIFY_APPS:-'[]'} != '[]' ||
        ${SMARTSELL_SHOPEE_CATALOG_GRANTS:-'[]'} != '[]' ]]; then
    printf 'Physical restore hold requires the recovery overlay and disabled provider credentials\n' >&2
    exit 1
  fi
fi
export NODE_ENV=production
unset MIGRATION_DATABASE_URL
cd apps/server
exec node --import tsx src/command-main.ts
