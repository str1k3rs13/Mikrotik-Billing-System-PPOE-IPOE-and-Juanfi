// lib/smsparse.js — detect & parse GCash/Maya payment-confirmation SMS.
// Zero-dependency, pure functions for unit testing.

// Returns { isPayment, provider, amount, reference, sender } from a received SMS.
// Works on common GCash / Maya formats; tolerant of wording variants.
export function parsePaymentSms(from, body) {
  const f = String(from || "");
  const text = String(body || "");
  const low = text.toLowerCase();
  const fLow = f.toLowerCase();

  // provider hint from the sender id OR the body. GCash/Maya texts usually come from a name.
  let provider = null;
  if (/gcash/i.test(f) || /gcash/i.test(text)) provider = "gcash";
  else if (/maya|paymaya/i.test(f) || /maya|paymaya/i.test(text)) provider = "maya";

  // words that indicate INCOMING money (English + Tagalog + common GCash/Maya phrasings)
  const credited = /\breceived\b/.test(low) || /\bnatanggap\b/.test(low) ||
                   /\bcredited\b/.test(low) || /\bcash\s*in\b/.test(low) ||
                   /\bpadala\b/.test(low) || /\byou got\b/.test(low) ||
                   /\bsent you\b/.test(low);
  // words that indicate OUTGOING money — these must NOT be counted as income
  const outgoing = /\byou sent\b/.test(low) || /\bnagpadala\b/.test(low) ||
                   /\bdebited\b/.test(low) || /\bpayment to\b/.test(low) ||
                   /\bsent to\b/.test(low) || /\bbnh\b/.test(low);

  // amount: "PHP 500.00", "P500.00", "₱500.00", "PHP1,234.56", "Php 1000"
  const amtM = text.match(/(?:php|p|\u20b1)\s?([0-9][0-9,]*\.?\d{0,2})/i);
  // reference: "Ref. No. 1234567890123", "Ref No 123456", "Reference: 1234567", "Ref 1234567"
  const refM = text.match(/ref(?:erence)?\.?\s*(?:no\.?|number)?\s*[:#]?\s*([0-9]{6,})/i);

  const amount = amtM ? Number(amtM[1].replace(/,/g, "")) : 0;
  const reference = refM ? refM[1] : "";

  // It's an incoming payment if:
  //  - it's NOT an outgoing transaction, AND
  //  - it has an amount or a reference, AND
  //  - it either names a provider OR clearly says money came in (credited/received/cash in).
  //    (If the sender is just a number with no provider word, we still accept it when the
  //     "credited" wording + an amount/ref are present — many SIMs show GCash as a shortcode.)
  const looksIncoming = credited && !outgoing;
  const hasMoney = amount > 0 || !!reference;
  const isPayment = hasMoney && !outgoing && (
    (!!provider && (credited || /\breceived\b/.test(low))) ||
    looksIncoming
  );
  // default provider label if we detected income but no explicit name
  const prov = provider || (isPayment ? "gcash" : null);

  return { isPayment, provider: prov, amount, reference, sender: f };
}
