# Client Portal — Deploy on a VPS (safe setup)

This is the **public** client portal (apply / pay / help). It runs on a small VPS, separate from
your main panel. It only **collects** submissions; your panel **pulls** them. The portal never
touches your MikroTik, and your panel never opens any inbound ports.

```
  Clients ─▶ Portal (VPS, public) ──pull──▶ Your Panel (private) ─▶ MikroTik (LAN only)
                 collects data        (panel reaches out)     you approve & provision
```

## 1. Get a small VPS
Any cheap VPS works (DigitalOcean, Vultr, Hetzner, or a PH provider). 1 vCPU / 1 GB is plenty.
Install Node.js 22 (same as the panel):
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 2. Put the portal on the VPS
Copy this `jeffnet-portal` folder to the VPS (scp, git clone, etc.), then:
```bash
cd jeffnet-portal
# pick a LONG random secret — your panel will use the same one:
export SYNC_TOKEN=$(openssl rand -hex 24)
echo "SAVE THIS TOKEN: $SYNC_TOKEN"
PORT=8080 node portal.js
```
The portal refuses to start without SYNC_TOKEN (so the pull API is never unprotected).

### Run it as a service (starts on boot, restarts on crash)
Create `/etc/systemd/system/jeffnet-portal.service`:
```ini
[Unit]
Description=JEFF NETWORK Client Portal
After=network.target

[Service]
Type=simple
User=YOURUSER
WorkingDirectory=/home/YOURUSER/jeffnet-portal
Environment=PORT=8080
Environment=SYNC_TOKEN=PASTE-YOUR-TOKEN-HERE
ExecStart=/usr/bin/node /home/YOURUSER/jeffnet-portal/portal.js
Restart=always

[Install]
WantedBy=multi-user.target
```
Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now jeffnet-portal
```

## 3. Put it behind HTTPS (recommended)
Point your domain (e.g. portal.yourbiz.com) at the VPS, then use Caddy for automatic HTTPS:
```bash
sudo apt-get install -y caddy
# /etc/caddy/Caddyfile:
#   portal.yourbiz.com {
#       reverse_proxy localhost:8080
#   }
sudo systemctl restart caddy
```
Now clients visit https://portal.yourbiz.com/apply etc.
(You can also put it behind a Cloudflare proxy for the domain.)

## 4. Connect your MAIN PANEL to it
In the panel, open **Settings → Client Portal Sync** and set:
- **Portal URL:** https://portal.yourbiz.com  (no trailing slash)
- **Portal token:** the SYNC_TOKEN from step 2
- **Enable sync:** on

The panel will pull new submissions every minute (applications become job orders, help tickets
and payment notices are logged). You can also hit **Sync now**.

## Why this is safe
- The portal has **no router access and no router credentials**. If the VPS is ever breached, the
  worst case is leaked application info — your router and network stay private.
- Your panel makes only **outbound** pull requests, so your home/office network needs **no open
  inbound ports**.
- The pull API is protected by the secret token (constant-time checked). Keep the token private;
  rotate it by changing it in both places if it ever leaks.

## What flows where
- **Apply** → becomes a Job Order in your panel (you assign a tech, approve, etc.)
- **Help** → logged in your panel's activity log
- **Pay** → logged as a payment NOTICE (you still confirm and record the actual payment yourself —
  the portal never moves money)
