/**
 * webhookRoutes.js — Webhook endpoints for Payhip and PayPal
 *
 * Dedicated endpoints:
 *   POST /api/webhooks/payhip
 *   POST /api/webhooks/paypal
 *   POST /api/webhooks/stripe (backward compatibility)
 */

const express = require("express");
const router = express.Router();
const { payhipWebhook } = require("../controllers/payhipController");
const { paypalWebhook } = require("../controllers/paypalController");
const { stripeWebhook } = require("../controllers/paymentController");

// Payhip Webhook (paid, refunded)
router.post("/payhip", payhipWebhook);

// PayPal Webhook (PAYMENT.CAPTURE.COMPLETED, PENDING, DENIED, REFUNDED)
router.post("/paypal", paypalWebhook);

// Historical Stripe Webhook
router.post("/stripe", express.raw({ type: "application/json" }), stripeWebhook);

module.exports = router;
