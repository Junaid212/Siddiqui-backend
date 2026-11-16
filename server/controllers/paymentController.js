const Stripe = require("stripe");
const crypto = require("crypto");
const supabase = require("../config/supabaseClient");
const { escapeLike } = require("../utils/requireCustomer");
const { signAccess, verifyAccess, TTL_SECONDS } = require("../utils/accessLinks");
const { checkCompanionDownload, checkReaderAccess, getCurrentCompanionPath, getCurrentFilePath } = require("../utils/entitlements");
const { sendOrderConfirmationEmail } = require("../utils/orderEmail");
const { ensureCustomerAccount } = require("../utils/customerAuth");
const { getProductFile, setProductFile } = require("../utils/productFileStore");
const { saveOrderMetadata, getOrderMetadata, findOrderMetadataByToken } = require("../utils/orderStore");
if (process.env.NODE_ENV !== "staging") {
  require("dotenv").config();
}

// Lazy Stripe client initialization: supports test credentials when provided, prevents crashes when missing
function getStripeClient() {
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key || key.includes("placeholder") || key.includes("your_stripe_secret")) {
    return null;
  }
  try {
    return new Stripe(key);
  } catch (err) {
    console.warn("[Stripe] Client initialization warning:", err.message);
    return null;
  }
}

// Verified digital product catalog fallback (real products only)
const DEFAULT_PRODUCTS = [
  {
    id: "04b84648-3609-4b31-9ded-2486bacf1e74",
    sku: "EBOOK-001",
    title: "Marketing Reclassified",
    author: "M. Q. Siddiqui",
    product_type: "ebook",
    short_description: "From transaction to human progress. The definitive strategic playbook for modern digital marketing and high-performance brand leadership.",
    description: "From transaction to human progress. Marketing Reclassified breaks down cutting-edge marketing frameworks, behavioral psychology, and sustainable growth engines to help entrepreneurs and brand leaders scale with clarity and precision.",
    price: 99.00,
    currency: "USD",
    format: "PDF",
    cover_image: "https://cneariiepqywvjpmznqn.supabase.co/storage/v1/object/public/product-covers/1788934311298-book1.webp",
    file_path: "ebooks/marketing-reclassified.pdf",
    active: true,
    download_limit: 3,
    download_expiry_hours: 72,
  },
  {
    id: "b4492051-cce5-4213-974b-72c74da19196",
    sku: "EBOOK-002",
    title: "The adaptive value framework",
    author: "M. Q. Siddiqui",
    product_type: "ebook",
    short_description: "A practical approach to creating sustainable value in a changing world.",
    description: "A practical approach to creating sustainable value in a changing world.",
    price: 49.00,
    currency: "USD",
    format: "PDF",
    cover_image: "https://cneariiepqywvjpmznqn.supabase.co/storage/v1/object/public/product-covers/1788934505865-book3.webp",
    file_path: null,
    active: true,
    download_limit: 3,
    download_expiry_hours: 72,
  },
  {
    id: "ba9acc66-a824-47c4-a4aa-5abb1a153437",
    sku: "EBOOK-003",
    title: "The value drift index",
    author: "M. Q. Siddiqui",
    product_type: "ebook",
    short_description: "Practical tool for measuring managing and preventing value drift.",
    description: "Practical tool for measuring managing and preventing value drift.",
    price: 79.00,
    currency: "USD",
    format: "PDF",
    cover_image: "https://cneariiepqywvjpmznqn.supabase.co/storage/v1/object/public/product-covers/1788934420360-book2.webp",
    file_path: null,
    active: true,
    download_limit: 3,
    download_expiry_hours: 72,
  }
];

