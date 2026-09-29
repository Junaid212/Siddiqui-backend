/**
 * cartController.js — Multi-item Cart Checkout + Customer Orders
 *
 * Endpoints:
 *   POST /api/payment/create-cart-checkout — Create Stripe session for multiple items
 *   GET  /api/payment/my-orders?email=...  — Customer order history
 */

const Stripe = require("stripe");
const crypto = require("crypto");
const supabase = require("../config/supabaseClient");
const { sendOrderConfirmationEmail } = require("../utils/orderEmail");
const { saveOrderMetadata, getOrderMetadata } = require("../utils/orderStore");
require("dotenv").config();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = new Stripe(stripeSecretKey);

/**
 * Helper to execute DB operations safely (skip unknown columns)
 */
async function executeWithSchemaFallback(operationFn, payload) {
  let currentPayload = { ...payload };
  while (true) {
    const res = await operationFn(currentPayload);
    if (!res.error) return res;
    const match =
      res.error.message?.match(/Could not find the '([^']+)' column/i) ||
      res.error.message?.match(/column ['""]?([a-zA-Z0-9_]+)['""]? does not exist/i);
    if (match && match[1] && Object.prototype.hasOwnProperty.call(currentPayload, match[1])) {
      const badCol = match[1];
      console.warn(`[Cart] Column '${badCol}' missing in schema, omitting.`);
      delete currentPayload[badCol];
      if (Object.keys(currentPayload).length === 0) return res;
      continue;
    }
    return res;
  }
}

/**
 * POST /api/payment/create-cart-checkout
 *
 * Body: {
 *   customerName, customerEmail, customerPhone?,
 *   userId?, lineItems: [{ productId, title, accessType, price, currency, quantity }],
 *   discountCode?, discountAmount?, currency
 * }
 */
