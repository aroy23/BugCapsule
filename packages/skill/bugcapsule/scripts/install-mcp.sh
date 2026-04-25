#!/usr/bin/env bash
set -euo pipefail

cat <<'JSON'
{
  "mcpServers": {
    "bugcapsule": {
      "command": "npx",
      "args": ["-y", "@bugcapsule/mcp"]
    }
  }
}
JSON
