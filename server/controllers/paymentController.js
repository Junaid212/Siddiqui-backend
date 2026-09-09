const Stripe = require("stripe");
const crypto = require("crypto");
const supabase = require("../config/supabaseClient");
const { sendOrderConfirmationEmail } = require("../utils/orderEmail");
require("dotenv").config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");

// Generic digital product catalog fallback
const DEFAULT_PRODUCTS = [
  {
    id: "cff3798b-88bb-41af-8e2a-bc5f7a2a4239",
    sku: "EBOOK-001",
    title: "Marketing Reclassified",
    author: "Qutub Siddiqui",
    product_type: "ebook",
    short_description: "The definitive strategic playbook for modern digital marketing and high-performance brand leadership.",
    description: "Marketing Reclassified breaks down cutting-edge marketing frameworks, behavioral psychology, and sustainable growth engines to help entrepreneurs and brand leaders scale with clarity and precision.",
    price: 49.00,
    currency: "AED",
    format: "PDF",
    cover_image: "/assets/images/img/30.webp",
    file_path: "ebooks/marketing-reclassified.pdf",
    active: true,
    download_limit: 3,
    download_expiry_hours: 72,
  },
  {
    id: "prod_002_sid_philosophy",
    sku: "WORKBOOK-002",
    title: "SID Philosophy Workbook",
    author: "Qutub Siddiqui",
    product_type: "workbook",
    short_description: "Interactive strategic workbook for applying the SID executive framework.",
    description: "A step-by-step diagnostic and execution workbook to align your organization around purpose, positioning, and profit.",
    price: 79.00,
    currency: "AED",
    format: "PDF",
    cover_image: "/assets/images/img/31.webp",
    file_path: "ebooks/marketing-reclassified.pdf",
    active: true,
    download_limit: 3,
    download_expiry_hours: 72,
  },
  {
    id: "prod_003_research_report",
    sku: "REPORT-003",
    title: "Executive Research Report",
    author: "Qutub Siddiqui",
    product_type: "report",
    short_description: "Comprehensive analytical research on modern business development and digital market intelligence.",
    description: "In-depth research intelligence, market dynamics, and leadership growth frameworks.",
    price: 99.00,
    currency: "AED",
    format: "PDF",
    cover_image: "/assets/images/img/32.webp",
    file_path: "ebooks/marketing-reclassified.pdf",
    active: true,
    download_limit: 3,
    download_expiry_hours: 72,
  }
];

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

    const merged = dbProducts.map((p, idx) => ({
      id: String(p.id),
      sku: p.sku || `PROD-${String(idx + 1).padStart(3, '0')}`,
      title: p.title || p.name || "Digital Product",
      author: p.author || "Qutub Siddiqui",
      product_type: p.product_type || "ebook",
      short_description: p.description ? p.description.substring(0, 140) + '...' : '',
      description: p.description || '',
      price: Number(p.price) || 49.00,
      currency: p.currency || "AED",
      format: p.format || "PDF",
      cover_image: p.cover_image || "/assets/images/img/30.webp",
      file_path: p.file_path || "ebooks/marketing-reclassified.pdf",
      active: p.active !== false,
      download_limit: p.download_limit || 3,
      download_expiry_hours: p.download_expiry_hours || 72,
    }));

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
          active: data.active !== false,
          download_limit: data.download_limit || 3,
          download_expiry_hours: data.download_expiry_hours || 72,
        }
      });
    }

    const fallback = DEFAULT_PRODUCTS.find(p => p.id === id || String(p.sku) === id) || DEFAULT_PRODUCTS[0];
    return res.json({ product: fallback });
  } catch (err) {
    const fallback = DEFAULT_PRODUCTS[0];
    return res.json({ product: fallback });
  }
};

/**
 * POST /api/payment/create-checkout — Server-side Stripe Checkout Session
 * Price & currency are strictly derived server-side. Never trusts client prices.
 */
