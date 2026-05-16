const express = require('express');

const authController = require('../controllers/auth.controller');

const router = express.Router();

router.get('/codes', authController.getAccessCodes);
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.post('/register', authController.register);
router.post('/refresh', authController.refreshToken);

module.exports = router;
