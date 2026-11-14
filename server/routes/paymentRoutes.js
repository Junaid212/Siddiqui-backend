const express = require("express");
const router = express.Router();
const {
  getProducts,
  getProductById,
  getOrderStatus,
  downloadProductFile,
  readOnlineBook,
  createAccessLink,
  serveAccessLink,
  requestReplacementLink,
  stripeWebhook,
} = require("../controllers/paymentController");
const { validateDiscount } = require("../controllers/discountController");
const { getCustomerOrders, checkOwnership } = require("../controllers/cartController");
const { createPayPalOrder, capturePayPalOrder, paypalWebhook } = require("../controllers/paypalController");
const { payhipWebhook, claimPayhipPurchase, confirmPayhipClaim } = require("../controllers/payhipController");
const { requireCustomer } = require("../utils/requireCustomer");

// Digital Products Catalog
router.get("/products", getProducts);
router.get("/products/:id", getProductById);
router.get("/ebooks", getProducts); // Backward compatibility

// PayPal Checkout (Orders v2 API)
router.post("/paypal/create-order", createPayPalOrder);
router.post("/paypal/capture-order", capturePayPalOrder);
router.post("/paypal/webhook", paypalWebhook);
router.post("/webhooks/paypal", paypalWebhook);

// Payhip Webhook & Secure Account Linking
router.post("/payhip/webhook", payhipWebhook);
router.post("/webhooks/payhip", payhipWebhook);
router.post("/claim-payhip-purchase", claimPayhipPurchase);
router.post("/confirm-payhip-claim", confirmPayhipClaim);

// Unified Checkout Endpoints (Routes to PayPal Orders v2 with server-side validation)
router.post("/create-order", createPayPalOrder);
router.post("/capture-order", capturePayPalOrder);
router.post("/create-checkout", createPayPalOrder);
router.post("/create-cart-checkout", createPayPalOrder);

// Discount Code Validation
router.post("/validate-discount", validateDiscount);

// Customer Order History & Ownership Verification (signed-in customers only; identity comes from the session)
router.get("/my-orders", requireCustomer, getCustomerOrders);
router.get("/check-ownership", requireCustomer, checkOwnership);

// Order Status & Confirmation (Unified for PayPal, Payhip, Stripe, and tokens)
router.get("/order-status/:identifier", getOrderStatus);

// Protected Online Reader Endpoint (in-browser view, no download)
router.get("/read/:token", readOnlineBook);
router.get("/read", readOnlineBook);

// Short-lived, order-bound links for signed-in customers (My Orders). No reusable credential is ever listed.
router.post("/orders/:id/access-link", requireCustomer, createAccessLink);
router.get("/access/:signed", serveAccessLink);

// Secure Download Endpoint (Digital Companion Edition with valid license)
router.get("/download/:token", downloadProductFile);
router.get("/download", downloadProductFile);
router.get("/ebooks/download", downloadProductFile);
router.get("/ebooks/download/:token", downloadProductFile);

// Replacement Link Request
router.post("/request-replacement", requestReplacementLink);

// Historical Stripe Webhook (preserved for backward compatibility)
router.post("/webhook", express.raw({ type: "application/json" }), stripeWebhook);
router.post("/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

module.exports = router;