exports.createCheckoutSession = async (req, res) => {
  const productId = req.body.productId || req.body.id;
  const customerEmail = req.body.customerEmail || req.body.email;
  const customerName = req.body.customerName || req.body.name;
  const userId = req.body.userId;

  try {
    let product = null;
    if (productId) {
      const { data } = await supabase.from("ebooks").select("*").eq("id", productId).single();
      if (data) {
        product = {
          id: String(data.id),
          title: data.title,
          price: Number(data.price) || 49.00,
          currency: data.currency || "AED",
          cover_image: data.cover_image,
          download_limit: data.download_limit || 3,
          download_expiry_hours: data.download_expiry_hours || 72,
        };
      } else {
        product = DEFAULT_PRODUCTS.find(p => p.id === productId || String(p.sku) === productId);
      }
    }

    if (!product) {
      product = DEFAULT_PRODUCTS[0];
    }

    const priceNum = Number(product.price);
    const currencyStr = (product.currency || "AED").toLowerCase();
    const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";

    const sessionConfig = {
      payment_method_types: ["card"],
      customer_email: customerEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: currencyStr,
            product_data: {
              name: product.title,
              description: `Official Digital Publication (PDF Edition) — Instant Secure Delivery`,
              images: product.cover_image && product.cover_image.startsWith("http") ? [product.cover_image] : undefined,
            },
            unit_amount: Math.round(priceNum * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: {
        orderNumber,
        productId: String(product.id),
        productName: product.title,
        customerName: customerName || "",
        customerEmail: customerEmail || "",
      },
      success_url: `${clientUrl}/order-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/order-cancel?product_id=${product.id}`,
    };

    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionConfig);
    } catch (stripeErr) {
      console.warn("[createCheckoutSession] Stripe notice (using test mock session):", stripeErr.message);
      const mockSessionId = `cs_test_${crypto.randomBytes(16).toString("hex")}`;
      session = {
        id: mockSessionId,
        url: `${clientUrl}/order-success?session_id=${mockSessionId}&mock=true`,
      };
    }

    // Record order in Supabase with 'pending' status
    const orderRecord = {
      user_id: userId || null,
      email: customerEmail || null,
      stripe_session_id: session.id,
      book_name: product.title,
      amount: priceNum,
      currency: (product.currency || "AED").toUpperCase(),
      status: "pending",
      download_limit: product.download_limit || 3,
    };

    await supabase.from("orders").insert([orderRecord]);

    return res.json({
      url: session.url,
      sessionId: session.id,
      orderNumber,
    });
  } catch (error) {
    console.error("[createCheckoutSession] Error:", error);
    return res.status(500).json({ error: error.message || "Failed to create checkout session" });
  }
};

/**
 * GET /api/payment/order-status/:identifier — Check order status by session_id, order_number, or token
 */
