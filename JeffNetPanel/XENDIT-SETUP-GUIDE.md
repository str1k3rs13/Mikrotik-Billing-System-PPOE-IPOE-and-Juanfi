# Xendit Setup Guide

A step-by-step checklist to connect Xendit as your online payment gateway, so customers can pay their bills with GCash, cards, and e-wallets — and get auto-reconnected the moment they pay.

This works exactly like the PayMongo setup. You can keep both configured and switch between them anytime with the dropdown in Settings.

---

## Before you start

You'll need:
- A **Xendit account** (sign up at https://www.xendit.co — choose Philippines).
- Your panel **reachable from the internet** for live payments (port-forward, or a tunnel like Cloudflare Tunnel — see your existing HTTPS guide). For *testing* you can use Xendit's test mode without a public URL, but the webhook (auto-reconnect) only fires if Xendit can reach your panel.
- About 15 minutes.

---

## Part 1 — Get your Xendit keys

1. Log in to the **Xendit Dashboard** (https://dashboard.xendit.co).
2. Make sure you're in **Test Mode** first (toggle is usually top-right or in the left menu). Use test keys until everything works, then switch to live.
3. Go to **Settings → API Keys** (or **Developers → API Keys**).
4. Click **Generate Secret Key** (or **Create API Key**).
   - Give it write permission for **Invoices / Money-in**.
   - Copy the key. It looks like `xnd_development_xxxxxxxxxxxx` (test) or `xnd_production_xxxxxxxxxxxx` (live).
   - **Save it somewhere safe now** — Xendit only shows the full key once.

---

## Part 2 — Get your Callback Verification Token

This token is how your panel confirms a webhook really came from Xendit (not a fake).

1. In the Xendit Dashboard, go to **Settings → Webhooks** (or **Developers → Webhooks**).
2. Look for **Callback Verification Token** near the top of the page.
3. Copy it. (It's a long random string.)

---

## Part 3 — Enter the keys in your panel

1. Open your admin panel → **Settings**.
2. Scroll to **Online payments — gateway**.
3. Set the **gateway dropdown** to **Xendit (GCash / card / e-wallet)**.
4. Under **Xendit keys**, fill in:
   - **Secret API key** → paste your `xnd_development_…` (or `xnd_production_…`) key.
   - **Webhook callback verification token** → paste the token from Part 2.
5. Click **Save settings**.
6. Note the **Xendit webhook URL** shown right below the fields — it looks like:
   `https://your-panel-address/api/billing/xendit/webhook`
   Copy it; you'll need it in Part 4.

(Both keys are stored on the panel and never shown back in the browser — after saving they display as `***`.)

---

## Part 4 — Tell Xendit where to send payment confirmations

1. Back in the Xendit Dashboard → **Settings → Webhooks**.
2. Find the **Invoices** section (sometimes called "Invoices paid" or "Money-in / Invoice").
3. In the **Invoice paid** callback URL field, paste your webhook URL from Part 3:
   `https://your-panel-address/api/billing/xendit/webhook`
4. Save / enable it.
5. If Xendit offers a **"Test"** button for the webhook, click it — your panel should respond `200 OK`.

> If the test fails, your panel isn't reachable from the internet yet. Set up your tunnel/port-forward first (see your HTTPS / Cloudflare guide), then retry.

---

## Part 5 — Do a test payment

1. Make sure you're still in **Test Mode** in Xendit, using your test key.
2. In the panel, pick any customer with an unpaid invoice and **create a payment link** (or open the customer pay page at `your-panel-address/pay`).
3. Open the link — it should take you to a **Xendit hosted checkout** page.
4. Pay using Xendit's **test payment method** (test GCash / test card — Xendit's test-mode checkout provides simulated options).
5. Check the panel:
   - The invoice should flip to **paid** within a few seconds.
   - If the customer was suspended, they should be **auto-reconnected** on the router.
   - Check **Audit log** — you should see `invoice-paid-online` and (if applicable) `auto-reconnect`.

**Confirm the amount is correct** on the checkout page (e.g. a ₱500 invoice shows ₱500, not ₱5.00 or ₱50,000). Xendit uses whole-peso amounts and the panel is set for that — but always eyeball the first real test.

---

## Part 6 — Go live

Once test payments work end to end:

1. In Xendit Dashboard, switch to **Live Mode**.
2. Generate a **live** Secret API key (`xnd_production_…`) and copy the **live** Callback Verification Token.
3. In the panel Settings, replace the test key + token with the **live** ones. Save.
4. In Xendit's **Live Mode** webhooks, set the same invoice callback URL again (live and test webhook settings are separate).
5. Do **one small real payment** (e.g. ₱20 to yourself) to confirm live mode works, then refund it from the Xendit dashboard if you like.

---

## Switching between PayMongo and Xendit

- The **gateway dropdown** in Settings controls which one is active. Only the selected gateway is used at checkout.
- You can keep both sets of keys saved and flip between them anytime — no need to re-enter keys when you switch.
- Each gateway has its **own webhook URL** (`…/paymongo/webhook` vs `…/xendit/webhook`). Make sure the active gateway's webhook is the one configured in that provider's dashboard.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Xendit secret key not set" | Key field empty or gateway not switched | Re-check Part 1 & 3; click Save |
| Checkout opens but payment never marks invoice paid | Webhook not configured or panel not reachable | Re-do Part 4; confirm your panel is internet-reachable |
| Webhook test fails in Xendit | Panel not public, or wrong URL | Set up tunnel/port-forward; copy the exact URL from Settings |
| "xendit: HTTP 401/403" when creating a link | Wrong or expired key, or test key used in live mode | Regenerate the key; match test/live mode |
| Amount looks wrong on checkout | — | Tell your developer; panel sends whole-peso PHP amounts |
| Customer paid but not reconnected | Webhook reached panel but router was unreachable | Check Audit log for `auto-reconnect-failed`; fix router connectivity, then re-enable manually |

---

## Quick reference

- **Gateway dropdown:** Settings → Online payments — gateway → *Xendit*
- **Keys needed:** Secret API key + Callback Verification Token
- **Webhook URL:** `https://your-panel-address/api/billing/xendit/webhook`
- **Test first**, then go live with production keys.
- **Both PayMongo and Xendit** can stay configured — switch anytime.
