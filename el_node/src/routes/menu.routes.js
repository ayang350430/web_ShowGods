const express = require('express');

const menuController = require('../controllers/menu.controller');

const router = express.Router();

// 获取所有菜单路由
router.get('/all', menuController.getAllMenus);

module.exports = router;
