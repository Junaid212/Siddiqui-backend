const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ALLOWED_SLOTS,
  normalizeTime,
  isPastSlot,
  isSaturday,
  validateBookingInput,
  escapeHtml,
} = require("./consultationRules");

test("normalizes 12-hour and 24-hour times", () => {
  assert.equal(normalizeTime("9:00 AM"), "09:00");
  assert.equal(normalizeTime("12:00 PM"), "12:00");
  assert.equal(normalizeTime("12:30 AM"), "00:30");
  assert.equal(normalizeTime("7:00 PM"), "19:00");
  assert.equal(normalizeTime("11:00:00"), "11:00");
  assert.equal(normalizeTime("14:30"), "14:30");
});

test("includes evening slots used by the public booking UI", () => {
  assert.ok(ALLOWED_SLOTS.includes("17:30"));
  assert.ok(ALLOWED_SLOTS.includes("19:00"));
  assert.equal(ALLOWED_SLOTS.includes("16:00"), false);
});

test("rejects Saturday dates", () => {
  assert.equal(isSaturday("2026-10-31"), true);
  assert.equal(isSaturday("2026-11-02"), false);
});

test("prevents past slots", () => {
  const now = new Date(2026, 9, 30, 12, 0, 0);
  assert.equal(isPastSlot("2026-10-29", "09:00", now), true);
  assert.equal(isPastSlot("2026-10-30", "11:30", now), true);
  assert.equal(isPastSlot("2026-10-30", "13:00", now), false);
  assert.equal(isPastSlot("2026-11-02", "09:00", now), false);
});

test("validates customer details and slot rules", () => {
  const valid = validateBookingInput({
    name: "Audit Tester",
    email: "audit-booking-oct30-2026@siddiqui.digital",
    phone: "++1 (555) 010-0199",
    date: "2026-11-02",
    time: "10:00 AM",
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.time, "10:00");
  assert.equal(valid.value.email, "audit-booking-oct30-2026@siddiqui.digital");

  const missingPhone = validateBookingInput({
    name: "Audit Tester",
    email: "audit-booking-oct30-2026@siddiqui.digital",
    date: "2026-11-02",
    time: "10:00",
  });
  assert.equal(missingPhone.ok, false);

  const badEmail = validateBookingInput({
    name: "Audit Tester",
    email: "not-an-email",
    phone: "5550100199",
    date: "2026-11-02",
    time: "10:00",
  });
  assert.equal(badEmail.ok, false);

  const saturday = validateBookingInput({
    name: "Audit Tester",
    email: "audit-booking-oct30-2026@siddiqui.digital",
    phone: "5550100199",
    date: "2026-10-31",
    time: "10:00",
  });
  assert.equal(saturday.ok, false);

  const invalidSlot = validateBookingInput({
    name: "Audit Tester",
    email: "audit-booking-oct30-2026@siddiqui.digital",
    phone: "5550100199",
    date: "2026-11-02",
    time: "16:00",
  });
  assert.equal(invalidSlot.ok, false);
});

test("escapes HTML in email fields", () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), "&lt;img src=x onerror=alert(1)&gt;");
});
