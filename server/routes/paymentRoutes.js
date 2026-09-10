const express = require("express");
const router = express.Router();
const {
  getProducts,
  getProductById,
  createCheckoutSession,
  getOrderStatus,
  downloadProductFile,
  requestReplacementLink,
  stripeWebhook,
} = require("../controllers/paymentController");

// Digital Products Catalog
router.get("/products", getProducts);
router.get("/products/:id", getProductById);
router.get("/ebooks", getProducts); // Backward compatibility

// Checkout Session Creation
router.post("/create-checkout", createCheckoutSession);

// Order Status & Confirmation
router.get("/order-status/:identifier", getOrderStatus);

// Secure Download Endpoint (supports /download/:token and /download?token=...)
router.get("/download/:token", downloadProductFile);
router.get("/download", downloadProductFile);
router.get("/ebooks/download", downloadProductFile);
router.get("/ebooks/download/:token", downloadProductFile);

// Replacement Link Request
router.post("/request-replacement", requestReplacementLink);

// Stripe Webhook (supports /webhook and /stripe/webhook)
router.post("/webhook", express.raw({ type: "application/json" }), stripeWebhook);
router.post("/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

module.exports = router;
