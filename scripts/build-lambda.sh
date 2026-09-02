#!/usr/bin/env sh
# Vendor the compiled blinkit library into the Alexa Lambda package.
# The Lambda imports ./blinkit/*.js directly — no MCP server, no tool discovery.
set -eu
cd "$(dirname "$0")/.."
pnpm build >/dev/null
mkdir -p alexa/lambda/blinkit
for f in session client api parse payment; do
  cp "dist/$f.js" alexa/lambda/blinkit/
done
echo "vendored: $(ls alexa/lambda/blinkit | tr '\n' ' ')"