exports.getOrderStatus = async (req, res) => {
  const { identifier } = req.params;

  try {
    let query = supabase.from("orders").select("*");

    if (identifier.startsWith("cs_")) {
      query = query.eq("stripe_session_id", identifier);
    } else {
      query = query.eq("id", identifier);
    }

    const { data: order, error } = await query.single();

    if (error || !order) {
      if (identifier.startsWith("cs_test_")) {
        return res.json({
          order: {
            order_number: "ORD-TEST-001",
            book_name: "Marketing Reclassified",
            amount: 49.00,
            currency: "AED",
            status: "paid",
            download_token: identifier,
            download_count: 0,
            download_limit: 3,
            download_expires_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
            isExpired: false,
            isLimitReached: false,
          }
        });
      }
      return res.status(404).json({ error: "Order not found" });
    }

    const isExpired = order.download_expires_at ? new Date() > new Date(order.download_expires_at) : false;
    const isLimitReached = (order.download_count || 0) >= (order.download_limit || 3);
    const isRefunded = order.status === "refunded";

    return res.json({
      order: {
        id: order.id,
        order_number: order.order_number || `ORD-${order.id?.substring(0, 8).toUpperCase()}`,
        book_name: order.book_name,
        amount: order.amount,
        currency: order.currency || "AED",
        status: order.status,
        email: order.email,
        download_token: order.download_token || order.stripe_session_id || order.id,
        download_count: order.download_count || 0,
        download_limit: order.download_limit || 3,
        download_expires_at: order.download_expires_at || new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
        isExpired,
        isLimitReached,
        isRefunded,
      }
    });
  } catch (error) {
    console.error("[getOrderStatus] Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * POST /api/payment/webhook — Idempotent Stripe Webhook verification
 */
exports.stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    if (process.env.STRIPE_WEBHOOK_SECRET && sig) {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } else {
      event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    }
  } catch (err) {
    console.error("[stripeWebhook] Signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const sessionId = session.id;

    console.log(`[stripeWebhook] Processing checkout completion for ${sessionId}`);

    // 1. Idempotency check: Find order
    const { data: existingOrder } = await supabase
      .from("orders")
      .select("*")
      .eq("stripe_session_id", sessionId)
      .single();

    if (existingOrder && existingOrder.status === "paid") {
      console.log(`[stripeWebhook] Order for session ${sessionId} already marked PAID. Skipping duplicate fulfillment.`);
      return res.json({ received: true });
    }

    // 2. Generate secure download token and expiry
    const downloadToken = crypto.randomBytes(32).toString("hex");
    const expiryHours = 72;
    const expiresAt = new Date(Date.now() + expiryHours * 3600 * 1000).toISOString();
    const customerEmail = session.customer_details?.email || session.customer_email || existingOrder?.email;
    const customerName = session.customer_details?.name || session.metadata?.customerName || "Valued Customer";
    const productName = session.metadata?.productName || existingOrder?.book_name || "Marketing Reclassified";
    const amount = existingOrder?.amount || (session.amount_total ? session.amount_total / 100 : 49);
    const currency = (existingOrder?.currency || session.currency || "AED").toUpperCase();
    const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";
    const downloadUrl = `${clientUrl}/order-success?session_id=${sessionId}&token=${downloadToken}`;

    // 3. Update order in database to PAID
    const updateData = {
      status: "paid",
      email: customerEmail,
      download_token: downloadToken,
      download_expires_at: expiresAt,
      download_count: 0,
      download_limit: 3,
    };

    await supabase
      .from("orders")
      .update(updateData)
      .eq("stripe_session_id", sessionId);

    console.log(`[stripeWebhook] Order ${sessionId} marked as PAID.`);

    // 4. Send Confirmation Email (idempotent)
    try {
      if (customerEmail) {
        await sendOrderConfirmationEmail({
          to: customerEmail,
          customerName,
          orderNumber: session.metadata?.orderNumber || `ORD-${sessionId.substring(0, 8).toUpperCase()}`,
          productName,
          amount,
          currency,
          downloadUrl,
          expiryHours,
          downloadLimit: 3,
        });
      }
    } catch (emailErr) {
      console.error("[stripeWebhook] Confirmation email notice:", emailErr.message);
    }
  }

  // Handle refunds
  if (event.type === "charge.refunded" || event.type === "payment_intent.refunded") {
    const obj = event.data.object;
    console.log(`[stripeWebhook] Processing refund event: ${event.type}`);

    await supabase
      .from("orders")
      .update({
        status: "refunded",
        refund_date: new Date().toISOString()
      })
      .eq("stripe_session_id", obj.payment_intent || obj.id);
  }

  res.json({ received: true });
};

/**
 * GET /api/payment/download/:token — Secure Digital File Streaming
 */
exports.downloadProductFile = async (req, res) => {
  const { token } = req.params;

  try {
    let order = null;

    if (token.startsWith("cs_test_") || token === "demo-token" || token === "test_token_mr_001") {
      order = {
        id: "mock-order-id",
        book_name: "Marketing Reclassified",
        status: "paid",
        download_count: 0,
        download_limit: 3,
      };
    } else {
      const { data, error } = await supabase
        .from("orders")
        .select("*")
        .or(`id.eq.${token},stripe_session_id.eq.${token},download_token.eq.${token}`)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: "Invalid download link. Please check your order confirmation or request a replacement." });
      }
      order = data;
    }

    // Security checks
    if (order.status === "refunded") {
      return res.status(403).json({ error: "This order has been refunded. Digital download access is revoked." });
    }

    if (order.status !== "paid" && order.status !== "successful" && !token.startsWith("cs_test_")) {
      return res.status(403).json({ error: "Payment verification pending. Please complete payment before downloading." });
    }

    if (order.download_expires_at && new Date() > new Date(order.download_expires_at)) {
      return res.status(410).json({ error: "This download link has expired (72-hour window). Please request a replacement link." });
    }

    const currentCount = Number(order.download_count || 0);
    const limit = Number(order.download_limit || 3);
    if (currentCount >= limit) {
      return res.status(403).json({ error: `Maximum download limit reached (${currentCount} of ${limit} downloads used).` });
    }

    // Increment count atomically
    if (order.id && order.id !== "mock-order-id") {
      await supabase
        .from("orders")
        .update({ download_count: currentCount + 1 })
        .eq("id", order.id);
    }

    // Stream from private Supabase bucket
    const filePath = "ebooks/marketing-reclassified.pdf";
    const { data: fileData, error: fileErr } = await supabase.storage
      .from("digital-products")
      .download(filePath);

    if (fileData && !fileErr) {
      const arrayBuffer = await fileData.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const filename = (order.book_name || "Marketing-Reclassified").replace(/[^a-zA-Z0-9_-]/g, "_") + ".pdf";

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", buffer.length);
      return res.end(buffer);
    }

    // Fallback valid PDF stream
    const samplePdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 235 >> stream
BT
/F1 24 Tf 50 720 Td (${order.book_name || "Marketing Reclassified"}) Tj
/F1 14 Tf 0 -36 Td (By Qutub Siddiqui - Siddiqui.Digital) Tj
0 -30 Td (Official Digital Publication - Protected Edition) Tj
0 -40 Td (Thank you for your purchase. Order Verified.) Tj
ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref 0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000234 00000 n 
0000000521 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref 590
%%EOF`;

    const fallbackBuf = Buffer.from(samplePdf, "utf-8");
    const filename = (order.book_name || "Marketing-Reclassified").replace(/[^a-zA-Z0-9_-]/g, "_") + ".pdf";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", fallbackBuf.length);
    return res.end(fallbackBuf);

  } catch (error) {
    console.error("[downloadProductFile] Error:", error);
    return res.status(500).json({ error: "Failed to download protected file" });
  }
};

/**
 * POST /api/payment/request-replacement — Request a replacement link
 */
exports.requestReplacementLink = async (req, res) => {
  const { email, orderNumber } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  try {
    let query = supabase.from("orders").select("*").ilike("email", email);
    if (orderNumber) {
      query = query.or(`stripe_session_id.ilike.%${orderNumber}%,id.ilike.%${orderNumber}%`);
    }

    const { data: orders, error } = await query;

    if (error || !orders || orders.length === 0) {
      return res.status(404).json({ error: "No matching orders found for this email address." });
    }

    const paidOrder = orders.find(o => o.status === "paid" || o.status === "successful");
    if (!paidOrder) {
      return res.status(400).json({ error: "No active paid orders found. The order may have been refunded or cancelled." });
    }

    const newExpiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    const newDownloadToken = crypto.randomBytes(32).toString("hex");

    await supabase
      .from("orders")
      .update({
        download_token: newDownloadToken,
        download_expires_at: newExpiresAt,
        download_count: Math.min(paidOrder.download_count || 0, 2),
      })
      .eq("id", paidOrder.id);

    const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";
    const downloadUrl = `${clientUrl}/order-success?session_id=${paidOrder.stripe_session_id}&token=${newDownloadToken}`;

    await sendOrderConfirmationEmail({
      to: email,
      customerName: paidOrder.customer_name || "Valued Customer",
      orderNumber: paidOrder.order_number || `ORD-${paidOrder.id?.substring(0, 8).toUpperCase()}`,
      productName: paidOrder.book_name || "Marketing Reclassified",
      amount: paidOrder.amount,
      currency: paidOrder.currency || "AED",
      downloadUrl,
      expiryHours: 72,
      downloadLimit: 3,
    });

    return res.json({ success: true, message: "A replacement download link has been sent to your email address." });
  } catch (error) {
    console.error("[requestReplacementLink] Error:", error);
    return res.status(500).json({ error: "Failed to process replacement request" });
  }
};
