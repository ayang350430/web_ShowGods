const express = require('express');

const authController = require('../controllers/auth.controller');
const requireAuth = require('../middlewares/requireAuth');

const router = express.Router();

// 公开接口（无需登录）
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.post('/register', authController.register);
router.post('/refresh', authController.refreshToken);
router.post('/password-reset-request', authController.requestPasswordReset);

// 需登录接口：token 失效返回 401，触发前端重新登录
router.get('/codes', requireAuth, authController.getAccessCodes);

module.exports = router;
