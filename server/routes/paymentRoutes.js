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

// Secure Download Endpoint
router.get("/download/:token", downloadProductFile);

// Replacement Link Request
router.post("/request-replacement", requestReplacementLink);

// Stripe Webhook
router.post("/webhook", express.raw({ type: "application/json" }), stripeWebhook);

module.exports = router;
