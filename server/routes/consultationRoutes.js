const express = require("express");
const router = express.Router();
const {
    bookConsultation,
    getAvailableSlots,
    getConsultations,
    getAllConsultations,
    getEmailSentCount,
    deleteConsultation,
} = require("../controllers/consultationController");

// Book a consultation
router.post("/book", bookConsultation);

// Get available time slots for a date
router.get("/slots", getAvailableSlots);

// Get all consultations (admin)
router.get("/all", getAllConsultations);

// Get email sent count (admin stats)
router.get("/email-sent-count", getEmailSentCount);

// Get all consultations for a user
router.get("/my/:userId", getConsultations);

// Delete a consultation (admin)
router.delete("/:id", deleteConsultation);

module.exports = router;