// Helper to execute DB operations safely against schema cache limitations
async function executeWithSchemaFallback(operationFn, payload) {
  let currentPayload = { ...payload };
  while (true) {
    const res = await operationFn(currentPayload);
    if (!res.error) {
      return res;
    }

    const match = res.error.message?.match(/Could not find the '([^']+)' column/i) ||
                  res.error.message?.match(/column ['"]?([a-zA-Z0-9_]+)['"]? of ['"]?orders['"]? does not exist/i) ||
                  res.error.message?.match(/column ['"]?([a-zA-Z0-9_]+)['"]? does not exist/i) ||
                  res.error.message?.match(/Could not find the column '([^']+)'/i);

    if (match && match[1] && currentPayload.hasOwnProperty(match[1])) {
      const badCol = match[1];
      console.warn(`[Payment] Column '${badCol}' missing in 'orders' schema, omitting and retrying.`);
      delete currentPayload[badCol];
      if (Object.keys(currentPayload).length === 0) {
        return res;
      }
      continue;
    }

    return res;
  }
}

// Helper to safely find order by any identifier (session_id, token, or id)
async function findOrderByIdentifier(identifier) {
  if (!identifier) return null;
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

  let order = null;

  // 1. Try finding by stripe_session_id
  if (identifier.startsWith("cs_")) {
    try {
      const { data, error } = await supabase.from("orders").select("*").eq("stripe_session_id", identifier).maybeSingle();
      if (!error && data) order = data;
    } catch (e) {}
  }

  // 2. Try finding by UUID id
  if (!order && isUUID) {
    try {
      const { data, error } = await supabase.from("orders").select("*").eq("id", identifier).maybeSingle();
      if (!error && data) order = data;
    } catch (e) {}
  }

  // 3. Try finding by paypal_order_id or paypal_capture_id
  if (!order) {
    try {
      const { data, error } = await supabase.from("orders").select("*").or(`paypal_order_id.eq.${identifier},paypal_capture_id.eq.${identifier}`).maybeSingle();
      if (!error && data) order = data;
    } catch (e) {}
  }

  // 4. Try finding by payhip_transaction_id
  if (!order) {
    try {
      const { data, error } = await supabase.from("orders").select("*").eq("payhip_transaction_id", identifier).maybeSingle();
      if (!error && data) order = data;
    } catch (e) {}
  }

  // 5. Try finding by order_number
  if (!order && String(identifier).startsWith("ORD-")) {
    try {
      const { data, error } = await supabase.from("orders").select("*").eq("order_number", identifier).maybeSingle();
      if (!error && data) order = data;
    } catch (e) {}
  }

  // 6. Try finding by download_token in Supabase if column exists
  if (!order) {
    try {
      const { data, error } = await supabase.from("orders").select("*").eq("download_token", identifier).maybeSingle();
      if (!error && data) order = data;
    } catch (e) {}
  }

  // 7. Try finding in persistent orderStore
  const meta = findOrderMetadataByToken(identifier);
  if (meta) {
    if (!order && meta.orderId) {
      try {
        const { data, error } = await supabase.from("orders").select("*").eq("id", meta.orderId).maybeSingle();
        if (!error && data) order = data;
      } catch (e) {}
    }
  }

  // Merge and return
  if (order) {
    const orderMeta = getOrderMetadata(order.id) || {};
    return {
      ...order,
      order_number: order.order_number || orderMeta.order_number || `ORD-${order.id ? order.id.substring(0, 8).toUpperCase() : 'UNKNOWN'}`,
      product_id: order.product_id || orderMeta.product_id || null,
      email: order.email || orderMeta.email || null,
      customer_name: order.customer_name || orderMeta.customer_name || null,
      payment_provider: order.payment_provider || orderMeta.payment_provider || (order.stripe_session_id ? 'stripe' : order.paypal_order_id ? 'paypal' : 'payhip'),
      access_tier: order.access_tier || orderMeta.access_tier || (Number(order.amount) < 30 ? 'online' : 'companion'),
      download_token: order.download_token || orderMeta.download_token || order.stripe_session_id || order.id,
      download_count: Number(order.download_count !== undefined ? order.download_count : (orderMeta.download_count || 0)),
      download_limit: Number(order.download_limit !== undefined ? order.download_limit : (orderMeta.download_limit !== undefined ? orderMeta.download_limit : 3)),
      download_expires_at: order.download_expires_at || orderMeta.download_expires_at || null,
    };
  }

  if (meta) {
    return {
      id: meta.orderId,
      book_name: meta.productName || meta.book_name || "Digital Publication",
      amount: meta.amount || 49.00,
      currency: meta.currency || "USD",
      status: meta.status || "paid",
      payment_provider: meta.payment_provider || "paypal",
      access_tier: meta.access_tier || (Number(meta.amount) < 30 ? "online" : "companion"),
      ...meta,
    };
  }

  return null;
}

// A refunded order must never be served, whichever refund marker the update path set (Payhip webhook:
// status + refund_status; admin refund button: status, and refund_status when the column exists).
function isRefundedOrder(order) {
  if (!order) return false;
  const refundStatus = String(order.refund_status || "").toLowerCase();
  return String(order.status || "").toLowerCase() === "refunded" || refundStatus === "refunded" || refundStatus === "full";
}

// What a legacy download / reader link may carry as its credential. findOrderByIdentifier() is deliberately generous
// (order number, Payhip / PayPal ids, ...) because other pages use it to LOOK UP an order, but order numbers and
// provider transaction ids are shown in e-mails, receipts and screenshots and some are guessable, so they must never
// unlock a file. After the order is found, the value is accepted only if it IS one of that order's own secrets:
// its random download token, its Stripe checkout session id, or its UUID (kept for the post-purchase page until
// entitlement-based access replaces it). Format independent, so older token formats keep working.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function credentialMatchesOrder(order, credential) {
  const c = String(credential || "");
  if (!c || !order) return false;
  return c === String(order.download_token || "") || c === String(order.stripe_session_id || "") || c === String(order.id || "");
}

// Is this the Marketing Reclassified book (the product the Companion PDF belongs to)?
function isCatalogProduct(product, order) {
  const id = String((product && product.id) || (order && order.product_id) || "").toLowerCase();
  return id === String(process.env.MR_PRODUCT_ID || "04b84648-3609-4b31-9ded-2486bacf1e74").toLowerCase() || String((product && product.title) || (order && order.book_name) || "").toLowerCase().includes("marketing reclassified");
}

// Helper to resolve product file path accurately
function resolveProductFilePath(product) {
  if (!product) return null;
  const prodId = String(product.id || "");
  const fileInfo = getProductFile(prodId);
  if (fileInfo && fileInfo.filePath) {
    return fileInfo.filePath;
  }
  if (product.file_path) {
    return product.file_path;
  }
  if (prodId === "04b84648-3609-4b31-9ded-2486bacf1e74" || product.title?.toLowerCase().includes("marketing reclassified")) {
    return "ebooks/marketing-reclassified.pdf";
  }
  return null;
}

/**
 * GET /api/payment/products — List active digital products
 */
exports.getProducts = async (req, res) => {
  try {
    const { data: dbProducts, error } = await supabase
      .from("ebooks")
      .select("*")
      .order("created_at", { ascending: false });

    if (error || !dbProducts || dbProducts.length === 0) {
      return res.json({ products: DEFAULT_PRODUCTS });
    }

    const merged = dbProducts.map((p, idx) => {
      const resolvedFile = resolveProductFilePath(p);
      return {
        id: String(p.id),
        sku: p.sku || `PROD-${String(idx + 1).padStart(3, '0')}`,
        title: p.title || p.name || "Digital Product",
        author: p.author || "M. Q. Siddiqui",
        product_type: p.product_type || "ebook",
        short_description: p.description ? p.description.substring(0, 140) + '...' : '',
        description: p.description || '',
        price: Number(p.price) || 49.00,
        currency: p.currency || "USD",
        format: p.format || "PDF",
        cover_image: p.cover_image || "/assets/images/img/30.webp",
        file_path: resolvedFile,
        active: p.active !== false,
        download_limit: p.download_limit || 3,
        download_expiry_hours: p.download_expiry_hours || 72,
      };
    });

    res.json({ products: merged });
  } catch (error) {
    console.error("[getProducts] Error:", error);
    res.json({ products: DEFAULT_PRODUCTS });
  }
};

/**
 * GET /api/payment/products/:id — Get single product
 */
exports.getProductById = async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from("ebooks")
      .select("*")
      .eq("id", id)
      .single();

    if (data) {
      const resolvedFile = resolveProductFilePath(data);
      return res.json({
        product: {
          id: String(data.id),
          sku: data.sku || "PROD-001",
          title: data.title,
          description: data.description,
          price: Number(data.price) || 49.00,
          currency: data.currency || "USD",
          cover_image: data.cover_image || "/assets/images/img/30.webp",
          format: data.format || "PDF",
          file_path: resolvedFile,
          active: data.active !== false,
          download_limit: data.download_limit || 3,
          download_expiry_hours: data.download_expiry_hours || 72,
        }
      });
    }

    const fallback = DEFAULT_PRODUCTS.find(p => p.id === id || String(p.sku) === id) || DEFAULT_PRODUCTS[0];
    return res.json({ product: fallback });
  } catch (err) {
    const fallback = DEFAULT_PRODUCTS.find(p => p.id === id || String(p.sku) === id) || DEFAULT_PRODUCTS[0];
    return res.json({ product: fallback });
  }
};

