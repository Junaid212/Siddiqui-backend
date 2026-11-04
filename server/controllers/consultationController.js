const supabase = require("../config/supabaseClient");
const nodemailer = require("nodemailer");
const generateICS = require("../utils/createCalendarInvite");
const {
  ALLOWED_SLOTS,
  normalizeTime,
  normalizeDate,
  isActiveStatus,
  escapeHtml,
  validateBookingInput,
  slotKey,
} = require("../utils/consultationRules");

const inflightSlots = new Set();

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

const sendConfirmationEmail = async (email, date, time, name) => {
  const icsFile = await generateICS(date, time, email);
  const transporter = getTransporter();
  const safeName = escapeHtml(name);

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    replyTo: "info@siddiqui.digital",
    to: email,
    subject: "Consultation Confirmation - Siddiqui Digital",
    html: `
    <div style="font-family:Arial,sans-serif;padding:20px;max-width:600px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#ef4444,#dc2626);padding:30px;border-radius:12px 12px 0 0;text-align:center">
        <h2 style="color:#fff;margin:0;font-size:24px">✅ Consultation Confirmed</h2>
      </div>
      <div style="background:#fff;padding:30px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px">
        <p style="font-size:16px;color:#333">Hello <b>${safeName}</b>,</p>
        <p style="color:#555">Your consultation has been successfully booked. Here are your details:</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#f9fafb;border-radius:8px;overflow:hidden">
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:12px 16px;font-weight:bold;color:#333;width:100px">📅 Date</td>
            <td style="padding:12px 16px;color:#555">${escapeHtml(date)}</td>
          </tr>
          <tr>
            <td style="padding:12px 16px;font-weight:bold;color:#333">🕐 Time</td>
            <td style="padding:12px 16px;color:#555">${escapeHtml(time)}</td>
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

const sendAdminNotification = async (name, email, phone, date, time, message) => {
  const transporter = getTransporter();

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: process.env.ADMIN_EMAIL,
    subject: `New Consultation Booked: ${String(name).replace(/[\r\n]/g, " ")}`,
    html: `
    <div style="font-family:Arial,sans-serif;padding:20px;max-width:600px;margin:0 auto">
      <h3 style="color:#ef4444">📋 New Consultation Booking</h3>
      <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;overflow:hidden">
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 16px;font-weight:bold">Name</td>
          <td style="padding:10px 16px">${escapeHtml(name)}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 16px;font-weight:bold">Email</td>
          <td style="padding:10px 16px">${escapeHtml(email)}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 16px;font-weight:bold">Phone</td>
          <td style="padding:10px 16px">${escapeHtml(phone || "N/A")}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 16px;font-weight:bold">Date</td>
          <td style="padding:10px 16px">${escapeHtml(date)}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 16px;font-weight:bold">Time</td>
          <td style="padding:10px 16px">${escapeHtml(time)}</td>
        </tr>
        <tr>
          <td style="padding:10px 16px;font-weight:bold">Message</td>
          <td style="padding:10px 16px">${escapeHtml(message || "N/A")}</td>
        </tr>
      </table>
    </div>
    `,
  });
};

function collectBookedTimes(rows = []) {
  const booked = new Set();
  rows.forEach((row) => {
    if (!isActiveStatus(row.status)) return;
    const time = normalizeTime(row.time || row.selected_time);
    if (time) booked.add(time);
  });
  return [...booked];
}

async function findActiveBookings(date, time) {
  const normalizedDate = normalizeDate(date);
  const normalizedTime = time ? normalizeTime(time) : null;

  const { data, error } = await supabase
    .from("consultations")
    .select("id, date, time, selected_date, selected_time, status, created_at")
    .or(`date.eq.${normalizedDate},selected_date.eq.${normalizedDate}`);

  if (error) return { data: [], error };

  const matches = (data || []).filter((row) => {
    if (!isActiveStatus(row.status)) return false;
    const rowDate = normalizeDate(row.date || row.selected_date);
    if (rowDate !== normalizedDate) return false;
    if (!normalizedTime) return true;
    return normalizeTime(row.time || row.selected_time) === normalizedTime;
  });

  return { data: matches, error: null };
}

async function insertConsultation(payload) {
  let hasEmailSentColumn = true;
  let { data, error } = await supabase
    .from("consultations")
    .insert([payload])
    .select()
    .single();

  if (error && (String(error.message || "").includes("email_sent") || error.code === "42703")) {
    const fallbackPayload = { ...payload };
    delete fallbackPayload.email_sent;
    const fallback = await supabase.from("consultations").insert([fallbackPayload]).select().single();
    data = fallback.data;
    error = fallback.error;
    hasEmailSentColumn = false;
    console.warn('⚠️ "email_sent" column missing in Supabase! Proceeding without email tracking.');
  }

  return { data, error, hasEmailSentColumn };
}

exports.bookConsultation = async (req, res) => {
  const validated = validateBookingInput(req.body);
  if (!validated.ok) {
    return res.status(validated.status).json({ error: validated.error });
  }

  const { name, email, phone, message, date, time, userId } = validated.value;
  const lockKey = slotKey(date, time);

  if (inflightSlots.has(lockKey)) {
    return res.status(409).json({ error: "This time slot is already booked. Please choose another time." });
  }

  inflightSlots.add(lockKey);
  let userEmailSent = false;
  let adminEmailSent = false;

  try {
    const existing = await findActiveBookings(date, time);
    if (existing.error) {
      return res.status(400).json({ error: existing.error.message });
    }
    if (existing.data.length > 0) {
      return res.status(409).json({ error: "This time slot is already booked. Please choose another time." });
    }

    const payload = {
      user_id: userId || null,
      name,
      email,
      phone: phone || null,
      date,
      time,
      selected_date: date,
      selected_time: time,
      message: message || null,
      status: "booked",
      consultant: "Muhammad.Q.Siddiqui",
      email_sent: false,
    };

    let { data, error, hasEmailSentColumn } = await insertConsultation(payload);

    if (error && (String(error.message || "").includes("selected_date") || String(error.message || "").includes("selected_time") || String(error.message || "").includes("consultant"))) {
      const reduced = { ...payload };
      delete reduced.selected_date;
      delete reduced.selected_time;
      delete reduced.consultant;
      const retry = await insertConsultation(reduced);
      data = retry.data;
      error = retry.error;
      hasEmailSentColumn = retry.hasEmailSentColumn;
    }

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "This time slot is already booked. Please choose another time." });
      }
      return res.status(400).json({ error: error.message });
    }

    const conflicts = await findActiveBookings(date, time);
    if (!conflicts.error && conflicts.data.length > 1) {
      const extras = conflicts.data
        .filter((row) => row.id === data.id)
        .map((row) => row.id);
      if (extras.length) {
        await supabase.from("consultations").delete().eq("id", data.id);
      }
      return res.status(409).json({ error: "This time slot is already booked. Please choose another time." });
    }

    try {
      await sendConfirmationEmail(email, date, time, name);
      userEmailSent = true;
      console.log("📧 User confirmation email sent to:", email);
    } catch (mailError) {
      console.error("❌ Failed to send USER confirmation email:", mailError.message);
      require("fs").appendFileSync(
        "mail_error.log",
        `${new Date().toISOString()} [USER] ${mailError.stack}\n`
      );
    }

    try {
      await sendAdminNotification(name, email, phone, date, time, message);
      adminEmailSent = true;
      console.log("📧 Admin notification email sent to:", process.env.ADMIN_EMAIL);
    } catch (mailError) {
      console.error("❌ Failed to send ADMIN notification email:", mailError.message);
      require("fs").appendFileSync(
        "mail_error.log",
        `${new Date().toISOString()} [ADMIN] ${mailError.stack}\n`
      );
    }

    if (userEmailSent && hasEmailSentColumn) {
      await supabase
        .from("consultations")
        .update({ email_sent: true })
        .eq("id", data.id);
    }

    console.log(`📊 Email summary for booking ${data.id}: user=${userEmailSent}, admin=${adminEmailSent}`);

    return res.json({
      success: true,
      message: "Consultation booked successfully!",
      consultation: data,
      emailDelivery: {
        customer: userEmailSent,
        admin: adminEmailSent,
      },
    });
  } catch (error) {
    console.error("Booking error:", error);
    return res.status(500).json({ error: error.message });
  } finally {
    inflightSlots.delete(lockKey);
  }
};

exports.getAvailableSlots = async (req, res) => {
  const date = normalizeDate(req.query.date);

  if (!date) {
    return res.json({ slots: ALLOWED_SLOTS });
  }

  try {
    const { data, error } = await findActiveBookings(date);
    if (error) return res.status(400).json({ error: error.message });

    const bookedTimes = collectBookedTimes(data);
    const availableSlots = ALLOWED_SLOTS.filter((slot) => !bookedTimes.includes(slot));

    res.json({ date, slots: availableSlots, bookedSlots: bookedTimes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

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

exports.getConsultations = async (req, res) => {
  const { userId } = req.params;

  try {
    const { data, error } = await supabase
      .from("consultations")
      .select("*")
      .eq("user_id", userId)
      .order("selected_date", { ascending: true });

    if (error) return res.status(400).json({ error: error.message });

    res.json({ consultations: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

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
