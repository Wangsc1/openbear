#!/bin/bash
# One matching dependency tree for all four tests, including the real postinstall.
set -euo pipefail
test "$(node --version)" = v20.20.2
npm install --global npm@11.11.0
test "$(npm --version)" = 11.11.0
bash --version
git --version
mkdir -p /work/web
cp -a --no-preserve=ownership /inputs/source/web/. /work/web/
chmod -R u+rwX /work/web
cd /work/web
npm ci --include=dev
cp -a --no-preserve=ownership node_modules /out/node_modules
mkdir -p /out/toolchain/bin /out/toolchain/lib/node_modules
cp /usr/local/bin/node /out/toolchain/bin/node
cp -a --no-preserve=ownership /usr/local/lib/node_modules/npm /out/toolchain/lib/node_modules/npm
ln -s ../lib/node_modules/npm/bin/npm-cli.js /out/toolchain/bin/npm
cp package.json package-lock.json /out/
cd /
rm -rf /work/web
