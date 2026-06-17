// lib/smsparse.js — detect & parse GCash/Maya payment-confirmation SMS.
// Zero-dependency, pure functions for unit testing.

// Returns { isPayment, provider, amount, reference, sender } from a received SMS.
// Works on the common GCash / Maya "you received" formats; tolerant of variants.
export function parsePaymentSms(from, body) {
  const f = String(from || "");
  const text = String(body || "");
  const low = text.toLowerCase();

  // provider hint from the sender id (GCash/Maya texts come from a name, not a number)
  let provider = null;
  if (/gcash/i.test(f) || /gcash/i.test(text)) provider = "gcash";
  else if (/maya|paymaya/i.test(f) || /maya|paymaya/i.test(text)) provider = "maya";

  const mentionsReceived = /\breceived\b/.test(low) || /\bnatanggap\b/.test(low);
  // amount: "PHP 500.00", "P500.00", "₱500.00", "PHP1,234.56"
  const amtM = text.match(/(?:php|p|\u20b1)\s?([0-9][0-9,]*\.?\d{0,2})/i);
  // reference: "Ref. No. 1234567890123", "Ref No 123456", "Reference: 1234567"
  const refM = text.match(/ref(?:erence)?\.?\s*(?:no\.?|number)?\s*[:#]?\s*([0-9]{6,})/i);

  const amount = amtM ? Number(amtM[1].replace(/,/g, "")) : 0;
  const reference = refM ? refM[1] : "";

  const isPayment = !!provider && mentionsReceived && (amount > 0 || !!reference);
  return { isPayment, provider, amount, reference, sender: f };
}
