#!/bin/bash
# Nova AI setup for macOS. Double-click (first time: right-click -> Open -> Open).
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Nova needs Node.js. The download page opens now:"
  echo "click the macOS Installer (.pkg), install it, then double-click this file again."
  open "https://nodejs.org/en/download"
  read -r -p "Press Enter to close."
  exit 1
fi
node setup/setup.mjs "$@"
echo
read -r -p "Press Enter to close."
