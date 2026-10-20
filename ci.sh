#!/usr/bin/env bash
# Local stand-in for .github/workflows/test.yml, minus installs.
set -euo pipefail
cd "$(dirname "$0")"
npm test
echo "ci ok"
