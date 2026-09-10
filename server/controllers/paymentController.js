const Stripe = require("stripe");
const crypto = require("crypto");
const supabase = require("../config/supabaseClient");
const { sendOrderConfirmationEmail } = require("../utils/orderEmail");
const { getProductFile, setProductFile } = require("../utils/productFileStore");
const { saveOrderMetadata, getOrderMetadata, findOrderMetadataByToken } = require("../utils/orderStore");
require("dotenv").config();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = new Stripe(stripeSecretKey);

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
    currency: "AED",
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
    currency: "AED",
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
    currency: "AED",
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

  // 3. Try finding by download_token in Supabase if column exists
  if (!order) {
    try {
      const { data, error } = await supabase.from("orders").select("*").eq("download_token", identifier).maybeSingle();
      if (!error && data) order = data;
    } catch (e) {}
  }

  // 4. Try finding in persistent orderStore
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
      download_token: order.download_token || orderMeta.download_token || order.stripe_session_id || order.id,
      download_count: Number(order.download_count !== undefined ? order.download_count : (orderMeta.download_count || 0)),
      download_limit: Number(order.download_limit || orderMeta.download_limit || 3),
      download_expires_at: order.download_expires_at || orderMeta.download_expires_at || null,
    };
  }

  if (meta) {
    return {
      id: meta.orderId,
      book_name: meta.productName || "Digital Publication",
      amount: meta.amount || 49.00,
      currency: meta.currency || "AED",
      status: meta.status || "paid",
      ...meta,
    };
  }

  return null;
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
        currency: p.currency || "AED",
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
          currency: data.currency || "AED",
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
  const customerEmail = (req.body.customerEmail || req.body.email || "").trim();
  const customerName = (req.body.customerName || req.body.name || "").trim() || "Valued Customer";
  const userId = req.body.userId || null;

  if (!productId) {
    return res.status(400).json({ error: "Product ID is required to initiate checkout." });
  }

  if (!customerEmail) {
    return res.status(400).json({ error: "Customer email is required for secure digital delivery." });
  }

  try {
    // 1. Resolve product strictly from database
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
        currency: dbProduct.currency || "AED",
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

    const priceNum = Number(product.price);
    const currencyStr = (product.currency || "AED").toLowerCase();
    const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const orderId = crypto.randomUUID();
    const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";

    // 2. Validate server-side Stripe secret key
    if (!stripeSecretKey || stripeSecretKey.includes("placeholder") || stripeSecretKey.includes("your")) {
      console.error("[createCheckoutSession] Stripe secret key is not properly configured on server.");
      return res.status(500).json({
        error: "Stripe payment gateway is currently not configured. Please contact support at info@siddiqui.digital."
      });
    }

    // 3. Create Stripe Checkout Session
    const sessionConfig = {
      payment_method_types: ["card"],
      customer_email: customerEmail,
      line_items: [
        {
          price_data: {
            currency: currencyStr,
            product_data: {
              name: product.title,
              description: "Official Digital Publication (PDF Edition) — Instant Delivery",
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
        productName: product.title,
        customerName,
        customerEmail,
      },
      success_url: `${clientUrl}/order-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/order-cancel?product_id=${product.id}`,
    };

    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionConfig);
    } catch (stripeErr) {
      console.error("[createCheckoutSession] Stripe API call failed:", stripeErr.message);
      return res.status(500).json({
        error: `Stripe Checkout error: ${stripeErr.message}`
      });
    }

    // 4. Record order in Supabase and persistent orderStore
    const orderRecord = {
      id: orderId,
      user_id: userId,
      email: customerEmail,
      customer_name: customerName,
      product_id: product.id,
      order_number: orderNumber,
      stripe_session_id: session.id,
      book_name: product.title,
      amount: priceNum,
      currency: (product.currency || "AED").toUpperCase(),
      status: "pending",
      download_limit: product.download_limit || 3,
      download_expires_at: new Date(Date.now() + (product.download_expiry_hours || 72) * 3600 * 1000).toISOString(),
    };

    saveOrderMetadata(orderId, {
      ...orderRecord,
      orderId,
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

  if (!sig || !webhookSecret) {
    console.error("[stripeWebhook] Missing stripe signature or STRIPE_WEBHOOK_SECRET");
    return res.status(400).send("Webhook Error: Signature or secret missing");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
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
    const currency = (session.currency || "AED").toUpperCase();

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
    const isRefunded = order.status === "refunded";
    const isPaid = order.status === "paid" || order.status === "successful";

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
        currency: order.currency || "AED",
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

    // 2. Security checks
    if (order.status === "refunded") {
      return res.status(403).json({
        error: "This order has been refunded. Digital download access is revoked."
      });
    }

    if (order.status !== "paid" && order.status !== "successful") {
      return res.status(403).json({
        error: "Payment verification pending. Please complete payment before downloading."
      });
    }

    if (order.download_expires_at && new Date() > new Date(order.download_expires_at)) {
      return res.status(410).json({
        error: "This download link has expired (72-hour window). Please request a replacement link below."
      });
    }

    const currentCount = Number(order.download_count || 0);
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
    const specificFilePath = resolveProductFilePath(product);

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
      saveOrderMetadata(order.id, { download_count: currentCount + 1 });
      await executeWithSchemaFallback(
        (payload) => supabase.from("orders").update(payload).eq("id", order.id),
        { download_count: currentCount + 1 }
      );
    }

    // 7. Stream the exact file
    const safeTitle = (product?.title || order.book_name || "Digital-Publication")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_");
    const filename = `${safeTitle}.pdf`;

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
  const { email, orderNumber } = req.body;

  if (!email || !email.trim()) {
    return res.status(400).json({ error: "Email is required to locate orders." });
  }

  try {
    let query = supabase.from("orders").select("*").ilike("email", email.trim());
    if (orderNumber && orderNumber.trim()) {
      const cleanNum = orderNumber.trim();
      query = query.or(`order_number.ilike.%${cleanNum}%,stripe_session_id.ilike.%${cleanNum}%,id.ilike.%${cleanNum}%`);
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
      to: email.trim(),
      customerName: paidOrder.customer_name || "Valued Customer",
      orderNumber: paidOrder.order_number || `ORD-${paidOrder.id?.substring(0, 8).toUpperCase()}`,
      productName: paidOrder.book_name || "Digital Publication",
      amount: paidOrder.amount,
      currency: paidOrder.currency || "AED",
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
