# Running on Ubuntu / Linux

The panel is pure Node.js — it runs on Ubuntu (and other Linux) just as well as Windows.

## One-command install

On a fresh Ubuntu machine (or VPS), paste this in the terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/str1k3rs13/Mikrotik-Billing-System-PPOE-IPOE-and-Juanfi/main/install-ubuntu.sh | bash
```

That single command:

1. Installs **Node.js 22** (required — the panel uses Node's built-in SQLite, which needs Node 22+).
2. Downloads the panel into `~/jeffnet-panel`.
3. Installs a **systemd service** so it starts automatically on boot and restarts if it ever crashes.
4. Starts it on **http://localhost:3000** (and on your machine's LAN IP for other devices).

When it finishes it prints the exact URL to open.

## First run

The first time you open it, you'll see the **Activation screen** with a **Machine ID**.
Send that ID to get your license, then put the `.key` file here:

```
~/jeffnet-panel/license.key
```

…and restart:

```bash
sudo systemctl restart jeffnet-panel
```

Then set your MikroTik IP, GCash details, etc. in **Settings**.

## Managing the service

```bash
sudo systemctl status jeffnet-panel     # is it running?
sudo systemctl restart jeffnet-panel    # restart (after dropping in a license, etc.)
sudo systemctl stop jeffnet-panel       # stop
journalctl -u jeffnet-panel -f          # watch live logs
```

## Updating

Re-run the install command. It keeps your database and license, and refreshes the app code:

```bash
curl -fsSL https://raw.githubusercontent.com/str1k3rs13/Mikrotik-Billing-System-PPOE-IPOE-and-Juanfi/main/install-ubuntu.sh | bash
```

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/str1k3rs13/Mikrotik-Billing-System-PPOE-IPOE-and-Juanfi/main/uninstall-ubuntu.sh | bash
```

(Your data folder `~/jeffnet-panel` stays unless you delete it manually.)

## Notes / honest caveats

- **Node 22 is required.** Ubuntu's default `apt install nodejs` is usually older and will NOT work
  (you'd get a `node:sqlite` error). The installer adds the NodeSource repo to get Node 22 — don't
  skip it.
- **Run it on the same network as your MikroTik.** Like on Windows, the panel talks to the router on
  your LAN. A cloud VPS can only manage the router if it can reach it (VPN/tunnel) — otherwise install
  on a local machine/mini-PC at the site.
- **Manual install** (no systemd) is also fine:
  ```bash
  cd ~/jeffnet-panel && node server.js
  ```
