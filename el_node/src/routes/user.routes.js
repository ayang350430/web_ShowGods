const express = require('express');

const userController = require('../controllers/user.controller');

const router = express.Router();

// 获取用户信息路由
router.get('/info', userController.getUserInfo);
router.get('/notifications', userController.getUserNotifications);
router.get('/profile', userController.getUserProfile);

module.exports = router;
