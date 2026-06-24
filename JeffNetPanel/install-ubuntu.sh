#!/usr/bin/env bash
#
# JEFF NETWORK SERVICE — one-command Ubuntu installer
#
#   curl -fsSL https://raw.githubusercontent.com/str1k3rs13/Mikrotik-Billing-System-PPOE-IPOE-and-Juanfi/main/install-ubuntu.sh | bash
#
# What it does:
#   1. Installs Node.js 22 (required for the built-in SQLite) if not present
#   2. Downloads the panel into ~/jeffnet-panel
#   3. Installs a systemd service so it starts on boot and restarts on crash
#   4. Starts it on http://<this-machine-ip>:3000
#
set -euo pipefail

REPO="str1k3rs13/Mikrotik-Billing-System-PPOE-IPOE-and-Juanfi"
BRANCH="main"
APP_DIR="$HOME/jeffnet-panel"
PORT="${PORT:-3000}"
NODE_MAJOR=22

c_g(){ printf "\033[1;32m%s\033[0m\n" "$*"; }
c_y(){ printf "\033[1;33m%s\033[0m\n" "$*"; }
c_r(){ printf "\033[1;31m%s\033[0m\n" "$*"; }
step(){ printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

echo "============================================================"
echo "  JEFF NETWORK SERVICE — Ubuntu installer"
echo "============================================================"

# ---- 0. sanity ----
if ! command -v sudo >/dev/null 2>&1; then c_r "sudo is required. Run as a user with sudo."; exit 1; fi

# ---- 1. Node.js 22 ----
need_node=1
if command -v node >/dev/null 2>&1; then
  cur=$(node -v | sed 's/v//;s/\..*//')
  if [ "$cur" -ge "$NODE_MAJOR" ]; then need_node=0; c_g "Node $(node -v) already installed."; fi
fi
if [ "$need_node" -eq 1 ]; then
  step "Installing Node.js ${NODE_MAJOR} (needed for built-in SQLite)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
  c_g "Installed $(node -v)."
fi

# ---- 2. download the app ----
step "Downloading the panel into ${APP_DIR}"
sudo apt-get install -y curl unzip >/dev/null 2>&1 || true
TMP=$(mktemp -d)
curl -fsSL "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip" -o "$TMP/app.zip"
unzip -q "$TMP/app.zip" -d "$TMP"
SRC=$(find "$TMP" -maxdepth 1 -type d -name "*-${BRANCH}" | head -1)
[ -z "$SRC" ] && SRC=$(find "$TMP" -maxdepth 1 -type d ! -path "$TMP" | head -1)
mkdir -p "$APP_DIR"
# preserve existing data (db + license) on re-install
cp -rn "$SRC"/. "$APP_DIR"/ 2>/dev/null || true
cp -r "$SRC"/server.js "$SRC"/lib "$SRC"/public "$APP_DIR"/ 2>/dev/null || true
[ -d "$SRC/website" ] && cp -r "$SRC/website" "$APP_DIR"/ 2>/dev/null || true
rm -rf "$TMP"
c_g "Files in place."

# ---- 3. systemd service (auto-start on boot, auto-restart) ----
step "Setting up the background service"
SERVICE=/etc/systemd/system/jeffnet-panel.service
NODE_BIN=$(command -v node)
sudo bash -c "cat > $SERVICE" <<EOF
[Unit]
Description=JEFF NETWORK SERVICE Panel
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable jeffnet-panel >/dev/null 2>&1
sudo systemctl restart jeffnet-panel
sleep 2

# ---- 4. done ----
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "============================================================"
c_g "  DONE — the panel is running."
echo "============================================================"
echo "  Open it in a browser:"
echo "     http://localhost:${PORT}        (on this machine)"
[ -n "${IP:-}" ] && echo "     http://${IP}:${PORT}      (from another device on the network)"
echo ""
echo "  First run shows the Activation screen with a Machine ID."
echo "  Send that ID to get your license, then drop the .key file in:"
echo "     ${APP_DIR}/license.key"
echo ""
echo "  Useful commands:"
echo "     sudo systemctl status jeffnet-panel     # is it running?"
echo "     sudo systemctl restart jeffnet-panel    # restart"
echo "     sudo systemctl stop jeffnet-panel       # stop"
echo "     journalctl -u jeffnet-panel -f          # live logs"
echo ""
c_y "  Set your MikroTik IP, GCash, etc. in Settings once it's open."
echo "============================================================"
