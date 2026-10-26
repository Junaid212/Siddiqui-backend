const nodemailer = require("nodemailer");

function getTransporter() {
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

/**
 * Send order confirmation email tailored by edition:
 * $20 Edition: "You will receive access to read online."
 * $49.99 Edition: "You will receive online access and your download links."
 */
async function sendOrderConfirmationEmail({
  to,
  customerName,
  orderNumber,
  productName,
  amount,
  currency,
  downloadUrl,
  readerUrl,
  editionType = "companion", // "online" | "companion"
  expiryHours = 72,
  downloadLimit = 3,
}) {
  if (!to) {
    console.warn("[orderEmail] No recipient email provided. Skipping email.");
    return;
  }

  const transporter = getTransporter();
  const formattedAmount = `${currency || "USD"} ${Number(amount || 0).toFixed(2)}`;
  const greetingName = customerName ? customerName.trim() : "Valued Customer";
  const clientUrl = process.env.CLIENT_URL || "https://siddiqui.digital";
  const onlineReaderLink = readerUrl || `${clientUrl}/my-orders`;

  const isOnlineOnly = editionType === "online" || Number(amount) < 30 && !String(productName).toLowerCase().includes("companion");
  const deliveryHeadline = isOnlineOnly
    ? "You will receive access to read online."
    : "You will receive online access and your download links.";

  const formatText = isOnlineOnly
    ? "Online Reading Edition (Account Access)"
    : "Digital Companion Edition (Online Access + Downloadable PDF + Companion Pack)";

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>Purchase Confirmation</title>
  </head>
  <body style="margin:0;padding:0;background-color:#0f0f12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e4e4e7;">
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#0f0f12;padding:40px 20px;">
      <tr>
        <td align="center">
          <table width="600" border="0" cellspacing="0" cellpadding="0" style="background-color:#18181b;border-radius:16px;overflow:hidden;border:1px solid #27272a;box-shadow:0 20px 25px -5px rgba(0,0,0,0.5);">
            <!-- Header -->
            <tr>
              <td style="background:linear-gradient(135deg,#c80808 0%,#990000 100%);padding:36px 30px;text-align:center;">
                <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">Siddiqui.Digital</h1>
                <p style="color:rgba(255,255,255,0.9);margin:8px 0 0 0;font-size:14px;font-weight:500;">Purchase Confirmation & Digital Access</p>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:36px 30px;">
                <h2 style="color:#ffffff;font-size:20px;margin:0 0 12px 0;">Thank you for your purchase, ${greetingName}!</h2>
                
                <div style="background:#27272a;border-left:4px solid #c80808;padding:14px 18px;border-radius:6px;margin:18px 0 24px 0;">
                  <strong style="color:#ffffff;font-size:15px;display:block;">${deliveryHeadline}</strong>
                </div>

                <p style="color:#a1a1aa;font-size:15px;line-height:1.6;margin:0 0 24px 0;">
                  Your payment for <strong>${productName}</strong> has been successfully verified.
                </p>

                <!-- Order Details Box -->
                <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#27272a;border-radius:12px;padding:20px;margin-bottom:28px;">
                  <tr>
                    <td style="padding:6px 0;color:#a1a1aa;font-size:14px;width:140px;">Order Number:</td>
                    <td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:700;font-family:monospace;">${orderNumber}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;color:#a1a1aa;font-size:14px;">Product:</td>
                    <td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600;">${productName}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;color:#a1a1aa;font-size:14px;">Amount Paid:</td>
                    <td style="padding:6px 0;color:#10b981;font-size:15px;font-weight:700;">${formattedAmount}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;color:#a1a1aa;font-size:14px;">Access Format:</td>
                    <td style="padding:6px 0;color:#ffffff;font-size:14px;">${formatText}</td>
                  </tr>
                </table>

                <!-- Action Buttons -->
                <table width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom:28px;">
                  <tr>
                    <td align="center">
                      ${!isOnlineOnly && downloadUrl ? `
                        <a href="${downloadUrl}" style="display:inline-block;background:#c80808;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 28px;border-radius:8px;margin-right:10px;margin-bottom:10px;">
                          ⬇️ Download PDF Publication
                        </a>
                      ` : ""}
                      <a href="${onlineReaderLink}" style="display:inline-block;background:#27272a;color:#ffffff;border:1px solid #3f3f46;text-decoration:none;font-size:15px;font-weight:700;padding:14px 28px;border-radius:8px;margin-bottom:10px;">
                        📖 Access Online Reader
                      </a>
                    </td>
                  </tr>
                </table>

                ${!isOnlineOnly ? `
                  <!-- Expiration Notice for Downloads -->
                  <div style="background-color:#1c1917;border-left:4px solid #f59e0b;padding:14px 16px;border-radius:4px;margin-bottom:24px;">
                    <p style="color:#fbbf24;margin:0;font-size:13px;font-weight:600;">Download Information:</p>
                    <p style="color:#d6d3d1;margin:4px 0 0 0;font-size:12px;line-height:1.5;">
                      Your personal PDF download link remains active for <strong>${expiryHours} hours</strong> (up to ${downloadLimit} downloads). You can access the online reader anytime through your account.
                    </p>
                  </div>
                ` : `
                  <!-- Online Access Instructions -->
                  <div style="background-color:#182234;border-left:4px solid #3b82f6;padding:14px 16px;border-radius:4px;margin-bottom:24px;">
                    <p style="color:#60a5fa;margin:0;font-size:13px;font-weight:600;">Online Reading Access:</p>
                    <p style="color:#cbd5e1;margin:4px 0 0 0;font-size:12px;line-height:1.5;">
                      Your book has been saved to your reader account. Sign in using your email or Google account anytime at <a href="${clientUrl}/login" style="color:#60a5fa;">${clientUrl}/login</a>.
                    </p>
                  </div>
                `}

                <p style="color:#71717a;font-size:13px;line-height:1.6;margin:0;">
                  Need assistance? Contact us anytime at <a href="mailto:info@siddiqui.digital" style="color:#c80808;text-decoration:none;">info@siddiqui.digital</a>.
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background-color:#121215;padding:20px 30px;text-align:center;border-top:1px solid #27272a;">
                <p style="color:#52525b;font-size:12px;margin:0;">
                  © ${new Date().getFullYear()} Siddiqui.Digital. All rights reserved.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || '"Siddiqui.Digital" <info@siddiqui.digital>',
      replyTo: "info@siddiqui.digital",
      to,
      subject: `Purchase Confirmation - ${productName} (${orderNumber})`,
      html,
    });
    console.log(`[orderEmail] Confirmation email sent to ${to} (MessageId: ${info.messageId})`);
    return info;
  } catch (err) {
    console.error("[orderEmail] Error sending confirmation email:", err.message);
  }
}