/**
 * POST /api/payment/create-checkout — Server-side Stripe Checkout Session
 * Strictly derives price & product from database. Never simulates payment success.
 */
exports.createCheckoutSession = async (req, res) => {
  const productId = req.body.productId || req.body.id;
  const customerEmail = (req.body.customerEmail || req.body.email || "").trim().toLowerCase();
  const customerName = (req.body.customerName || req.body.name || "").trim() || "Valued Reader";
  const userId = req.body.userId || null;
  const marketingOptIn = req.body.marketingOptIn || false;

  if (!productId) {
    return res.status(400).json({ error: "Product ID is required to initiate checkout." });
  }

  if (!customerEmail) {
    return res.status(400).json({ error: "Customer email is required for secure digital delivery." });
  }

  try {
    // 1. Resolve product strictly from database or verified catalog
    let product = null;
    const { data: dbProduct } = await supabase
      .from("ebooks")
      .select("*")
      .eq("id", productId)
      .maybeSingle();

    if (dbProduct) {
      product = {
        id: String(dbProduct.id),
        title: dbProduct.title,
        price: Number(dbProduct.price) || 49.00,
        currency: dbProduct.currency || "USD",
        cover_image: dbProduct.cover_image,
        download_limit: dbProduct.download_limit || 3,
        download_expiry_hours: dbProduct.download_expiry_hours || 72,
      };
    } else {
      product = DEFAULT_PRODUCTS.find(p => p.id === productId || String(p.sku) === productId);
    }

    if (!product) {
      return res.status(404).json({ error: "Digital product not found in catalog." });
    }

    // 2. Server-side Ownership & Upgrade Verification
    const { data: customerOrders } = await supabase
      .from("orders")
      .select("*")
      .ilike("email", customerEmail)
      .in("status", ["paid", "successful"]);

    let ownsOnline = false;
    let ownsCompanion = false;
    let priorOnlineOrder = null;

    (customerOrders || []).forEach((o) => {
      const amt = Number(o.amount) || 0;
      const name = String(o.book_name || "").toLowerCase();
      if (amt >= 40 || name.includes("companion") || name.includes("49.99") || name.includes("upgrade")) {
        ownsCompanion = true;
      }
      if ((amt >= 18 && amt <= 25) || name.includes("online") || name.includes("20")) {
        ownsOnline = true;
        priorOnlineOrder = o;
      }
    });

    // Rule 1: Customer already owns Digital Companion Edition -> Block duplicate purchase
    if (ownsCompanion) {
      return res.status(400).json({
        error: "You already own the complete Digital Companion Edition. You have full access to read online and download files."
      });
    }

    const requestedAccessType = req.body.accessType || (req.body.isUpgrade ? "companion" : null);
    let isUpgrade = Boolean(req.body.isUpgrade);
    let priceNum = 49.99;
    let editionType = "companion";
    let editionLabel = "Digital Companion Edition";
    let currencyStr = (req.body.currency || product.currency || "USD").toLowerCase();

    // Rule 2: Owns Online Edition, purchasing Companion -> must be an Upgrade ($29.99)
    if (ownsOnline && (requestedAccessType === "companion" || !requestedAccessType || isUpgrade)) {
      isUpgrade = true;
      editionType = "companion";
      editionLabel = "Upgrade to Digital Companion Edition";
      const priorPaid = priorOnlineOrder ? Number(priorOnlineOrder.amount) : 20.00;
      priceNum = Math.round(Math.max(29.99, 49.99 - priorPaid) * 100) / 100;
    } else if (isUpgrade && !ownsOnline) {
      // Rule 3: Claimed upgrade without verified Online Edition ownership
      return res.status(400).json({
        error: "Upgrade pricing is only available to verified owners of the Online Reading Edition."
      });
    } else if (requestedAccessType === "online" || Number(req.body.amount) === 20) {
      // Rule 4: Buying Online Edition when already owned -> Block duplicate
      if (ownsOnline) {
        return res.status(400).json({
          error: "You already own the Online Reading Edition. You have full access to read this publication in your account."
        });
      }
      editionType = "online";
      editionLabel = "Online Reading Edition";
      priceNum = 20.00;
    } else {
      editionType = "companion";
      editionLabel = "Digital Companion Edition";
      priceNum = 49.99;
    }

    // Apply valid discounts only if not an upgrade
    const discountCode = req.body.discountCode || null;
    const discountPercentage = Number(req.body.discountPercentage || 0);
    if (!isUpgrade && discountPercentage > 0 && discountPercentage <= 100) {
      const discountAmount = Math.round(((priceNum * discountPercentage) / 100) * 100) / 100;
      priceNum = Math.max(0, Math.round((priceNum - discountAmount) * 100) / 100);
    }

    const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const orderId = crypto.randomUUID();

    let resolvedUserId = userId;
    try {
      const userObj = await ensureCustomerAccount({ email: customerEmail, name: customerName, editionType });
      if (userObj && !resolvedUserId) resolvedUserId = userObj.id;
    } catch (e) {
      console.warn("[createCheckoutSession] ensureCustomerAccount:", e.message);
    }
    const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";

    // 3. Validate server-side Stripe secret key
    const stripeClient = getStripeClient();
    if (!stripeClient) {
      console.warn("[createCheckoutSession] Stripe payment gateway is not configured in this environment.");
      return res.status(503).json({
        error: "Stripe payment gateway is currently not configured or unavailable in this environment."
      });
    }

    // 4. Create Stripe Checkout Session
    const sessionConfig = {
      payment_method_types: ["card"],
      customer_email: customerEmail,
      line_items: [
        {
          price_data: {
            currency: currencyStr,
            product_data: {
              name: `${product.title} — ${editionLabel}`,
              description: isUpgrade
                ? "Upgrade Difference: Online Reading, PDF download & Full Companion Pack"
                : editionType === "online"
                ? "Online Reading Edition — Protected In-Browser Reader"
                : "Digital Companion Edition — Downloadable PDF & Companion Pack",
              images: product.cover_image && product.cover_image.startsWith("http") ? [product.cover_image] : undefined,
            },
            unit_amount: Math.round(priceNum * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: {
        orderId,
        orderNumber,
        productId: String(product.id),
        productName: `${product.title} — ${editionLabel}`,
        customerName,
        customerEmail,
        editionType,
        isUpgrade: String(isUpgrade),
        originalOrderId: priorOnlineOrder?.id || "",
        marketingOptIn: String(Boolean(marketingOptIn)),
      },
      success_url: `${clientUrl}/order-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/publications`,
    };

    let session;
    try {
      session = await stripeClient.checkout.sessions.create(sessionConfig);
    } catch (stripeErr) {
      console.error("[createCheckoutSession] Stripe API call failed:", stripeErr.message);
      return res.status(500).json({
        error: `Stripe Checkout error: ${stripeErr.message}`
      });
    }

    // 5. Record order in Supabase and persistent orderStore
    const orderRecord = {
      id: orderId,
      user_id: resolvedUserId,
      marketing_opt_in: Boolean(marketingOptIn),
      email: customerEmail,
      customer_name: customerName,
      product_id: product.id,
      order_number: orderNumber,
      stripe_session_id: session.id,
      book_name: `${product.title} — ${editionLabel}`,
      amount: priceNum,
      currency: currencyStr.toUpperCase(),
      status: "pending",
      download_limit: editionType === "online" ? 0 : (product.download_limit || 3),
      download_expires_at: new Date(Date.now() + (product.download_expiry_hours || 72) * 3600 * 1000).toISOString(),
    };

    saveOrderMetadata(orderId, {
      ...orderRecord,
      orderId,
      editionType,
      isUpgrade,
    });

    const { error: insertErr } = await executeWithSchemaFallback(
      (payload) => supabase.from("orders").insert([payload]),
      orderRecord
    );

    if (insertErr) {
      console.warn("[createCheckoutSession] Order DB fallback note:", insertErr.message);
    }

    return res.json({
      url: session.url,
      sessionId: session.id,
      orderNumber,
      orderId,
    });
  } catch (error) {
    console.error("[createCheckoutSession] Unhandled error:", error);
    return res.status(500).json({ error: error.message || "Failed to create checkout session" });
  }
};

/**
 * POST /api/payment/webhook — Official Stripe Webhook Handler
 * Uses cryptographic webhook signature verification.
 */
exports.stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  const stripeClient = getStripeClient();
  if (!stripeClient || !webhookSecret || webhookSecret.includes("placeholder") || webhookSecret.includes("your")) {
    console.warn("[stripeWebhook] Stripe gateway or STRIPE_WEBHOOK_SECRET is not configured.");
    return res.status(503).send("Webhook Error: Stripe payment gateway is not configured in this environment.");
  }

  if (!sig) {
    console.error("[stripeWebhook] Missing stripe signature header");
    return res.status(400).send("Webhook Error: Signature or secret missing");
  }

  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error(`[stripeWebhook] Signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[stripeWebhook] Received verified Stripe event: ${event.type}`);

  // 1. Handle checkout.session.completed
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    if (session.payment_status !== "paid") {
      console.warn(`[stripeWebhook] Session ${session.id} completed but payment_status is '${session.payment_status}'. Not marking as paid.`);
      return res.json({ received: true, note: "Payment not completed" });
    }

    const sessionId = session.id;
    const paymentIntentId = session.payment_intent || null;
    const metadata = session.metadata || {};
    const orderId = metadata.orderId || null;
    const customerEmail = session.customer_details?.email || metadata.customerEmail || session.customer_email;
    const customerName = metadata.customerName || session.customer_details?.name || "Valued Customer";
    const productName = metadata.productName || "Digital Publication";
    const amount = session.amount_total ? (session.amount_total / 100).toFixed(2) : "49.00";
    const detectedEdition = (Number(amount) >= 40 || String(productName).toLowerCase().includes("companion") || metadata.accessType === "companion") ? "companion" : "online";
    try {
      if (customerEmail) {
        await ensureCustomerAccount({ email: customerEmail, name: customerName, editionType: detectedEdition });
      }
    } catch (e) {
      console.warn("[stripeWebhook] ensureCustomerAccount:", e.message);
    }
    const currency = (session.currency || "USD").toUpperCase();

    // Look up existing order safely
    const existingOrder = await findOrderByIdentifier(orderId || sessionId);

    // Idempotency check: if already paid, do not re-process
    if (existingOrder && (existingOrder.status === "paid" || existingOrder.status === "successful")) {
      console.log(`[stripeWebhook] Order ${existingOrder.id} already marked as paid. Skipping redundant processing.`);
      return res.json({ received: true, idempotent: true });
    }

    // Generate cryptographic download token and expiry
    const downloadToken = crypto.randomBytes(32).toString("hex");
    const expiryHours = 72;
    const expiresAt = new Date(Date.now() + expiryHours * 3600 * 1000).toISOString();

    const updatePayload = {
      status: "paid",
      email: customerEmail || existingOrder?.email,
      customer_name: customerName,
      stripe_payment_intent_id: paymentIntentId,
      download_token: downloadToken,
      download_expires_at: expiresAt,
      download_count: 0,
      download_limit: 3,
    };

    const targetId = existingOrder?.id || orderId;
    if (targetId) {
      saveOrderMetadata(targetId, {
        ...updatePayload,
        orderId: targetId,
        stripe_session_id: sessionId,
        productId: metadata.productId,
        productName,
        amount,
        currency,
      });

      await executeWithSchemaFallback(
        (payload) => supabase.from("orders").update(payload).eq("id", targetId),
        updatePayload
      );
    } else {
      await executeWithSchemaFallback(
        (payload) => supabase.from("orders").update(payload).eq("stripe_session_id", sessionId),
        updatePayload
      );
    }

    console.log(`[stripeWebhook] Order ${sessionId} successfully confirmed and marked as PAID.`);

    // Send Confirmation Email safely
    const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";
    const downloadUrl = `${clientUrl}/order-success?session_id=${sessionId}&token=${downloadToken}`;

    try {
      if (customerEmail) {
        await sendOrderConfirmationEmail({
          to: customerEmail,
          customerName,
          orderNumber: metadata.orderNumber || (existingOrder?.order_number || `ORD-${sessionId.substring(0, 8).toUpperCase()}`),
          productName,
          amount,
          currency,
          downloadUrl,
          editionType: detectedEdition,
          expiryHours,
          downloadLimit: 3,
        });
      }
    } catch (emailErr) {
      console.error("[stripeWebhook] Confirmation email delivery notice:", emailErr.message);
    }
  }

  // 2. Handle failed or expired sessions
  if (event.type === "checkout.session.expired") {
    const session = event.data.object;
    console.log(`[stripeWebhook] Processing expired checkout session: ${session.id}`);
    const ord = await findOrderByIdentifier(session.id);
    if (ord?.id) saveOrderMetadata(ord.id, { status: "expired" });
    await executeWithSchemaFallback(
      (payload) => supabase.from("orders").update(payload).eq("stripe_session_id", session.id),
      { status: "expired" }
    );
  }

  if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object;
    console.log(`[stripeWebhook] Processing failed payment intent: ${pi.id}`);
    const ord = await findOrderByIdentifier(pi.id);
    if (ord?.id) saveOrderMetadata(ord.id, { status: "failed" });
    await executeWithSchemaFallback(
      (payload) => supabase.from("orders").update(payload).eq("stripe_session_id", pi.id),
      { status: "failed" }
    );
  }

  // 3. Handle refunds
  if (event.type === "charge.refunded" || event.type === "payment_intent.refunded") {
    const obj = event.data.object;
    console.log(`[stripeWebhook] Processing refund event: ${event.type}`);
    const piId = obj.payment_intent || obj.id;
    const ord = await findOrderByIdentifier(piId);
    if (ord?.id) saveOrderMetadata(ord.id, { status: "refunded" });

    await executeWithSchemaFallback(
      (payload) => supabase.from("orders").update(payload).or(`stripe_payment_intent_id.eq.${piId},stripe_session_id.eq.${piId}`),
      {
        status: "refunded",
        refund_status: "refunded",
        refund_date: new Date().toISOString()
      }
    );
  }

  res.json({ received: true });
};

/**
 * GET /api/payment/order-status/:identifier — Real backend verification of order status
 */
exports.getOrderStatus = async (req, res) => {
  const { identifier } = req.params;

  if (!identifier || identifier === "undefined" || identifier === "null") {
    return res.status(400).json({ error: "Invalid order identifier." });
  }

  try {
    const order = await findOrderByIdentifier(identifier);

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    const isExpired = order.download_expires_at ? new Date() > new Date(order.download_expires_at) : false;
    const isLimitReached = (Number(order.download_count) || 0) >= (Number(order.download_limit) || 3);
    const isRefunded = isRefundedOrder(order);
    const isPaid = !isRefunded && (order.status === "paid" || order.status === "successful");

    // Resolve attached file status
    let hasFile = false;
    let productTitle = order.book_name || "Digital Publication";

    if (order.product_id) {
      const { data: prod } = await supabase.from("ebooks").select("*").eq("id", order.product_id).maybeSingle();
      if (prod) {
        productTitle = prod.title || productTitle;
        const filePath = resolveProductFilePath(prod);
        hasFile = !!filePath;
      }
    } else {
      const fallbackProd = DEFAULT_PRODUCTS.find(p => p.title?.toLowerCase() === (order.book_name || "").toLowerCase());
      hasFile = !!resolveProductFilePath(fallbackProd);
    }

    return res.json({
      order: {
        id: order.id,
        order_number: order.order_number || `ORD-${order.id ? order.id.substring(0, 8).toUpperCase() : "UNKNOWN"}`,
        book_name: productTitle,
        product_id: order.product_id || null,
        amount: Number(order.amount) || 0,
        currency: order.currency || "USD",
        status: order.status,
        email: order.email || null,
        download_token: order.download_token || order.stripe_session_id || order.id,
        download_count: Number(order.download_count) || 0,
        download_limit: Number(order.download_limit) || 3,
        download_expires_at: order.download_expires_at || null,
        isExpired,
        isLimitReached,
        isRefunded,
        isPaid,
        hasFile,
        created_at: order.created_at || new Date().toISOString()
      }
    });

  } catch (error) {
    console.error("[getOrderStatus] Error:", error);
    return res.status(500).json({ error: "Failed to query order status." });
  }
};

/**
 * GET /api/payment/download/:token — Secure Product File Streaming
 * Downloads ONLY the specific PDF attached to the exact purchased product.
 */
exports.downloadProductFile = async (req, res) => {
  const token = req.params.token || req.query.token || req.query.order_id || req.query.session_id;

  if (!token || token === "undefined" || token === "null") {
    return res.status(400).json({ error: "Download token is required." });
  }

  try {
    // 1. Locate order safely
    const order = await findOrderByIdentifier(token);

    if (!order) {
      return res.status(404).json({
        error: "Invalid download link. Please check your order confirmation email or request a replacement link."
      });
    }

    if (!req.verifiedOrderId && !credentialMatchesOrder(order, token)) {
      // matched only an order number / provider transaction id: not a credential
      return res.status(404).json({
        error: "Invalid download link. Please check your order confirmation email or request a replacement link."
      });
    }

    // 2. Security checks
    if (isRefundedOrder(order)) {
      return res.status(403).json({
        error: "This order has been refunded. Digital download access is revoked."
      });
    }

    if (order.status !== "paid" && order.status !== "successful") {
      return res.status(403).json({
        error: "Payment verification pending. Please complete payment before downloading."
      });
    }

    // Enforce Online Edition download restriction server-side:
    // Online Reading Edition does NOT include authorized PDF download.
    const amtNum = Number(order.amount) || 0;
    const bName = String(order.book_name || "").toLowerCase();
    const isOnlineOnlyEdition = (order.edition_type === "online" || (amtNum >= 18 && amtNum <= 25) || bName.includes("online")) &&
      !bName.includes("companion") && !bName.includes("upgrade") && amtNum < 40;

    if (isOnlineOnlyEdition) {
      return res.status(403).json({
        error: "This order is for the Online Reading Edition ($20.00), which includes protected in-browser reading only. PDF file downloads and full Companion Packs are exclusively included with the Digital Companion Edition ($49.99). Please upgrade your account to download the file."
      });
    }

    // Central entitlement gate: only a customer whose CURRENT entitlement is Digital Companion may download Companion files
    // (a refund, an administrative revocation or an Online-only edition stops it immediately, whatever the link says).
    const dlGate = await checkCompanionDownload(order);
    if (!dlGate.allowed) {
      return res.status(403).json({ error: "Your current edition does not include Companion downloads.", code: "not_entitled" });
    }

    if (order.download_expires_at && new Date() > new Date(order.download_expires_at)) {
      return res.status(410).json({
        error: "This download link has expired (72-hour window). Please request a replacement link below."
      });
    }

    // ?file=book asks for the book PDF (the second file of the Digital Companion edition). Anything else is the Companion Pack, as before.
    // Every check above has already run for both files. The book PDF has its own counter (orders.book_download_count);
    // if that column is not installed yet the request is refused rather than served without a limit.
    const wantBook = String((req.query && req.query.file) || "").toLowerCase() === "book";
    if (wantBook && !Object.prototype.hasOwnProperty.call(order, "book_download_count")) {
      return res.status(503).json({ error: "The book PDF download is not available yet. Please try again later or contact info@siddiqui.digital." });
    }
    const currentCount = Number((wantBook ? order.book_download_count : order.download_count) || 0);
    const limit = Number(order.download_limit || 3);
    if (currentCount >= limit) {
      return res.status(403).json({
        error: `Maximum download limit reached (${currentCount} of ${limit} downloads used).`
      });
    }

    // 3. Resolve the exact product purchased
    let product = null;
    if (order.product_id) {
      const { data: prodData } = await supabase
        .from("ebooks")
        .select("*")
        .eq("id", order.product_id)
        .maybeSingle();
      product = prodData;
    }

    if (!product && order.book_name) {
      const { data: prodByName } = await supabase
        .from("ebooks")
        .select("*")
        .ilike("title", `%${order.book_name}%`)
        .maybeSingle();
      product = prodByName;
    }

    if (!product && order.product_id) {
      product = DEFAULT_PRODUCTS.find(p => p.id === order.product_id || String(p.sku) === order.product_id);
    }

    if (!product && order.book_name) {
      product = DEFAULT_PRODUCTS.find(p => p.title?.toLowerCase() === order.book_name.toLowerCase());
    }

    // 4. Resolve the specific file attached to THIS product
    // The Companion PDF an administrator marked current in the dashboard wins over the older per-server file mapping.
    let specificFilePath;
    if (wantBook) {
      // the book PDF has no fallback: only the file an administrator marked current, and only for the catalog book
      specificFilePath = isCatalogProduct(product, order) ? await getCurrentFilePath("book_pdf") : null;
      if (!specificFilePath) {
        return res.status(404).json({ error: "The book PDF is not available yet. Please contact support at info@siddiqui.digital." });
      }
    } else {
      const currentCompanion = isCatalogProduct(product, order) ? await getCurrentCompanionPath() : null;
      specificFilePath = currentCompanion || resolveProductFilePath(product);
    }

    if (!specificFilePath) {
      console.warn(`[downloadProductFile] No PDF attached for product: ${product?.title || order.book_name} (ID: ${order.product_id})`);
      return res.status(404).json({
        error: `No PDF publication file is currently attached to "${product?.title || order.book_name || 'this product'}". Please contact support at info@siddiqui.digital.`
      });
    }

    // 5. Download the specific file from Supabase Storage
    const candidateBuckets = ["digital-products", "product-covers", "blogs"];
    let fileBuffer = null;

    for (const bucketName of candidateBuckets) {
      const cleanPath = specificFilePath.startsWith(`${bucketName}/`)
        ? specificFilePath.replace(`${bucketName}/`, "")
        : specificFilePath;

      const { data: fileData, error: fileErr } = await supabase.storage
        .from(bucketName)
        .download(cleanPath);

      if (fileData && !fileErr) {
        const arrayBuffer = await fileData.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuffer);
        break;
      }
    }

    if (!fileBuffer) {
      console.error(`[downloadProductFile] File not found in storage: ${specificFilePath}`);
      return res.status(404).json({
        error: `The publication file for "${product?.title || order.book_name}" could not be retrieved from storage. Please contact info@siddiqui.digital.`
      });
    }

    // 6. Increment download count atomically
    if (order.id) {
      if (wantBook) {
        await supabase.from("orders").update({ book_download_count: currentCount + 1 }).eq("id", order.id);
      } else {
        saveOrderMetadata(order.id, { download_count: currentCount + 1 });
        await executeWithSchemaFallback(
          (payload) => supabase.from("orders").update(payload).eq("id", order.id),
          { download_count: currentCount + 1 }
        );
      }
    }

    // 7. Stream the exact file
    const safeTitle = (product?.title || order.book_name || "Digital-Publication")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_");
    const filename = wantBook ? "Marketing_Reclassified_Book.pdf" : `${safeTitle}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", fileBuffer.length);
    return res.end(fileBuffer);

  } catch (error) {
    console.error("[downloadProductFile] Error:", error);
    return res.status(500).json({ error: "Failed to stream protected file." });
  }
};

/**
 * POST /api/payment/request-replacement — Request a replacement link via email
 */
exports.requestReplacementLink = async (req, res) => {
  const { email, orderNumber } = req.body || {};
  const cleanEmail = typeof email === "string" ? email.trim() : "";

  if (!cleanEmail) {
    return res.status(400).json({ error: "Email is required to locate orders." });
  }
  // A "%" or "_" must never act as a wildcard: that would match other customers' orders and rotate their links.
  if (!/^[^\s@,%()]+@[^\s@,%()]+\.[^\s@,%()]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  try {
    let query = supabase.from("orders").select("*").ilike("email", escapeLike(cleanEmail));
    if (typeof orderNumber === "string" && orderNumber.trim()) {
      // Keep only characters that can occur in an order number / session id, so the value cannot alter the filter.
      const safeNum = orderNumber.trim().replace(/[^A-Za-z0-9_-]/g, "");
      if (!safeNum) {
        return res.status(404).json({ error: "No matching orders found for this email address." });
      }
      query = query.or(`order_number.ilike.%${safeNum}%,stripe_session_id.ilike.%${safeNum}%,id.ilike.%${safeNum}%`);
    }

    const { data: orders, error } = await query;

    if (error || !orders || orders.length === 0) {
      return res.status(404).json({ error: "No matching orders found for this email address." });
    }

    const paidOrder = orders.find(o => o.status === "paid" || o.status === "successful");
    if (!paidOrder) {
      return res.status(400).json({ error: "No active paid orders found. The order may have been refunded or is still pending." });
    }

    const newExpiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    const newDownloadToken = crypto.randomBytes(32).toString("hex");

    saveOrderMetadata(paidOrder.id, {
      download_token: newDownloadToken,
      download_expires_at: newExpiresAt,
      download_count: Math.min(paidOrder.download_count || 0, 2),
    });

    await executeWithSchemaFallback(
      (payload) => supabase.from("orders").update(payload).eq("id", paidOrder.id),
      {
        download_token: newDownloadToken,
        download_expires_at: newExpiresAt,
        download_count: Math.min(paidOrder.download_count || 0, 2),
      }
    );

    const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";
    const downloadUrl = `${clientUrl}/order-success?session_id=${paidOrder.stripe_session_id}&token=${newDownloadToken}`;

    await sendOrderConfirmationEmail({
      to: paidOrder.email || cleanEmail,
      customerName: paidOrder.customer_name || "Valued Customer",
      orderNumber: paidOrder.order_number || `ORD-${paidOrder.id?.substring(0, 8).toUpperCase()}`,
      productName: paidOrder.book_name || "Digital Publication",
      amount: paidOrder.amount,
      currency: paidOrder.currency || "USD",
      downloadUrl,
      expiryHours: 72,
      downloadLimit: 3,
    });

    return res.json({ success: true, message: "A replacement download link has been sent to your email address." });
  } catch (error) {
    console.error("[requestReplacementLink] Error:", error);
    return res.status(500).json({ error: "Failed to process replacement request." });
  }
};


/**
 * GET /api/payment/read/:token — Secure In-Browser Online Reader Stream
 * Delivers protected inline document streaming for verified purchasers only.
 * Disallows downloading via strict headers.
 */
exports.readOnlineBook = async (req, res) => {
  const token = req.params.token || req.query.token || req.query.order_id || req.query.session_id;

  if (!token || token === "undefined" || token === "null") {
    return res.status(400).json({ error: "Access token is required to view publication." });
  }

  try {
    const order = await findOrderByIdentifier(token);

    if (!order) {
      return res.status(404).json({ error: "Order not found. Please sign in to your reader account." });
    }

    if (!req.verifiedOrderId && !credentialMatchesOrder(order, token)) {
      return res.status(404).json({ error: "Order not found. Please sign in to your reader account." });
    }

    if (isRefundedOrder(order)) {
      return res.status(403).json({ error: "This purchase has been refunded. Online reading access is revoked." });
    }

    if (order.status !== "paid" && order.status !== "successful") {
      return res.status(403).json({ error: "Payment verification required to access online reader." });
    }

    // The reader is included with the Online Reading and the Digital Companion editions (decided by the central entitlement).
    const rdGate = await checkReaderAccess(order);
    if (!rdGate.allowed) {
      return res.status(403).json({ error: "The online reader is included with the Online Reading and Digital Companion editions.", code: "not_entitled" });
    }

    // Resolve product
    let product = null;
    if (order.product_id) {
      const { data: prodData } = await supabase.from("ebooks").select("*").eq("id", order.product_id).maybeSingle();
      product = prodData;
    }
    if (!product && order.book_name) {
      const { data: prodByName } = await supabase.from("ebooks").select("*").ilike("title", `%${order.book_name}%`).maybeSingle();
      product = prodByName;
    }
    if (!product) {
      product = DEFAULT_PRODUCTS[0];
    }

    const specificFilePath = resolveProductFilePath(product);
    if (!specificFilePath) {
      return res.status(404).json({ error: "Publication content is not currently available for online reading." });
    }

    const candidateBuckets = ["digital-products", "product-covers", "blogs"];
    let fileBuffer = null;

    for (const bucketName of candidateBuckets) {
      const cleanPath = specificFilePath.startsWith(`${bucketName}/`)
        ? specificFilePath.replace(`${bucketName}/`, "")
        : specificFilePath;

      const { data: fileBlob, error: storageErr } = await supabase.storage.from(bucketName).download(cleanPath);
      if (!storageErr && fileBlob) {
        fileBuffer = Buffer.from(await fileBlob.arrayBuffer());
        break;
      }
    }

    if (!fileBuffer) {
      return res.status(404).json({ error: "The protected publication file could not be loaded." });
    }

    // Security headers: display inline, forbid caching, disallow sniffing
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="reader-preview-${order.id ? order.id.slice(0, 8) : 'book'}.pdf"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.send(fileBuffer);
  } catch (err) {
    console.error("[readOnlineBook] Error:", err);
    return res.status(500).json({ error: "Failed to stream publication for online reading." });
  }
};

/**
 * POST /api/payment/orders/:id/access-link   body: { purpose: "download" | "read" }   (signed-in customer)
 * Issues a short-lived link to ONE of the caller's own orders. The order must belong to the session (user id, or the
 * confirmed e-mail on the session); anything else answers 404 so another customer's order ids cannot be probed.
 */
exports.createAccessLink = async (req, res) => {
  const user = req.authUser;
  const orderId = String(req.params.id || "");
  const purpose = req.body && req.body.purpose;
  if (!UUID_RE.test(orderId)) return res.status(400).json({ error: "Invalid order." });
  if (purpose !== "download" && purpose !== "read") return res.status(400).json({ error: "Invalid purpose." });
  try {
    const { data: order, error } = await supabase.from("orders").select("*").eq("id", orderId).maybeSingle();
    if (error) return res.status(500).json({ error: "Could not look up the order." });
    const sameEmail = order && order.email && String(order.email).trim().toLowerCase() === String(user.email).trim().toLowerCase();
    const mine = order && ((order.user_id && order.user_id === user.id) || sameEmail);
    if (!mine) return res.status(404).json({ error: "Order not found." });
    if (isRefundedOrder(order)) return res.status(403).json({ error: "This order has been refunded. Access is revoked." });
    if (order.status !== "paid" && order.status !== "successful") return res.status(403).json({ error: "Payment verification required." });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ path: `/payment/access/${signAccess({ orderId: order.id, purpose })}`, expiresIn: TTL_SECONDS });
  } catch (err) {
    console.error("[createAccessLink] Error:", err);
    return res.status(500).json({ error: "Could not create the link." });
  }
};

/**
 * GET /api/payment/access/:signed — serves the file or reader for a verified, unexpired link. All the normal checks
 * (refund, payment status, edition rules, expiry, download limit) run again at this moment, so a refund issued after
 * the link was created still takes effect.
 */
exports.serveAccessLink = (req, res) => {
  const verified = verifyAccess(req.params.signed);
  if (!verified) {
    return res.status(403).json({ error: "This link has expired or is not valid. Please go back to My Orders and try again." });
  }
  req.verifiedOrderId = verified.orderId;
  req.params.token = verified.orderId;
  return verified.purpose === "download" ? exports.downloadProductFile(req, res) : exports.readOnlineBook(req, res);
};
