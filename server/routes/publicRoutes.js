const express = require("express");
const { submitContact } = require("../controllers/publicController");

const router = express.Router();

router.post("/contact", submitContact);

module.exports = router;
