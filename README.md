# JEFF NETWORK SERVICE — System Features & Functions

A complete list of what the system does. Use it to answer customer questions, write product
descriptions, or remind yourself of everything it includes.

---

## 1. Customer & Billing Management
- Full subscriber database — name, contact, address, area, connection type, plan, status.
- Connection types: **PPPoE**, **IPoE** (MAC-bound), and **Hotspot**.
- Speed/validity plans you define (e.g. 50 Mbps / 30 days).
- Record payments — **cash, GCash, Maya** — with full payment history per customer.
- Automatic **expiry tracking** and **due-date reminders** (dunning) before a subscriber lapses.
- **Auto-suspend** overdue accounts and **auto-reconnect** when they pay (optional, you control it).
- Credit / advance balance handling.

## 2. MikroTik Router Automation (RouterOS v7)
- Connects directly to your MikroTik (hEX and similar).
- **Provision** new PPPoE and IPoE subscribers automatically.
- **Suspend / reconnect** subscribers by managing an address-list (safe — it never touches your
  NAT or proxy rules).
- Set per-subscriber **speed limits** (rate plans).
- Auto-generate PPPoE usernames (clientname@businessname) and strong passwords.
- Suggest the next free IPoE IP on a VLAN.
- **Dry-run mode** — preview every router command before it runs, so you can go live safely.

## 3. Piso-WiFi / Vendo (JuanFi)
- Register and monitor your JuanFi NodeMCU vendo machines.
- Track **coin income** per vendo machine.
- See vendo income alongside subscriber income in reports.
- Offline-vendo alerts (know when a machine stops reporting).

## 4. Public Application Form (/apply)
- A web form your future customers fill out to apply for internet service.
- Applications flow straight into your **Job Orders** queue.
- Captures name, contact, address, and area.

## 5. Job Orders (installations)
- Every application becomes a job order you can track.
- **Assign a technician** from your team.
- Release equipment, mark installed, create the subscriber account on approval.
- **Alerts** for new applications, jobs waiting too long, payments to verify, and installs with
  no account yet — shown as a banner and a sidebar badge.

## 6. Tech Team
- Manage your field crew — name, rank, phone, and the **areas** they cover.
- **Live availability** — a technician shows "On a job" automatically when assigned, "Available"
  when free.
- See each tech's active jobs and completed installs.

## 7. Inventory & Hardware
- Track stock items and **serialized units** (routers, ONUs) by **serial number and MAC**.
- Record **cost price and sell price** — the system computes your **profit margin** automatically.
- **Sell hardware** to a client with one click (records revenue, cost, and margin).
- **Trace any unit** by MAC or serial — see its full history (stocked → installed → pulled out →
  replaced).
- **Pull out** a unit from a client and **replace** it with a spare (e.g. defective router swap).
- Foolproof accounting mode so hardware cost is never double-counted.
- Low-stock alerts.

## 8. Expenses
- Log business expenses by category (electricity, fuel, salary, rent, bandwidth, etc.).
- Feeds into your cash-flow and profit reports.

## 9. Reports & Cash Flow
- **Cash-flow view** — money in (subscriptions + install fees + hardware margin + vendo) vs
  money out (expenses), with the net for any month.
- **Printable monthly financial report** — every income stream separated, with totals and net
  profit/loss. Print or save as PDF.
- Revenue by payment method and by connection type.
- Monthly performance trends and key business numbers.

## 10. Helpdesk & SMS
- Basic helpdesk / customer support tracking.
- SMS integration for notices and reminders (with a compatible gateway).
- Telegram integration for approvals/alerts (optional).

## 11. Security
- **Login protection** with strong password hashing (scrypt + salt, timing-safe checks).
- **Brute-force protection** — locks out after repeated failed logins.
- **Staff roles** — admin, cashier, technician — each sees only what they should.
- **Security headers** and HttpOnly session cookies.
- **Audit log** — who did what, and when.
- **Default-password warning** until you set your own.

## 12. Data & Reliability
- All data stored locally on your computer (private, no cloud dependency).
- **Backup & restore** from Settings.
- **Data maintenance** — archive or clear old logs to keep it fast.
- Runs as a single program; updates by replacing the files.

## 13. Access & Convenience
- Clean web dashboard — works on desktop, scales up on big monitors, and fits mobile phones.
- **Installable as an app** (PWA) on phone/desktop.
- Optional **secure remote access** via Cloudflare Tunnel (reach it from anywhere with HTTPS).
- Dark and light themes.

## 14. Licensing (for you, the vendor)
- Each copy is **machine-locked** — one license runs on one computer.
- **Offline activation** — no license server needed; you issue signed license files.
- **Perpetual or subscription (monthly/yearly)** — you choose per customer.
- Simple **drag-and-drop activation** for customers.
- Your **keygen tool** issues licenses in seconds.

---

CONTACT INFORMATION TO GET LICENCSE KEY.
https://tech.jeff-network.com/
## In one sentence
**An all-in-one, offline, secure management system that turns a small MikroTik / piso-WiFi
operation into a professionally-run internet business — billing, automation, inventory,
reporting, and customer management in a single panel on your own computer.**
