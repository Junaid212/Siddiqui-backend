const express = require("express");
const cors = require("cors");
require("dotenv").config();

const authRoutes = require("./routes/authRoutes");
const consultationRoutes = require("./routes/consultationRoutes");
const questionnaireRoutes = require("./routes/questionnaireRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const blogRoutes = require("./routes/blogRoutes");

const app = express();

// CORS — allow all origins (adjust in production)
app.use(cors());

// Parse JSON bodies for all routes EXCEPT the Stripe webhook
app.use((req, res, next) => {
  if (req.originalUrl === "/api/payment/webhook") {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/consultation", consultationRoutes);
app.use("/api/questionnaire", questionnaireRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/blog", blogRoutes);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});