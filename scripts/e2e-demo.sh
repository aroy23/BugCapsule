#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$ROOT_DIR/.tmp/e2e-demo/acme-saas"
CLI="$ROOT_DIR/packages/cli/dist/cli.js"
CAPSULE_ID="bc_invoice_address_null"

rm -rf "$WORK_DIR"
mkdir -p "$(dirname "$WORK_DIR")"
cp -R "$ROOT_DIR/examples/acme-saas" "$WORK_DIR"
rm -rf "$WORK_DIR/.bugcapsule" "$WORK_DIR/dist" "$WORK_DIR/node_modules"

cd "$WORK_DIR"

echo "Step 1: original repo file count"
find . -type f \
  -not -path "./node_modules/*" \
  -not -path "./dist/*" \
  -not -path "./.bugcapsule/*" | wc -l

echo "Step 2: original failing repro"
if npm test -- export-missing-address; then
  echo "Expected original repro to fail before capsule creation." >&2
  exit 1
fi

echo "Step 3: create capsule"
node "$CLI" create --id "$CAPSULE_ID" --no-install -- npm test -- export-missing-address

echo "Step 4: capsule fails in tiny repo"
cd "$WORK_DIR/.bugcapsule/capsules/$CAPSULE_ID"
if npm test; then
  echo "Expected capsule repro to fail before fix." >&2
  exit 1
fi

echo "Step 5: apply known capsule fix"
node <<'NODE'
const fs = require("node:fs");
const filePath = "src/billing/customerAddress.ts";
const source = fs.readFileSync(filePath, "utf8");
fs.writeFileSync(filePath, source.replace(
  "  const presentAddress = address as Address;\n  return `${presentAddress.line1}, ${presentAddress.city}, ${presentAddress.country}`;",
  "  if (!address) {\n    return \"\";\n  }\n\n  return `${address.line1}, ${address.city}, ${address.country}`;"
));
NODE
npm test

echo "Step 6: apply back and verify"
cd "$WORK_DIR"
node "$CLI" apply "$CAPSULE_ID" --verify --allow-dirty
