const express = require("express");
const router = express.Router();
const { googleSignIn, checkAccountType, forgotPassword } = require("../controllers/authController");

router.post("/google", googleSignIn);
router.get("/check-account-type", checkAccountType);
router.post("/forgot-password", forgotPassword);

module.exports = router;
