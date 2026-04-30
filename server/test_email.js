require('dotenv').config({ path: 'd:/Bright Media WORK/siddiqui-backend/server/.env' });
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false
  }
});

async function testEmail() {
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: 'no-reply@siddiqui.digital',
      subject: "Test Email from Siddiqui Digital",
      text: "This is a test email to verify SMTP configuration.",
    });
    console.log("Email sent successfully: ", info.messageId);
  } catch (error) {
    console.error("Error sending email: ", error);
  }
}

testEmail();
