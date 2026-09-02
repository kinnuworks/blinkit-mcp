#!/usr/bin/env sh
# Copy the skill into an Alexa-hosted skill clone made by `ask init --hosted-skill-id <id>`
# and deploy it with git. Usage: scripts/push-hosted.sh /path/to/ask-clone [en-IN]
set -eu
DEST="${1:?path to the ask-cli hosted-skill clone}"
LOCALE="${2:-en-IN}"
cd "$(dirname "$0")/.."
./scripts/build-lambda.sh
rm -rf "$DEST/lambda"
mkdir -p "$DEST/lambda" "$DEST/skill-package/interactionModels/custom"
cp -R alexa/lambda/index.js alexa/lambda/store.js alexa/lambda/package.json alexa/lambda/blinkit "$DEST/lambda/"
cp "alexa/skill-package/interactionModels/custom/$LOCALE.json" "$DEST/skill-package/interactionModels/custom/"
cd "$DEST"
git add -A
git commit -qm "milk man: deploy $(date -u +%Y-%m-%dT%H:%MZ)" || true
git push origin master
echo "pushed — watch the Code tab; the build + npm install takes 2-3 minutes."
