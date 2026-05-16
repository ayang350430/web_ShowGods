const express = require('express');

const weatherController = require('../controllers/weather.controller');

const router = express.Router();

// 获取今日天气路由
router.get('/today', weatherController.getTodayWeather);

module.exports = router;
