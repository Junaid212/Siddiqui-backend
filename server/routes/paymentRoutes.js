const express = require("express");
const router = express.Router();
const {
    getEbooks,
    createCheckoutSession,
    getOrderStatus,
    stripeWebhook,
} = require("../controllers/paymentController");

// Ebook catalog
router.get("/ebooks", getEbooks);

// Create Stripe checkout session
router.post("/create-checkout", createCheckoutSession);

// Check order status
router.get("/order-status/:sessionId", getOrderStatus);

// Stripe webhook (raw body is handled in server.js)
router.post("/webhook", express.raw({ type: "application/json" }), stripeWebhook);

module.exports = router;