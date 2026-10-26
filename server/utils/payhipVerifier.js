/**
 * payhipVerifier.js — Payhip Webhook Signature Verification & Product Mapper
 *
 * Implements Payhip's official webhook verification:
 * - Signature is SHA-256 of the Payhip API key: hash('sha256', apiKey)
 * - Safe constant-time comparison to prevent timing attacks
 * - Mapping of Payhip product IDs, product keys, and payloads to internal book models & access tiers
 * - Database-backed edition lookup via Supabase ebooks.access_options
 */

const crypto = require("crypto");
try {
  require("dotenv").config();
} catch {}

// Primary book IDs in the system
const DEFAULT_BOOK_ID = "04b84648-3609-4b31-9ded-2486bacf1e74"; // Marketing Reclassified
const ADAPTIVE_VALUE_BOOK_ID = "b4492051-cce5-4213-974b-72c74da19196";
const VALUE_DRIFT_BOOK_ID = "ba9acc66-a824-47c4-a4aa-5abb1a153437";

/**
 * Verify Payhip webhook payload authenticity
 * @param {Object} payload - Parsed JSON body received from Payhip
 * @param {Object} [headers] - Optional headers for additional checks
 */
function verifyPayhipSignature(payload, headers = {}) {
  const apiKey = (process.env.PAYHIP_API_KEY || "").trim();

  if (!apiKey || apiKey.includes("placeholder")) {
    console.warn("[Payhip Webhook] PAYHIP_API_KEY is not configured in server environment.");
    return false;
  }

  // Payhip transmits the signature in payload.signature (or x-payhip-signature header if present)
  const incomingSig = (payload && payload.signature) || headers["x-payhip-signature"] || headers["signature"];
  if (!incomingSig || typeof incomingSig !== "string") {
    console.warn("[Payhip Webhook] Missing signature in incoming payload.");
    return false;
  }

  const expectedSig = crypto.createHash("sha256").update(apiKey).digest("hex");

  try {
    const incomingBuf = Buffer.from(incomingSig, "utf8");
    const expectedBuf = Buffer.from(expectedSig, "utf8");
    if (incomingBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(incomingBuf, expectedBuf);
  } catch (err) {
    console.error("[Payhip Webhook] Signature comparison error:", err.message);
    return false;
  }
}

/**
 * Synchronous mapper: Checks environment overrides and fallback heuristics
 */
function mapPayhipProductToBook(item = {}, fullPayload = {}) {
  // Check for custom JSON mapping in environment variable
  if (process.env.PAYHIP_MAPPING_JSON) {
    try {
      const customMap = JSON.parse(process.env.PAYHIP_MAPPING_JSON);
      const key = item.product_id || item.product_key || fullPayload.product_id;
      if (key && customMap[key]) {
        return {
          productId: customMap[key].productId || DEFAULT_BOOK_ID,
          accessTier: customMap[key].accessTier || "companion",
          editionType: customMap[key].accessTier || "companion",
          title: customMap[key].title || item.product_name || "Digital Publication",
          isUpgrade: Boolean(customMap[key].isUpgrade),
          canReadOnline: customMap[key].canReadOnline !== false,
          canDownload: customMap[key].accessTier !== "online",
        };
      }
    } catch (e) {
      console.warn("[Payhip] Custom mapping JSON parse error:", e.message);
    }
  }

  const prodId = String(item.product_id || fullPayload.product_id || "").trim();
  const prodKey = String(item.product_key || fullPayload.product_key || "").trim();
  const link = String(item.product_link || fullPayload.product_link || fullPayload.product_url || fullPayload.link || "").trim();
  const linkKeyMatch = link.match(/\/b\/([a-zA-Z0-9]+)/i);
  const linkKey = linkKeyMatch ? linkKeyMatch[1] : "";
  const name = String(item.product_name || fullPayload.product_name || "").toLowerCase();
  const priceCents = Number(item.price || fullPayload.price || 0);

  const matchKey = (target) => {
    if (!target) return false;
    const clean = String(target).trim();
    return clean === prodId || clean === prodKey || (linkKey && clean === linkKey);
  };

  // Check specific environment overrides for product IDs
  const envOnlineId = String(process.env.PAYHIP_ONLINE_PRODUCT_ID || "").trim();
  const envCompanionId = String(process.env.PAYHIP_COMPANION_PRODUCT_ID || "").trim();
  const envUpgradeId = String(process.env.PAYHIP_UPGRADE_PRODUCT_ID || "").trim();

  // 1. Direct shortcode / configured match for Online Reading Edition ($20.00 / Nr3Tp)
  if (matchKey("Nr3Tp") || (envOnlineId && matchKey(envOnlineId))) {
    return {
      productId: DEFAULT_BOOK_ID,
      accessTier: "online",
      editionType: "online",
      title: "Marketing Reclassified — Online Reading Edition",
      isUpgrade: false,
      canReadOnline: true,
      canDownload: false,
    };
  }

  // 2. Direct shortcode / configured match for Digital Companion Edition ($49.99 / 2H0Wr)
  if (matchKey("2H0Wr") || (envCompanionId && matchKey(envCompanionId))) {
    return {
      productId: DEFAULT_BOOK_ID,
      accessTier: "companion",
      editionType: "companion",
      title: "Marketing Reclassified — Digital Companion Edition",
      isUpgrade: false,
      canReadOnline: true,
      canDownload: true,
    };
  }

  // 3. Direct shortcode / configured match for Upgrade Edition ($29.99 / IpN7k)
  if (matchKey("IpN7k") || (envUpgradeId && matchKey(envUpgradeId))) {
    return {
      productId: DEFAULT_BOOK_ID,
      accessTier: "companion",
      editionType: "companion",
      title: "Marketing Reclassified — Digital Companion Edition (Upgrade)",
      isUpgrade: true,
      canReadOnline: true,
      canDownload: true,
    };
  }

  // 1. Adaptive Value Framework
  if (name.includes("adaptive value") || prodId === ADAPTIVE_VALUE_BOOK_ID || prodKey === "avf") {
    return {
      productId: ADAPTIVE_VALUE_BOOK_ID,
      accessTier: "companion",
      editionType: "companion",
      title: "The adaptive value framework",
      isUpgrade: false,
      canReadOnline: true,
      canDownload: true,
    };
  }

  // 2. Value Drift Index
  if (name.includes("value drift") || prodId === VALUE_DRIFT_BOOK_ID || prodKey === "vdi") {
    return {
      productId: VALUE_DRIFT_BOOK_ID,
      accessTier: "companion",
      editionType: "companion",
      title: "The value drift index",
      isUpgrade: false,
      canReadOnline: true,
      canDownload: true,
    };
  }

  // 3. Marketing Reclassified Editions
  // Online Reading Edition ($20.00 / 2000 cents)
  if (
    name.includes("online") ||
    item.access_type === "online" ||
    (priceCents >= 1800 && priceCents <= 2500 && !name.includes("companion"))
  ) {
    return {
      productId: DEFAULT_BOOK_ID,
      accessTier: "online",
      editionType: "online",
      title: "Marketing Reclassified — Online Reading Edition",
      isUpgrade: false,
      canReadOnline: true,
      canDownload: false,
    };
  }

  // Upgrade to Digital Companion Edition ($29.99 / ~2999 cents)
  if (
    name.includes("upgrade") ||
    item.used_upgrade_discount ||
    (priceCents >= 2700 && priceCents <= 3200 && name.includes("companion"))
  ) {
    return {
      productId: DEFAULT_BOOK_ID,
      accessTier: "companion",
      editionType: "companion",
      title: "Marketing Reclassified — Digital Companion Edition (Upgrade)",
      isUpgrade: true,
      canReadOnline: true,
      canDownload: true,
    };
  }

  // Default to Digital Companion Edition (Full download & online reader)
  return {
    productId: DEFAULT_BOOK_ID,
    accessTier: "companion",
    editionType: "companion",
    title: item.product_name || "Marketing Reclassified — Digital Companion Edition",
    isUpgrade: false,
    canReadOnline: true,
    canDownload: true,
  };
}

/**
 * Asynchronous mapper: checks live Supabase ebooks.access_options for explicit edition mapping
 */
async function resolvePayhipProductMapping(item = {}, fullPayload = {}) {
  const prodId = String(item.product_id || fullPayload.product_id || "").trim();
  const prodKey = String(item.product_key || fullPayload.product_key || "").trim();
  const link = String(item.product_link || fullPayload.product_link || fullPayload.product_url || fullPayload.link || "").trim();
  const linkKeyMatch = link.match(/\/b\/([a-zA-Z0-9]+)/i);
  const linkKey = linkKeyMatch ? linkKeyMatch[1] : "";

  const matchKey = (target) => {
    if (!target) return false;
    const clean = String(target).trim();
    return clean === prodId || clean === prodKey || (linkKey && clean === linkKey);
  };

  if (prodId || prodKey || linkKey) {
    try {
      let supabaseClient;
      try {
        supabaseClient = require("../config/supabaseClient");
      } catch {
        supabaseClient = require("./supabase");
      }

      if (supabaseClient && supabaseClient.from) {
        const { data: ebooks, error } = await supabaseClient
          .from("ebooks")
          .select("id, title, file_path, access_options");

        if (!error && Array.isArray(ebooks)) {
          for (const book of ebooks) {
            const opts = Array.isArray(book.access_options)
              ? book.access_options
              : typeof book.access_options === "string"
              ? JSON.parse(book.access_options || "[]")
              : [];

            for (const opt of opts) {
              const optPayhipId = String(opt.payhip_product_id || "").trim();
              const optUpgradeId = String(opt.upgrade_payhip_product_id || "").trim();

              // Explicit edition match
              if (optPayhipId && matchKey(optPayhipId)) {
                const isOnline = opt.access_type === "online" || opt.can_download === false || optPayhipId === "Nr3Tp";
                return {
                  productId: book.id,
                  accessTier: isOnline ? "online" : "companion",
                  editionType: opt.access_type || (isOnline ? "online" : "companion"),
                  title: `${book.title} — ${opt.name || (isOnline ? "Online Reading Edition" : "Digital Companion Edition")}`,
                  isUpgrade: false,
                  canReadOnline: true,
                  canDownload: !isOnline,
                  filePath: opt.download_file_path || opt.online_file_path || book.file_path,
                };
              }

              // Explicit upgrade match
              if (optUpgradeId && matchKey(optUpgradeId)) {
                return {
                  productId: book.id,
                  accessTier: "companion",
                  editionType: "companion",
                  title: `${book.title} — ${opt.name || "Digital Companion"} (Upgrade)`,
                  isUpgrade: true,
                  canReadOnline: true,
                  canDownload: true,
                  filePath: opt.download_file_path || book.file_path,
                };
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn("[resolvePayhipProductMapping] DB lookup notice:", e.message);
    }
  }

  // Fallback to sync mapper
  return mapPayhipProductToBook(item, fullPayload);
}

module.exports = {
  verifyPayhipSignature,
  mapPayhipProductToBook,
  resolvePayhipProductMapping,
  DEFAULT_BOOK_ID,
  ADAPTIVE_VALUE_BOOK_ID,
  VALUE_DRIFT_BOOK_ID,
};
