#!/usr/bin/env bash
# Build the prebuilt Linux package for the Azure App Service (Free F1) demo.
#
#   scripts/release/build-azure-package.sh [OUT_DIR]        (default OUT_DIR: dist-release/azure)
#
# Run on Linux (or WSL) with Node 22 from a clean checkout of the commit you want to release.
# Output in OUT_DIR:
#   part.00, part.01, ...   the package zip split into 25 MB parts (mail/transfer friendly)
#   release.json            version, commit, SHA-256 of the joined zip and the part list
#   deploy-tenderflow-azure-free.ps1   the deploy script (reads release.json)
#   ANTIGRAVITY-PROMPT.md   the operator prompt for an AI deployment assistant
# The package is smoke-tested before it is split: it must start from the staged folder in dedicated MOI
# mode, answer /api/v1/version with the release version and serve the web app.
# Never build this package on Windows: node_modules would contain Windows binaries.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$ROOT/dist-release/azure}"
WORK="$(mktemp -d)"
STAGE="$WORK/pkg"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
[[ "$(uname -s)" == Linux ]] || { echo "Build the Azure package on Linux (or WSL), not on $(uname -s)." >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 22 ? 0 : 1)' || { echo "Node 22 is required (found $(node -v))." >&2; exit 1; }
if [[ -n "$(git status --porcelain --untracked-files=no)" && "${ALLOW_DIRTY:-0}" != 1 ]]; then
  echo "The working tree has uncommitted changes. Commit them first (or set ALLOW_DIRTY=1 for a test build)." >&2; exit 1
fi
VERSION="$(node -p 'require("./services/api/package.json").version')"
COMMIT="$(git rev-parse --short HEAD)"
echo "==> TenderFlow $VERSION ($COMMIT)"

echo "==> Building"
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null

echo "==> Staging the runtime files"
mkdir -p "$STAGE"
TREE="$(git stash create 2>/dev/null || true)"   # includes uncommitted tracked changes for ALLOW_DIRTY test builds
git archive "${TREE:-HEAD}" | tar -x -C "$STAGE"
cp -r apps/web/dist "$STAGE/apps/web/dist"
cp -r services/api/dist "$STAGE/services/api/dist"
# Not needed at runtime (docs ship separately; sources are compiled into dist).
rm -rf "$STAGE/docs" "$STAGE/scripts/dev" "$STAGE/scripts/windows" "$STAGE/scripts/release" "$STAGE/agents/evals" \
       "$STAGE/services/api/test" "$STAGE/services/api/src" "$STAGE/apps/web/src" "$STAGE/.github"
( cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund >/dev/null )
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{ "commit": "%s", "buildTime": "%s" }\n' "$COMMIT" "$BUILT_AT" > "$STAGE/services/api/build-info.json"   # shown by /api/v1/version
# Workspace links point back into the package and would be zipped twice; nothing imports them.
rm -rf "$STAGE/node_modules/@tenderflow"

echo "==> Smoke test (dedicated MOI, fresh database)"
PORT=$(( 20000 + RANDOM % 20000 ))
SMOKE_DATA="$WORK/data"
SMOKE_BID_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
SMOKE_AUDIT_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
( cd "$STAGE" && BID_MASTER_KEY="$SMOKE_BID_KEY" AUDIT_SIGNING_KEY="$SMOKE_AUDIT_KEY" PORT=$PORT DATA_DIR="$SMOKE_DATA" TENANCY_MODE=dedicated ENTITY_ID=moi DEMO_ENTITY=moi SEED_DEMO=true \
  DEMO_MODE=false DEMO_PASSWORD="smoke-$RANDOM-$RANDOM" CONTENT_STORE_TYPE=filesystem LOWCODE_AUTOMATION_MS=60000 \
  node services/api/dist/server.js >"$WORK/smoke.log" 2>&1 ) &
PID=$!
ok=0
for _ in $(seq 1 90); do
  kill -0 "$PID" 2>/dev/null || break
  if curl -fsS "http://127.0.0.1:$PORT/api/v1/version" 2>/dev/null | grep -q "\"$VERSION\",\"commit\":\"$COMMIT\""; then ok=1; break; fi
  sleep 1
done
if [[ $ok == 1 ]]; then
  curl -fsS "http://127.0.0.1:$PORT/api/v1/public/deployment" | grep -q '"mode":"dedicated"' || ok=0
  curl -fsS "http://127.0.0.1:$PORT/login" | grep -qi '<div id="root"' || ok=0
fi
kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true
if [[ $ok != 1 ]]; then echo "Smoke test FAILED. Server log:" >&2; tail -40 "$WORK/smoke.log" >&2; exit 1; fi
echo "    started, version $VERSION, dedicated mode, web app served"

echo "==> Zipping and splitting"
rm -rf "$OUT"; mkdir -p "$OUT"
( cd "$STAGE" && zip -qrX "$WORK/tenderflow-azure-package.zip" . )
SHA="$(sha256sum "$WORK/tenderflow-azure-package.zip" | cut -d' ' -f1 | tr a-f A-F)"
SIZE="$(stat -c %s "$WORK/tenderflow-azure-package.zip")"
( cd "$OUT" && split -b 25M -d -a 2 "$WORK/tenderflow-azure-package.zip" part. )
PARTS="$(cd "$OUT" && ls part.* | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0,"utf8").trim().split("\n")))')"
cat >"$OUT/release.json" <<JSON
{
  "product": "TenderFlow",
  "version": "$VERSION",
  "commit": "$COMMIT",
  "builtAt": "$BUILT_AT",
  "package": "tenderflow-azure-package.zip",
  "sha256": "$SHA",
  "bytes": $SIZE,
  "parts": $PARTS
}
JSON
cp "$ROOT/deploy/azure/deploy-tenderflow-azure-free.ps1" "$ROOT/deploy/azure/ANTIGRAVITY-PROMPT.md" "$OUT/"
sed -i "s/{{VERSION}}/$VERSION/g" "$OUT/ANTIGRAVITY-PROMPT.md"
echo "==> Done: $OUT"
ls -la "$OUT"
echo "SHA-256 $SHA"
