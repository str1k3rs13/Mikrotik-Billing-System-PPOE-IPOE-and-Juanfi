#!/usr/bin/env bash
# Remove the JEFF NETWORK SERVICE panel + its service (keeps your data folder unless you delete it).
set -e
echo "Stopping and removing the service..."
sudo systemctl stop jeffnet-panel 2>/dev/null || true
sudo systemctl disable jeffnet-panel 2>/dev/null || true
sudo rm -f /etc/systemd/system/jeffnet-panel.service
sudo systemctl daemon-reload
echo "Service removed."
echo ""
echo "Your files are still in: $HOME/jeffnet-panel"
echo "To delete them too (INCLUDING your database + license), run:"
echo "    rm -rf \"$HOME/jeffnet-panel\""
