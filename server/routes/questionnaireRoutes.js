const express = require("express");
const router = express.Router();
const {
    getQuestions,
    submitVote,
    getResults,
    submitFullResponse,
    getAnalytics,
    getLiveResults,
} = require("../controllers/questionnaireController");

// Get all questions with options
router.get("/questions", getQuestions);

// Submit a vote (legacy per-question)
router.post("/vote", submitVote);

// Submit a full questionnaire response (all answers + profile)
router.post("/submit", submitFullResponse);

// Get analytics (total submissions, profile breakdown, per-question results)
router.get("/analytics", getAnalytics);

// Live results from JSONB — works without DB-seeded questions
router.get("/results-live", getLiveResults);

// Get results with percentages for a question
router.get("/results/:questionId", getResults);

module.exports = router;