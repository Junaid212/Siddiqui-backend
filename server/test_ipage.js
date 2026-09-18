const nodemailer = require("nodemailer");
require("dotenv").config();

async function test(port, secure, pass) {
    let transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: port,
        secure: secure,
        auth: {
            user: process.env.SMTP_USER,
            pass: pass,
        },
    });

    try {
        await transporter.verify();
        console.log(`SUCCESS with port ${port}, secure ${secure}`);
    } catch (e) {
        console.log(`FAILED with port ${port}, secure ${secure}:`, e.message);
    }
}

async function run() {
    const port = Number.parseInt(process.env.SMTP_PORT, 10) || 465;
    await test(port, port === 465, process.env.SMTP_PASS);
}

run();
