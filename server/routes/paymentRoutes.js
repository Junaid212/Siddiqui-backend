// Updated paymentRoutes.js — with cart checkout, discount, and customer orders
// Copy this to: d:\Bright Media WORK\siddiqui-backend\server\routes\paymentRoutes.js
const express = require("express");
const router = express.Router();
const {
  getProducts,
  getProductById,
  createCheckoutSession,
  getOrderStatus,
  downloadProductFile,
  readOnlineBook,
  requestReplacementLink,
  stripeWebhook,
} = require("../controllers/paymentController");
const { validateDiscount } = require("../controllers/discountController");
const { createCartCheckout, getCustomerOrders, checkOwnership } = require("../controllers/cartController");

// Digital Products Catalog
router.get("/products", getProducts);
router.get("/products/:id", getProductById);
router.get("/ebooks", getProducts); // Backward compatibility

// Single-product Checkout Session (legacy — still used by BuyBookCheckout)
router.post("/create-checkout", createCheckoutSession);

// Multi-item Cart Checkout (new)
router.post("/create-cart-checkout", createCartCheckout);

// Discount Code Validation
router.post("/validate-discount", validateDiscount);

// Customer Order History & Ownership Verification
router.get("/my-orders", getCustomerOrders);
router.get("/check-ownership", checkOwnership);

// Order Status & Confirmation
router.get("/order-status/:identifier", getOrderStatus);

// Protected Online Reader Endpoint (in-browser view, no download)
router.get("/read/:token", readOnlineBook);
router.get("/read", readOnlineBook);

// Secure Download Endpoint
router.get("/download/:token", downloadProductFile);
router.get("/download", downloadProductFile);
router.get("/ebooks/download", downloadProductFile);
router.get("/ebooks/download/:token", downloadProductFile);

// Replacement Link Request
router.post("/request-replacement", requestReplacementLink);

// Stripe Webhook
router.post("/webhook", express.raw({ type: "application/json" }), stripeWebhook);
router.post("/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

module.exports = router;
