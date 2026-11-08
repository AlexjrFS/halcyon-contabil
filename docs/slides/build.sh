#!/usr/bin/env bash
# Builds docs/slides/halcyon-contabil-slides.pdf from slides.html with headless Chrome.
# Usage: bash docs/slides/build.sh https://your-demo-url
set -euo pipefail
cd "$(dirname "$0")"
URL="${1:-}"
if [ -z "$URL" ]; then echo "Pass the live demo URL as the first argument." >&2; exit 1; fi
CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
[ -x "$CHROME" ] || CHROME="$(command -v google-chrome chromium chromium-browser 2>/dev/null | head -1)"
sed "s|{{LIVE_URL}}|${URL}|g" slides.html > .build.html
HERE="$(pwd -W 2>/dev/null || pwd)"
rm -f halcyon-contabil-slides.pdf
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="$HERE/halcyon-contabil-slides.pdf" "file:///$HERE/.build.html" || true
rm -f .build.html
[ -s halcyon-contabil-slides.pdf ] || { echo "PDF was not created" >&2; exit 1; }
echo "Wrote $HERE/halcyon-contabil-slides.pdf"
