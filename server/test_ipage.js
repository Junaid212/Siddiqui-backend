const nodemailer = require("nodemailer");

async function test(port, secure, pass) {
    let transporter = nodemailer.createTransport({
        host: "smtp.ipage.com",
        port: port,
        secure: secure,
        auth: {
            user: "no-reply@siddiqui.digital",
            pass: pass,
        },
        tls: {
            rejectUnauthorized: false
        }
    });

    try {
        await transporter.verify();
        console.log(`SUCCESS with port ${port}, secure ${secure}, pass ${pass}`);
    } catch (e) {
        console.log(`FAILED with port ${port}, secure ${secure}, pass ${pass}:`, e.message);
    }
}

async function run() {
    await test(465, true, "Noreply-siddiqui12");
    await test(465, true, "NO-reply-sd-1234-@");
    await test(587, false, "Noreply-siddiqui12");
    await test(587, false, "NO-reply-sd-1234-@");
}

run();
