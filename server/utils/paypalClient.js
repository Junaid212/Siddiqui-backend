/**
 * paypalClient.js — PayPal Orders v2 REST API & Webhook Verification Helper
 *
 * Implements server-side PayPal checkout according to official PayPal specifications:
 * - OAuth 2.0 Client Credentials token management with caching
 * - Orders v2 API: createOrder & captureOrder
 * - Webhook signature verification API (/v1/notifications/verify-webhook-signature)
 *
 * Private credentials stay strictly on the backend.
 */

const crypto = require("crypto");
require("dotenv").config();

let cachedToken = null;
let tokenExpiresAt = 0;

function getPayPalBaseUrl() {
  const mode = (process.env.PAYPAL_MODE || "sandbox").toLowerCase();
  return mode === "live" || mode === "production"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const clientId = (process.env.PAYPAL_CLIENT_ID || "").trim();
  const clientSecret = (process.env.PAYPAL_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret || clientId.includes("placeholder") || clientSecret.includes("placeholder")) {
    throw new Error("PayPal Client ID and Secret are not configured in environment variables.");
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const baseUrl = getPayPalBaseUrl();

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[PayPal] Token request failed:", response.status, errorText);
    throw new Error(`Failed to obtain PayPal access token: ${response.statusText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return cachedToken;
}

async function createOrder(orderPayload, idempotencyKey = null) {
  const token = await getAccessToken();
  const baseUrl = getPayPalBaseUrl();
  const requestId = idempotencyKey || crypto.randomUUID();

  const response = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": requestId,
    },
    body: JSON.stringify(orderPayload),
  });

  const responseData = await response.json();
  if (!response.ok) {
    console.error("[PayPal] Order creation failed:", response.status, responseData);
    const issue = responseData.details?.[0]?.description || responseData.message || response.statusText;
    throw new Error(`PayPal order creation failed: ${issue}`);
  }

  return responseData;
}

async function captureOrder(orderId, idempotencyKey = null) {
  if (!orderId) throw new Error("PayPal order ID is required for capture.");
  const token = await getAccessToken();
  const baseUrl = getPayPalBaseUrl();
  const requestId = idempotencyKey || crypto.randomUUID();

  const response = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": requestId,
    },
  });

  const responseData = await response.json();
  if (!response.ok) {
    console.error(`[PayPal] Order capture failed for ${orderId}:`, response.status, responseData);
    const issue = responseData.details?.[0]?.description || responseData.message || response.statusText;
    const err = new Error(`PayPal order capture failed: ${issue}`);
    err.details = responseData;
    err.status = response.status;
    throw err;
  }

  return responseData;
}

async function getOrderDetails(orderId) {
  if (!orderId) throw new Error("PayPal order ID is required.");
  const token = await getAccessToken();
  const baseUrl = getPayPalBaseUrl();

  const response = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const responseData = await response.json();
  if (!response.ok) {
    throw new Error(`Failed to fetch PayPal order: ${responseData.message || response.statusText}`);
  }

  return responseData;
}

async function verifyWebhookSignature(headers, rawBody) {
  try {
    const webhookId = (process.env.PAYPAL_WEBHOOK_ID || "").trim();

    const authAlgo = headers["paypal-auth-algo"] || headers["PAYPAL-AUTH-ALGO"];
    const certUrl = headers["paypal-cert-url"] || headers["PAYPAL-CERT-URL"];
    const transmissionId = headers["paypal-transmission-id"] || headers["PAYPAL-TRANSMISSION-ID"];
    const transmissionSig = headers["paypal-transmission-sig"] || headers["PAYPAL-TRANSMISSION-SIG"];
    const transmissionTime = headers["paypal-transmission-time"] || headers["PAYPAL-TRANSMISSION-TIME"];

    if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
      console.warn("[PayPal Webhook] Missing required PayPal signature headers.");
      return false;
    }

    if (!webhookId || webhookId.includes("placeholder")) {
      console.warn("[PayPal Webhook] PAYPAL_WEBHOOK_ID is not configured in server environment.");
      return false;
    }

    const token = await getAccessToken();
    const baseUrl = getPayPalBaseUrl();

    const webhookEvent = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;

    const verificationPayload = {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: webhookEvent,
    };

    const response = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(verificationPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[PayPal Webhook] Verification API request failed:", response.status, errorText);
      return false;
    }

    const result = await response.json();
    return result.verification_status === "SUCCESS";
  } catch (err) {
    console.warn("[PayPal Webhook] Signature verification caught error:", err.message);
    return false;
  }
}

module.exports = {
  getPayPalBaseUrl,
  getAccessToken,
  createOrder,
  captureOrder,
  getOrderDetails,
  verifyWebhookSignature,
};