exports.createCartCheckout = async (req, res) => {
  const {
    customerName = "Valued Customer",
    customerEmail,
    customerPhone,
    userId = null,
    lineItems = [],
    discountCode,
    discountAmount = 0,
    currency = "AED",
  } = req.body;

  // Validation
  if (!customerEmail || !customerEmail.trim()) {
    return res.status(400).json({ error: "Customer email is required." });
  }
  if (!lineItems || lineItems.length === 0) {
    return res.status(400).json({ error: "At least one item is required in the cart." });
  }

  // Stripe key check
  if (!stripeSecretKey || stripeSecretKey.includes("placeholder") || stripeSecretKey.includes("your")) {
    return res.status(500).json({
      error: "Payment gateway is not configured. Please contact support at info@siddiqui.digital.",
    });
  }

  try {
    const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";
    const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const orderId = crypto.randomUUID();
    const currencyStr = currency.toLowerCase();

    // Build Stripe line_items
    const stripeLineItems = lineItems.map((item) => ({
      price_data: {
        currency: (item.currency || currency).toLowerCase(),
        product_data: {
          name: item.title || "Digital Publication",
          description: item.accessLabel || (item.accessType === "online" ? "Online Reading Access" : "Downloadable PDF Edition"),
        },
        unit_amount: Math.round(Number(item.price) * 100),
      },
      quantity: Math.max(1, Number(item.quantity) || 1),
    }));

    // Apply discount as a coupon if applicable
    const sessionConfig = {
      payment_method_types: ["card"],
      customer_email: customerEmail.trim(),
      line_items: stripeLineItems,
      mode: "payment",
      metadata: {
        orderId,
        orderNumber,
        customerName: customerName.trim() || "Valued Customer",
        customerEmail: customerEmail.trim(),
        cartItemCount: String(lineItems.length),
        productIds: lineItems.map((i) => i.productId).join(","),
        discountCode: discountCode || "",
        discountAmount: String(discountAmount),
      },
      success_url: `${clientUrl}/order-success?session_id={CHECKOUT_SESSION_ID}&order_id=${orderId}`,
      cancel_url: `${clientUrl}/publications`,
    };

    // Add discount coupon if applicable
    if (discountCode && discountAmount > 0) {
      try {
        // Create a Stripe coupon dynamically
        const coupon = await stripe.coupons.create({
          amount_off: Math.round(discountAmount * 100),
          currency: currencyStr,
          name: `Code: ${discountCode}`,
          max_redemptions: 1,
          redeem_by: Math.floor(Date.now() / 1000) + 3600, // 1 hour validity
        });
        sessionConfig.discounts = [{ coupon: coupon.id }];
      } catch (couponErr) {
        // If coupon creation fails, continue without it — the discount was already shown to user
        console.warn("[createCartCheckout] Coupon creation failed (non-fatal):", couponErr.message);
      }
    }

    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionConfig);
    } catch (stripeErr) {
      console.error("[createCartCheckout] Stripe error:", stripeErr.message);
      return res.status(500).json({ error: `Stripe Checkout error: ${stripeErr.message}` });
    }

    // Record order with multi-item metadata
    const productSummary = lineItems.map((i) => i.title).join(", ");
    const totalAmount = lineItems.reduce((sum, i) => sum + Number(i.price) * (i.quantity || 1), 0) - discountAmount;

    const orderRecord = {
      id: orderId,
      user_id: userId,
      email: customerEmail.trim(),
      customer_name: customerName.trim() || "Valued Customer",
      book_name: lineItems.length === 1 ? lineItems[0].title : `${lineItems.length} items: ${productSummary.substring(0, 120)}`,
      product_id: lineItems.length === 1 ? lineItems[0].productId : null,
      order_number: orderNumber,
      stripe_session_id: session.id,
      amount: Math.max(0, totalAmount),
      currency: currency.toUpperCase(),
      status: "pending",
      download_limit: 3,
      download_expires_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    };

    saveOrderMetadata(orderId, {
      ...orderRecord,
      orderId,
      lineItems: JSON.stringify(lineItems),
      discountCode: discountCode || null,
      discountAmount,
    });

    await executeWithSchemaFallback(
      (payload) => supabase.from("orders").insert([payload]),
      orderRecord
    );

    return res.json({
      url: session.url,
      sessionId: session.id,
      orderNumber,
      orderId,
    });

  } catch (err) {
    console.error("[createCartCheckout] Unhandled error:", err);
    return res.status(500).json({ error: err.message || "Failed to create cart checkout session." });
  }
};

/**
 * GET /api/payment/my-orders?email=xxx
 * Returns all paid orders for a customer email.
 */
exports.getCustomerOrders = async (req, res) => {
  const email = (req.query.email || "").trim();

  if (!email) {
    return res.status(400).json({ error: "Email address is required." });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  try {
    const { data: orders, error } = await supabase
      .from("orders")
      .select("*")
      .ilike("email", email)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getCustomerOrders] Supabase error:", error.message);
      return res.status(500).json({ error: "Failed to retrieve order history." });
    }

    const enriched = (orders || []).map((order) => {
      const meta = getOrderMetadata(order.id) || {};
      return {
        id: order.id,
        order_number: order.order_number || meta.orderNumber || `ORD-${order.id?.substring(0, 8).toUpperCase()}`,
        book_name: order.book_name || meta.productName || "Digital Publication",
        product_id: order.product_id || meta.product_id || null,
        amount: Number(order.amount) || 0,
        currency: order.currency || "AED",
        status: order.status || "pending",
        email: order.email || email,
        stripe_session_id: order.stripe_session_id || null,
        download_token: order.download_token || order.stripe_session_id || order.id,
        download_count: Number(order.download_count) || 0,
        download_limit: Number(order.download_limit) || 3,
        download_expires_at: order.download_expires_at || null,
        created_at: order.created_at || null,
      };
    });

    return res.json({ orders: enriched, count: enriched.length });

  } catch (err) {
    console.error("[getCustomerOrders] Error:", err);
    return res.status(500).json({ error: "Failed to load order history." });
  }
};
