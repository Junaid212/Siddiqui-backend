/**
 * discountController.js — Discount/Coupon Code Management
 *
 * Validates discount codes against:
 * 1. Admin-managed coupons (from coupons.json synced by admin panel)
 * 2. Admin server validation API (port 5001)
 * 3. Supabase `coupons` table
 * 4. Static fallback codes
 */

const fs = require("fs");
const path = require("path");
const supabase = require("../config/supabaseClient");
require("dotenv").config();

// Candidate paths to shared admin coupons file
const CANDIDATE_PATHS = [
  "d:/Bright Media WORK/siddique-admin/server/src/data/coupons.json",
  path.resolve(__dirname, "../../../siddique-admin/server/src/data/coupons.json"),
  path.resolve(__dirname, "../../siddique-admin/server/src/data/coupons.json"),
  path.resolve(__dirname, "../data/coupons.json"),
];

/* Static fallback codes */
const STATIC_DISCOUNT_CODES = [
  { code: "LAUNCH20",  type: "percentage", value: 20,  description: "20% off — Launch offer",  min_order_amount: 0,   active: true },
  { code: "WELCOME10", type: "percentage", value: 10,  description: "10% welcome discount",     min_order_amount: 0,   active: true },
  { code: "READER15",  type: "percentage", value: 15,  description: "15% reader discount",      min_order_amount: 0,   active: true },
  { code: "BOOKS25",   type: "percentage", value: 25,  description: "25% off all publications", min_order_amount: 0,   active: true },
];

/**
 * Load admin-created coupons from disk if available
 */
function getAdminCoupons() {
  for (const p of CANDIDATE_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) return list;
      }
    } catch (_) {}
  }
  return [];
}

/**
 * POST /api/payment/validate-discount
 * Body: { code: string, subtotal: number }
 */
exports.validateDiscount = async (req, res) => {
  const code = (req.body.code || "").trim().toUpperCase();
  const subtotal = Number(req.body.subtotal) || 0;

  if (!code) {
    return res.status(400).json({ valid: false, error: "Discount code is required." });
  }

  try {
    let discount = null;

    // 1. Check admin-managed coupons from disk
    const adminCoupons = getAdminCoupons();
    const foundAdmin = adminCoupons.find(c => (c.code || "").toUpperCase() === code);
    if (foundAdmin) {
      discount = {
        code: foundAdmin.code,
        type: foundAdmin.discount_type || "percentage",
        value: Number(foundAdmin.discount_percentage),
        description: foundAdmin.description || `${foundAdmin.discount_percentage}% off`,
        min_order_amount: foundAdmin.min_order_amount || 0,
        max_uses: foundAdmin.max_uses,
        uses_count: foundAdmin.times_used || 0,
        active: foundAdmin.is_active !== false,
        expires_at: foundAdmin.expires_at,
      };
    }

    // 2. Query admin API (port 5001) if not found locally
    if (!discount) {
      try {
        const adminApiRes = await fetch("http://localhost:5001/api/public/coupons/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, subtotal }),
        });
        if (adminApiRes.ok) {
          const apiData = await adminApiRes.json();
          if (apiData && apiData.valid && apiData.discount) {
            discount = {
              code: apiData.discount.code,
              type: apiData.discount.type || "percentage",
              value: Number(apiData.discount.value || apiData.discount.discount_percentage),
              description: apiData.discount.description,
              active: true,
            };
          }
        }
      } catch (_) {}
    }

    // 3. Try Supabase database
    if (!discount && supabase) {
      try {
        const { data: dbCoupon } = await supabase
          .from("coupons")
          .select("*")
          .ilike("code", code)
          .maybeSingle();

        if (dbCoupon) {
          discount = {
            code: dbCoupon.code,
            type: dbCoupon.discount_type || "percentage",
            value: Number(dbCoupon.discount_percentage),
            description: dbCoupon.description,
            min_order_amount: dbCoupon.min_order_amount,
            max_uses: dbCoupon.max_uses,
            uses_count: dbCoupon.times_used || 0,
            active: dbCoupon.is_active !== false,
            expires_at: dbCoupon.expires_at,
          };
        }
      } catch (_) {}
    }

    // 4. Fall back to static codes
    if (!discount) {
      discount = STATIC_DISCOUNT_CODES.find(
        (d) => d.code.toUpperCase() === code
      );
    }

    if (!discount) {
      return res.status(404).json({
        valid: false,
        error: `Coupon code '${code}' is invalid. Please check and try again.`,
      });
    }

    // Validation checks
    if (discount.active === false) {
      return res.status(400).json({ valid: false, error: `Coupon code '${code}' is currently inactive.` });
    }
    if (discount.expires_at && new Date() > new Date(discount.expires_at)) {
      return res.status(400).json({ valid: false, error: `Coupon code '${code}' has expired.` });
    }
    if (discount.max_uses && Number(discount.uses_count || 0) >= Number(discount.max_uses)) {
      return res.status(400).json({ valid: false, error: `Coupon code '${code}' has reached its usage limit.` });
    }
    if (discount.min_order_amount && subtotal > 0 && subtotal < Number(discount.min_order_amount)) {
      return res.status(400).json({
        valid: false,
        error: `Coupon code '${code}' requires a minimum order of AED ${discount.min_order_amount}.`,
      });
    }

    // Calculate discount amount based on percentage
    let discountAmount = 0;
    if (discount.type === "percentage") {
      discountAmount = Math.min(subtotal, (subtotal * Number(discount.value)) / 100);
    } else if (discount.type === "fixed") {
      discountAmount = Math.min(subtotal, Number(discount.value));
    }

    return res.json({
      valid: true,
      discount: {
        code: discount.code,
        type: discount.type,
        value: Number(discount.value),
        discount_percentage: Number(discount.value),
        description: discount.description,
        discountAmount: Math.round(discountAmount * 100) / 100,
        subtotalAfterDiscount: Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100),
      },
    });
  } catch (err) {
    console.error("[validateDiscount] Error:", err);
    return res.status(500).json({ valid: false, error: "Failed to validate coupon code." });
  }
};
