#!/bin/bash
# Double-click to open Agent Amusement Park
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (LTS), then double-click this again."
  read -n 1 -s -r -p "Press any key to close"
  exit 1
fi
node server.js
