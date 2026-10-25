#!/bin/bash
# Starts Nova AI on this Mac. Keep the window open while you use Nova; close it to stop Nova.
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if [ ! -f .next/BUILD_ID ]; then
  echo 'Nova is not installed yet: double-click "Install Nova (Mac).command" first.'
  read -r -p "Press Enter to close."
  exit 1
fi
if node -e "fetch('http://127.0.0.1:3000/api/pair').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
  echo "Nova is already running."
  sleep 2
  exit 0
fi
echo "Nova AI is running. Keep this window open (you can minimize it). Close it to stop Nova."
exec node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000
