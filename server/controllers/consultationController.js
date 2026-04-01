const supabase = require("../config/supabaseClient");
const nodemailer = require("nodemailer");
const generateICS = require("../utils/createCalendarInvite");

// Nodemailer transport setup
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send confirmation email to user with ICS calendar invite
 */
const sendConfirmationEmail = async (email, date, time, name) => {
  const icsFile = await generateICS(date, time, email);

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: "Consultation Confirmation - Siddiqui Digital",
    html: `
    <div style="font-family:Arial,sans-serif;padding:20px;max-width:600px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#ef4444,#dc2626);padding:30px;border-radius:12px 12px 0 0;text-align:center">
        <h2 style="color:#fff;margin:0;font-size:24px">✅ Consultation Confirmed</h2>
      </div>
      <div style="background:#fff;padding:30px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px">
        <p style="font-size:16px;color:#333">Hello <b>${name}</b>,</p>
        <p style="color:#555">Your consultation has been successfully booked. Here are your details:</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#f9fafb;border-radius:8px;overflow:hidden">
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:12px 16px;font-weight:bold;color:#333;width:100px">📅 Date</td>
            <td style="padding:12px 16px;color:#555">${date}</td>
          </tr>
          <tr>
            <td style="padding:12px 16px;font-weight:bold;color:#333">🕐 Time</td>
            <td style="padding:12px 16px;color:#555">${time}</td>
          </tr>
        </table>
        <p style="color:#555">You can add this meeting to your calendar using the attached <b>.ics</b> file.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
        <p style="color:#999;font-size:13px">Regards,<br><b>Siddiqui Digital</b></p>
      </div>
    </div>
    `,
    attachments: [
      {
        filename: "consultation.ics",
        content: icsFile,
      },
    ],
  });
};

/**
 * Send notification email to admin about new booking
 */
const sendAdminNotification = async (name, email, phone, date, time, message) => {
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: process.env.ADMIN_EMAIL,
    subject: `New Consultation Booked: ${name}`,
    html: `
    <div style="font-family:Arial,sans-serif;padding:20px;max-width:600px;margin:0 auto">
      <h3 style="color:#ef4444">📋 New Consultation Booking</h3>
      <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;overflow:hidden">
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 16px;font-weight:bold">Name</td>
          <td style="padding:10px 16px">${name}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 16px;font-weight:bold">Email</td>
          <td style="padding:10px 16px">${email}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 16px;font-weight:bold">Phone</td>
          <td style="padding:10px 16px">${phone || 'N/A'}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 16px;font-weight:bold">Date</td>
          <td style="padding:10px 16px">${date}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 16px;font-weight:bold">Time</td>
          <td style="padding:10px 16px">${time}</td>
        </tr>
        <tr>
          <td style="padding:10px 16px;font-weight:bold">Message</td>
          <td style="padding:10px 16px">${message || 'N/A'}</td>
        </tr>
      </table>
    </div>
    `,
  });
};

// ─── Book a consultation ─────────────────────────────────────────────
exports.bookConsultation = async (req, res) => {
  // Accept both naming conventions for backward compatibility
  const {
    userId,
    name,
    email,
    phone,
    date: dateField,
    time: timeField,
    selected_date,
    selected_time,
    message,
  } = req.body;

  const date = dateField || selected_date;
  const time = timeField || selected_time;

  if (!date || !time) {
    return res.status(400).json({ error: "Date and time are required" });
  }

  if (!name || !email) {
    return res.status(400).json({ error: "Name and email are required" });
  }

  try {
    // 1. Check if the time slot is already booked on that date
    const { data: existing } = await supabase
      .from("consultations")
      .select("id")
      .eq("date", date)
      .eq("time", time)
      .eq("status", "booked")
      .single();

    if (existing) {
      return res
        .status(409)
        .json({ error: "This time slot is already booked. Please choose another time." });
    }

    // 2. Insert booking into database
    let payload = {
      user_id: userId || null,
      name,
      email,
      phone: phone || null,
      date,
      time,
      message: message || null,
      status: "booked",
      email_sent: false,
    };

    let { data, error } = await supabase
      .from("consultations")
      .insert([payload])
      .select()
      .single();

    let hasEmailSentColumn = true;

    // Graceful fallback if email_sent column is missing
    if (error && (error.message.includes('email_sent') || error.code === '42703')) {
      delete payload.email_sent;
      const fallback = await supabase.from("consultations").insert([payload]).select().single();
      data = fallback.data;
      error = fallback.error;
      hasEmailSentColumn = false;
      console.warn('⚠️ "email_sent" column missing in Supabase! Proceeding without email tracking.');
    }

    if (error) return res.status(400).json({ error: error.message });

    // 3. Send confirmation emails (don't fail the booking if email fails)
    if (email) {
      try {
        await sendConfirmationEmail(email, date, time, name);
        await sendAdminNotification(name, email, phone, date, time, message);

        // 4. Update email_sent = true after successful send (ONLY if column exists)
        if (hasEmailSentColumn) {
          await supabase
            .from("consultations")
            .update({ email_sent: true })
            .eq("id", data.id);
        }

        console.log("📧 Confirmation emails sent successfully for booking:", data.id);
      } catch (mailError) {
        console.error("❌ Failed to send email:", mailError.message);
        require('fs').appendFileSync('mail_error.log', new Date().toISOString() + ' - ' + mailError.stack + '\n');
        // Booking is still saved with email_sent = false
      }
    }

    res.json({
      success: true,
      message: "Consultation booked successfully!",
      consultation: data,
    });
  } catch (error) {
    console.error("Booking error:", error);
    res.status(500).json({ error: error.message });
  }
};

// ─── Get available time slots for a date ─────────────────────────────
exports.getAvailableSlots = async (req, res) => {
  const { date } = req.query;

  const allSlots = [
    "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
    "12:00", "12:30", "13:00", "13:30", "14:00", "14:30",
    "15:00", "15:30", "16:00", "16:30", "17:00",
  ];

  if (!date) {
    return res.json({ slots: allSlots });
  }

  try {
    const { data: bookedSlots, error } = await supabase
      .from("consultations")
      .select("time")
      .eq("date", date)
      .eq("status", "booked");

    if (error) return res.status(400).json({ error: error.message });

    const bookedTimes = bookedSlots.map((s) => s.time.substring(0, 5));
    const availableSlots = allSlots.filter((slot) => !bookedTimes.includes(slot));

    res.json({ date, slots: availableSlots, bookedSlots: bookedTimes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ─── Get all consultations (for admin panel) ─────────────────────────
exports.getAllConsultations = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("consultations")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    res.json({ consultations: data || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ─── Get consultations for a specific user ───────────────────────────
exports.getConsultations = async (req, res) => {
  const { userId } = req.params;

  try {
    const { data, error } = await supabase
      .from("consultations")
      .select("*")
      .eq("user_id", userId)
      .order("date", { ascending: true });

    if (error) return res.status(400).json({ error: error.message });

    res.json({ consultations: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ─── Get count of emails successfully sent ───────────────────────────
exports.getEmailSentCount = async (req, res) => {
  try {
    const { count, error } = await supabase
      .from("consultations")
      .select("*", { count: "exact", head: true })
      .eq("email_sent", true);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ count: count || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ─── Delete a consultation ───────────────────────────────────────────
exports.deleteConsultation = async (req, res) => {
  try {
    const { error } = await supabase
      .from("consultations")
      .delete()
      .eq("id", req.params.id);

    if (error) return res.status(500).json({ error: error.message });

    res.json({ message: "Consultation deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};