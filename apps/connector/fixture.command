#!/bin/sh
set -eu
connector_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -eq 0 ]; then
  set -- fixture browser assist
fi
exec node --experimental-transform-types --disable-warning=ExperimentalWarning "$connector_dir/src/cli.ts" "$@"