/**
 * Send "Set your password" email for automatic account creation on manual checkout
 */
async function sendSetPasswordEmail({ to, customerName, setPasswordLink, editionType }) {
  if (!to || !setPasswordLink) return;
  const transporter = getTransporter();
  const greetingName = customerName ? customerName.trim() : "Valued Customer";

  const html = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"></head>
  <body style="margin:0;padding:0;background-color:#0f0f12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e4e4e7;">
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="padding:40px 20px;">
      <tr>
        <td align="center">
          <table width="560" border="0" cellspacing="0" cellpadding="0" style="background-color:#18181b;border-radius:14px;border:1px solid #27272a;padding:34px;">
            <tr>
              <td style="text-align:center;padding-bottom:24px;">
                <h1 style="color:#c80808;margin:0;font-size:22px;letter-spacing:1px;text-transform:uppercase;">Siddiqui.Digital</h1>
                <p style="color:#ffffff;font-size:18px;font-weight:700;margin:12px 0 0 0;">Welcome! Set Your Reader Password</p>
              </td>
            </tr>
            <tr>
              <td>
                <p style="color:#d4d4d8;font-size:15px;line-height:1.6;">
                  Hello ${greetingName},
                </p>
                <p style="color:#a1a1aa;font-size:14px;line-height:1.6;">
                  Thank you for your purchase on <strong>Siddiqui.Digital</strong>. We have created a reader account for your email (<strong>${to}</strong>) so you can log in, read online, and manage your editions anytime.
                </p>
                <p style="color:#a1a1aa;font-size:14px;line-height:1.6;">
                  Please click the secure button below to set your password and access your account:
                </p>
                <div style="text-align:center;margin:30px 0;">
                  <a href="${setPasswordLink}" style="background:#c80808;color:#ffffff;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px;text-decoration:none;display:inline-block;">
                    Set Your Reader Password
                  </a>
                </div>
                <p style="color:#71717a;font-size:12px;line-height:1.5;">
                  If you previously signed in or prefer to use Google in the future with this email, you can also sign in directly using Google without needing a password.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"Siddiqui.Digital" <info@siddiqui.digital>',
      replyTo: "info@siddiqui.digital",
      to,
      subject: "Set your reader password — Siddiqui.Digital",
      html,
    });
    console.log(`[orderEmail] Set-password welcome email sent to ${to}`);
  } catch (err) {
    console.error("[orderEmail] Set-password email error:", err.message);
  }
}


async function sendPartialRefundAdminNotification({
  transactionId,
  buyerEmail,
  orderNumber,
  bookName,
  originalAmount,
  refundAmount,
  currency,
  reason
}) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER || "info@siddiqui.digital";
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"Siddiqui.Digital Alerts" <info@siddiqui.digital>',
      to: adminEmail,
      subject: `[ALERT] Partial Refund on Payhip Order: ${orderNumber || transactionId}`,
      html: `
        <h3>Partial Refund Notification</h3>
        <p>A partial refund was recorded on Payhip. Customer digital access has been <strong>preserved</strong>.</p>
        <ul>
          <li><strong>Transaction ID:</strong> ${transactionId}</li>
          <li><strong>Order Number:</strong> ${orderNumber || "N/A"}</li>
          <li><strong>Customer:</strong> ${buyerEmail}</li>
          <li><strong>Item:</strong> ${bookName || "Digital Book"}</li>
          <li><strong>Original Amount:</strong> ${currency || "USD"} ${originalAmount || "N/A"}</li>
          <li><strong>Refunded Amount:</strong> ${currency || "USD"} ${refundAmount || "N/A"}</li>
          <li><strong>Reason:</strong> ${reason || "Partial refund processed via Payhip"}</li>
        </ul>
      `,
    });
    console.log(`[orderEmail] Partial refund admin notification sent to ${adminEmail}`);
  } catch (err) {
    console.warn(`[orderEmail] Failed to send partial refund admin notification:`, err.message);
  }
}

module.exports = {
  sendPartialRefundAdminNotification,
  sendOrderConfirmationEmail,
  sendSetPasswordEmail,
};
