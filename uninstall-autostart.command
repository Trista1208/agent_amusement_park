#!/bin/bash
# Stop Agent Amusement Park from running in the background
LABEL="com.agentpark.server"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Agent Amusement Park no longer starts automatically. (Double-click start.command to run it by hand.)"
read -n 1 -s -r -p "Press any key to close"
