#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# CareerVine Chrome Extension — Production Build Script
#
# Produces a Chrome Web Store-ready ZIP that connects to
# https://dawsonsprojects.com instead of localhost.
#
# Usage:  ./build-prod.sh
# Output: careervine-extension-v<VERSION>.zip in this directory
# ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Read version from manifest
VERSION=$(node -p "require('./manifest.json').version")
ZIP_NAME="careervine-extension-v${VERSION}.zip"

echo "==> Building CareerVine Extension v${VERSION} for production..."

# ── 1. Save originals so we can revert after zipping ────────
cp manifest.json manifest.json.bak
cp src/background/background.js src/background/background.js.bak

# Cleanup function: always restore dev state, even on failure
cleanup() {
  echo "==> Restoring development files..."
  mv manifest.json.bak manifest.json
  mv src/background/background.js.bak src/background/background.js
}
trap cleanup EXIT

# ── 2. Switch background.js to production environment ───────
echo "    Setting ENV = 'production' in background.js"
sed -i'' -e "s/^const ENV = 'development';/const ENV = 'production';/" src/background/background.js

# Verify the swap worked
if grep -q "const ENV = 'development'" src/background/background.js; then
  echo "ERROR: Failed to set ENV to production in background.js" >&2
  exit 1
fi

# ── 3. Strip localhost host_permissions from manifest ────────
echo "    Removing localhost host_permissions from manifest.json"
# Use node for reliable JSON manipulation
node -e "
  const fs = require('fs');
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  manifest.host_permissions = manifest.host_permissions.filter(
    p => !p.includes('localhost') && !p.includes('127.0.0.1')
  );
  fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
"

# Verify no localhost remains in manifest
if grep -q 'localhost\|127\.0\.0\.1' manifest.json; then
  echo "ERROR: localhost references still present in manifest.json" >&2
  exit 1
fi

# ── 4. Build the panel React app ────────────────────────────
echo "    Building panel-app..."
(cd panel-app && npm run build)

# ── 5. Verify no localhost in any shipped JS ─────────────────
echo "    Scanning for leftover localhost references in shipped code..."
LOCALHOST_HITS=$(grep -rl 'localhost\|127\.0\.0\.1' \
  manifest.json \
  src/ \
  env/production.json \
  2>/dev/null || true)

if [ -n "$LOCALHOST_HITS" ]; then
  echo "WARNING: localhost references found in these files:"
  echo "$LOCALHOST_HITS"
  echo "(env/development.json is excluded from the zip, so it's fine if listed above)"
  # Filter out development.json — that one is expected and won't be zipped
  REAL_HITS=$(echo "$LOCALHOST_HITS" | grep -v 'env/development.json' || true)
  if [ -n "$REAL_HITS" ]; then
    echo "ERROR: Unexpected localhost references in production files:" >&2
    echo "$REAL_HITS" >&2
    exit 1
  fi
fi

# ── 6. Create the ZIP ───────────────────────────────────────
echo "    Creating ${ZIP_NAME}..."
rm -f "$ZIP_NAME"

zip -r "$ZIP_NAME" \
  manifest.json \
  src/ \
  assets/ \
  env/production.json \
  -x "*.bak" \
  -x "src/background/background.js.bak"

# ── 7. Summary ──────────────────────────────────────────────
ZIP_SIZE=$(du -h "$ZIP_NAME" | cut -f1)
echo ""
echo "==> Done! ${ZIP_NAME} (${ZIP_SIZE}) is ready for Chrome Web Store upload."
echo ""
echo "    Included:"
echo "      - manifest.json (production host_permissions only)"
echo "      - src/ (background.js set to ENV='production')"
echo "      - assets/ (icons)"
echo "      - env/production.json"
echo ""
echo "    Excluded:"
echo "      - env/development.json"
echo "      - panel-app/ source (built output is in src/content/panel-app/)"
echo "      - *.md documentation files"
echo ""
echo "    Your working tree has been restored to development mode."
