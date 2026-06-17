// lib/proofcheck.js — practical anti-fraud screening for payment proofs.
// IMPORTANT: software cannot prove a GCash screenshot is real. This only FLAGS
// suspicious submissions to speed staff review; a human still approves.
// Zero-dependency. No OCR model (we can't run one offline reliably); instead we
// validate the typed reference, block reused references, and sanity-check the
// uploaded image bytes (format + rough size) to catch obviously-wrong uploads.

// GCash refs are typically 13 digits; Maya similar. Bank refs vary.
export function normalizeRef(ref) {
  return String(ref || "").replace(/\s+/g, "").toUpperCase();
}

// Inspect a data: URL: returns { kind, bytes, looksLikeImage }.
export function inspectImage(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return { kind: "none", bytes: 0, looksLikeImage: false };
  const mime = m[1].toLowerCase();
  const b64 = m[2] || "";
  const bytes = Math.floor((b64.length * 3) / 4);
  // magic-byte check on the first few decoded bytes
  let head = "";
  try { head = Buffer.from(b64.slice(0, 16), "base64").toString("latin1"); } catch {}
  const isPng = head.charCodeAt(1) === 0x50 && head.charCodeAt(2) === 0x4e; // .PNG
  const isJpg = head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8; // JPEG
  const looksLikeImage = /^image\//.test(mime) && (isPng || isJpg || /webp|gif/.test(mime));
  return { kind: mime, bytes, looksLikeImage };
}

// Screen a proof. Returns { flags: [...], severity, reusedOf } — does NOT block
// (except optionally on reuse, decided by the caller).
// args:
//   reference   : what the customer typed
//   image       : data URL
//   invoiceAmt  : the bill amount (for context; we can't read the image amount
//                 without OCR, so this is informational unless caller adds it)
//   priorRefs   : array of { id, reference, customer_id } already in the system
//   customerId  : this submitter
export function screenProof({ reference, image, priorRefs = [], customerId = null }) {
  const flags = [];
  const ref = normalizeRef(reference);

  // 1) reference presence + shape
  if (!ref) {
    flags.push({ code: "no-ref", level: "warn", msg: "No reference number provided." });
  } else if (!/^[0-9]{6,}$/.test(ref) && !/^[A-Z0-9]{6,}$/.test(ref)) {
    flags.push({ code: "odd-ref", level: "warn", msg: "Reference does not look like a GCash/Maya/bank reference." });
  }

  // 2) duplicate / reused reference (strongest signal of fraud)
  let reusedOf = null;
  if (ref) {
    const dup = priorRefs.find((p) => normalizeRef(p.reference) === ref);
    if (dup) {
      reusedOf = dup.id;
      const sameCust = dup.customer_id != null && customerId != null && dup.customer_id === customerId;
      flags.push({
        code: "dup-ref", level: "block",
        msg: sameCust
          ? "This reference number was already submitted by this customer."
          : "This reference number was already used by another submission — possible reused receipt.",
      });
    }
  }

  // 3) image sanity
  const img = inspectImage(image);
  if (!img.looksLikeImage) {
    flags.push({ code: "bad-image", level: "warn", msg: "Attachment does not look like a normal photo/screenshot." });
  } else if (img.bytes > 0 && img.bytes < 8 * 1024) {
    flags.push({ code: "tiny-image", level: "warn", msg: "Image is unusually small — may be cropped or not a real receipt." });
  }

  const hasBlock = flags.some((f) => f.level === "block");
  const hasWarn = flags.some((f) => f.level === "warn");
  return { flags, reusedOf, severity: hasBlock ? "block" : hasWarn ? "warn" : "ok", ref };
}
