#!/bin/bash
# Double-click launcher for OrcheDev (Agent Workbench) on macOS.
# Self-locating: always runs "npm start" against the folder this script lives in.

cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "First run detected: installing dependencies..."
  npm install
fi

npm start
