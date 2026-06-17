# JEFF NETWORK SERVICE — Setup Guide

Welcome! This guide gets your management system running in a few minutes.
Follow the steps in order. If you get stuck, message me — I'll help you.

---

## What you need
- A Windows computer (the one that will run your system — it can stay on in your shop)
- Your MikroTik router (RouterOS v7, e.g. hEX) on the same network
- A few minutes

---

## STEP 1 — Install Node.js (one time)
The system needs a free helper called Node.js.
1. Go to **https://nodejs.org**
2. Download the **LTS** version (the big green button)
3. Run the installer — just keep clicking Next / Install. Done.

You only do this once per computer.

---

## STEP 2 — Unzip the system
1. Unzip the file I sent you (e.g. `JeffNetPanel.zip`) into a folder you'll remember,
   for example `C:\JeffNetPanel`.
2. Open that folder. You should see `JeffNetPanel.bat` and some other files.

---

## STEP 3 — Start it
1. Double-click **`JeffNetPanel.bat`**.
2. A black window opens and says the panel is starting. **Keep this window open** while you use the system.
3. Open your web browser (Chrome/Edge) and go to: **http://localhost:3000**

The first time, you'll see an **Activation** page.

---

## STEP 4 — Get your Machine ID and send it to me
1. On the Activation page, you'll see **"Your Machine ID"** — a long code.
2. Click **Copy**.
3. Send me that code, plus tell me which plan you want (**Monthly** or **Permanent**).
4. Send your payment (GCash / Maya / cash) as we agreed.

---

## STEP 5 — Activate
1. I'll send you back a small **license file** (ends in `.key`).
2. On the Activation page, **drag that file onto the box** (or click the box and choose it).
3. The system unlocks automatically. 🎉

You're now licensed on this computer.

---

## STEP 6 — Log in and set up
1. Default login: **username `admin`, password `admin`**.
2. **Change the password immediately** — you'll see a red reminder banner. Click "Change password" and set your own.
3. Open **Settings** and fill in:
   - Your business name, GCash/Maya details
   - Your MikroTik router IP, username, password
4. Click **Test connection** to confirm it talks to your router.

> Tip: keep **Dry-run mode ON** (in Settings) the first time. It lets you see what the system
> *would* do to your router without actually changing anything. Turn it off once you're confident.

---

## Daily use
- Just double-click **`JeffNetPanel.bat`** and open **http://localhost:3000**.
- Want it reachable from your phone or another PC in the shop? Use your computer's local IP
  instead of localhost (e.g. `http://192.168.1.50:3000`). Ask me about secure remote access.

---

## Common questions

**The black window closed / panel won't open**
Make sure Node.js is installed (Step 1) and `JeffNetPanel.bat` is in the same folder as the
other files. Double-click it again and keep the black window open.

**"This license is for a different computer"**
Your license is locked to one PC. If you changed computers or major hardware, send me your new
Machine ID and I'll re-issue.

**I forgot my admin password**
Message me — I can help you reset it safely.

**Is my data safe?**
Yes. Everything stays on your computer. It has login protection, staff roles, and keeps backups
you can download from Settings.

---

## Need help?
Message me anytime:
- 📱 Phone/SMS: 09760591988
- 💬 Messenger: https://www.facebook.com/messages/t/100002429183896/
- ✉ Email: strikers.jeff@gmail.com

— JEFF NETWORK SERVICE
