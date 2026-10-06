const express = require('express');
const router = express.Router();
const {
  getPublicConfig,
  checkUserAccess,
  askQuestion,
  resetDemo
} = require('../controllers/askSidController');

router.get('/config', getPublicConfig);
router.get('/access', checkUserAccess);
router.post('/chat', askQuestion);
router.post('/reset-demo', resetDemo);

module.exports = router;
