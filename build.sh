#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist && rm -f dist/translate-en-ja.xpi
zip -r -q dist/translate-en-ja.xpi manifest.json icons lib popup
echo "built: dist/translate-en-ja.xpi"
