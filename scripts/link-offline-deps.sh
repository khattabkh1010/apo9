#!/usr/bin/env sh
# Only for the original build sandbox (no npm registry): links pre-installed packages into node_modules.
# On a normal machine run `npm install` instead.
set -e
SRC=${1:-/opt/npm-tools/node_modules}
mkdir -p node_modules/@types
for p in react react-dom scheduler esbuild @esbuild zod undici-types; do ln -sfn "$SRC/$p" "node_modules/$p"; done
ln -sfn "$SRC/@types/node" node_modules/@types/node
echo "linked offline deps from $SRC"
