const express = require('express');

const dashboardController = require('../controllers/dashboard.controller');

const router = express.Router();

router.get('/rankings', dashboardController.getRankings);
router.get('/summary', dashboardController.getSummary);

module.exports = router;
