const nodemailer = require("nodemailer");

const escapeHtml = (value = "") => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

function getTransporter() {
  const port = Number.parseInt(process.env.SMTP_PORT, 10) || 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
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

exports.submitContact = async (req, res) => {
  const { name, email, subject = "", message = "" } = req.body || {};

  if (!name?.trim() || !email?.trim()) {
    return res.status(400).json({ error: "Name and email are required." });
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.ADMIN_EMAIL) {
    return res.status(503).json({ error: "Email service is not configured." });
  }

  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM,
      replyTo: email.trim(),
      to: process.env.ADMIN_EMAIL,
      subject: `Website contact: ${escapeHtml(subject.trim() || "No subject")}`,
      html: `
        <h2>New website contact message</h2>
        <p><strong>Name:</strong> ${escapeHtml(name.trim())}</p>
        <p><strong>Email:</strong> ${escapeHtml(email.trim())}</p>
        <p><strong>Subject:</strong> ${escapeHtml(subject.trim() || "No subject")}</p>
        <p><strong>Message:</strong></p>
        <p>${escapeHtml(message.trim() || "No message provided.").replace(/\n/g, "<br>")}</p>
      `,
    });

    return res.status(201).json({ success: true, message: "Message delivered." });
  } catch (error) {
    console.error("Contact email delivery failed:", error.message);
    return res.status(502).json({ error: "Unable to deliver your message. Please try again later." });
  }
};
