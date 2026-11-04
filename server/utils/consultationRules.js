const ALLOWED_SLOTS = [
  "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
  "12:00", "12:30", "13:00", "13:30", "14:00", "14:30",
  "15:00", "15:30",
  "17:00", "17:30", "18:00", "18:30", "19:00",
];

const ACTIVE_STATUSES = ["booked", "confirmed", "completed"];
const ALLOWED_STATUSES = ["booked", "confirmed", "completed", "cancelled", "no-show"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pad(value) {
  return String(value).padStart(2, "0");
}

function todayLocalDateString(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function nowLocalTimeString(now = new Date()) {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function normalizeTime(value) {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw) return "";

  const ampm = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = ampm[2];
    const period = ampm[3].toUpperCase();
    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    return `${pad(hour)}:${minute}`;
  }

  const m24 = raw.match(/^(\d{1,2}):(\d{2})/);
  if (m24) {
    return `${pad(Number(m24[1]))}:${m24[2]}`;
  }

  return raw;
}

function normalizeDate(value) {
  if (!value) return "";
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : raw;
}

function isSaturday(dateStr) {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  if (!year || !month || !day) return false;
  return new Date(year, month - 1, day).getDay() === 6;
}

function isPastSlot(dateStr, timeStr, now = new Date()) {
  const date = normalizeDate(dateStr);
  const time = normalizeTime(timeStr);
  const today = todayLocalDateString(now);
  if (!date || date < today) return true;
  if (date > today) return false;
  return time <= nowLocalTimeString(now);
}

function isActiveStatus(status) {
  if (!status) return true;
  return ACTIVE_STATUSES.includes(String(status).toLowerCase());
}

function digitsOnly(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function validateBookingInput(body = {}) {
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const phone = String(body.phone || "").trim();
  const message = String(body.message || "").trim();
  const date = normalizeDate(body.date || body.selected_date);
  const time = normalizeTime(body.time || body.selected_time);

  if (!date || !time) {
    return { ok: false, status: 400, error: "Date and time are required" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, status: 400, error: "Enter a valid appointment date" };
  }
  if (!name) {
    return { ok: false, status: 400, error: "Name is required" };
  }
  if (name.length < 2) {
    return { ok: false, status: 400, error: "Enter a valid name" };
  }
  if (!email) {
    return { ok: false, status: 400, error: "Email is required" };
  }
  if (!EMAIL_RE.test(email)) {
    return { ok: false, status: 400, error: "Enter a valid email address" };
  }
  if (!phone) {
    return { ok: false, status: 400, error: "Phone number is required" };
  }
  const digits = digitsOnly(phone);
  if (digits.length < 7 || digits.length > 15) {
    return { ok: false, status: 400, error: "Enter a valid phone number" };
  }
  if (!ALLOWED_SLOTS.includes(time)) {
    return { ok: false, status: 400, error: "That time slot is not available" };
  }
  if (isSaturday(date)) {
    return { ok: false, status: 400, error: "Appointments are not available on Saturdays" };
  }
  if (isPastSlot(date, time)) {
    return { ok: false, status: 400, error: "Please choose a future date and time" };
  }

  return {
    ok: true,
    value: {
      name,
      email,
      phone,
      message,
      date,
      time,
      userId: body.userId || null,
    },
  };
}

function slotKey(date, time) {
  return `${normalizeDate(date)}|${normalizeTime(time)}`;
}

module.exports = {
  ALLOWED_SLOTS,
  ACTIVE_STATUSES,
  ALLOWED_STATUSES,
  normalizeTime,
  normalizeDate,
  isSaturday,
  isPastSlot,
  isActiveStatus,
  escapeHtml,
  validateBookingInput,
  slotKey,
  todayLocalDateString,
};
