const nodemailer = require("nodemailer");

function getTransporter() {
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.ipage.com",
    port: port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER || "no-reply@siddiqui.digital",
      pass: process.env.SMTP_PASS || "Noreply-siddiqui12",
    },
    tls: {
      rejectUnauthorized: false,
    },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

/**
 * Send generic purchase confirmation email with secure download link
 */
async function sendOrderConfirmationEmail({
  to,
  customerName,
  orderNumber,
  productName,
  amount,
  currency,
  downloadUrl,
  expiryHours = 72,
  downloadLimit = 3,
}) {
  if (!to) {
    console.warn("[orderEmail] No recipient email provided. Skipping email.");
    return;
  }

  const transporter = getTransporter();
  const formattedAmount = `${currency || "AED"} ${Number(amount || 0).toFixed(2)}`;
  const greetingName = customerName ? customerName.trim() : "Valued Customer";

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
                <p style="color:rgba(255,255,255,0.9);margin:8px 0 0 0;font-size:14px;font-weight:500;">Purchase Confirmation & Digital Delivery</p>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:36px 30px;">
                <h2 style="color:#ffffff;font-size:20px;margin:0 0 12px 0;">Thank you for your purchase, ${greetingName}!</h2>
                <p style="color:#a1a1aa;font-size:15px;line-height:1.6;margin:0 0 24px 0;">
                  Your payment for <strong>${productName}</strong> has been successfully verified. You can download your digital file immediately using the secure button below.
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
                    <td style="padding:6px 0;color:#a1a1aa;font-size:14px;">Format:</td>
                    <td style="padding:6px 0;color:#ffffff;font-size:14px;">Digital Edition (Protected PDF)</td>
                  </tr>
                </table>

                <!-- Download CTA Button -->
                <table width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom:28px;">
                  <tr>
                    <td align="center">
                      <a href="${downloadUrl}" style="display:inline-block;background:#c80808;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:16px 36px;border-radius:10px;box-shadow:0 10px 15px -3px rgba(200,8,8,0.4);">
                        ⬇️ Download ${productName}
                      </a>
                    </td>
                  </tr>
                </table>

                <!-- Security & Expiration Notice -->
                <div style="background-color:#1c1917;border-left:4px solid #f59e0b;padding:14px 16px;border-radius:4px;margin-bottom:24px;">
                  <p style="color:#fbbf24;margin:0;font-size:13px;font-weight:600;">Important Download Policy:</p>
                  <p style="color:#d6d3d1;margin:4px 0 0 0;font-size:12px;line-height:1.5;">
                    Your secure download link expires in <strong>${expiryHours} hours</strong> and allows up to <strong>${downloadLimit} downloads</strong>. Please save your file directly to your device after downloading.
                  </p>
                </div>

                <p style="color:#71717a;font-size:13px;line-height:1.6;margin:0;">
                  If you need assistance or encounter issues with your download, please reply directly to this email or contact us at <a href="mailto:info@siddiqui.digital" style="color:#c80808;text-decoration:none;">info@siddiqui.digital</a>.
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
      from: process.env.SMTP_FROM || '"Siddiqui Digital" <no-reply@siddiqui.digital>',
      replyTo: "info@siddiqui.digital",
      to,
      subject: `Purchase Confirmation - ${productName} (Order: ${orderNumber})`,
      html,
    });
    console.log(`[orderEmail] Confirmation email sent to ${to} (MessageId: ${info.messageId})`);
    return info;
  } catch (err) {
    console.error("[orderEmail] Failed to send confirmation email:", err);
    throw err;
  }
}

module.exports = {
  sendOrderConfirmationEmail,
};
