const express = require("express");
const router = express.Router();
const {
    getQuestions,
    submitVote,
    getResults,
} = require("../controllers/questionnaireController");

// Get all questions with options
router.get("/questions", getQuestions);

// Submit a vote
router.post("/vote", submitVote);

// Get results with percentages for a question
router.get("/results/:questionId", getResults);

module.exports = router;