const express = require("express");
const router = express.Router();
const { requireCustomer } = require("../utils/requireCustomer");
const { requirePermission } = require("../utils/entitlements");
const reader = require("../controllers/readerController");

// Who am I / what does my edition include (any signed-in customer).
router.get("/access", requireCustomer, reader.getAccess);

// Everything below needs an ACTIVE Online Reading entitlement (Digital Companion customers are refused).
router.use(requireCustomer, requirePermission("reader"));
router.get("/books", reader.listBooks);
router.get("/books/:slug", reader.getBook);
router.get("/books/:slug/chapters/:chapterSlug", reader.getChapter);
router.put("/books/:slug/progress", reader.saveProgress);

module.exports = router;
