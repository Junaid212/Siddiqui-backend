const express = require("express");
const router = express.Router();
const { postComment, getComments } = require("../controllers/blogController");

router.post("/comment", postComment);
router.get("/comments/:blogId", getComments);

module.exports = router;
