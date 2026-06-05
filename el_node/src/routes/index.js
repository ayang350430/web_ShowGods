const express = require('express');

const adminDashboardRoutes = require('./adminDashboard.routes');
const adminPermissionRoutes = require('./adminPermission.routes');
const authRoutes = require('./auth.routes');
const dashboardRoutes = require('./dashboard.routes');
const healthRoutes = require('./health.routes');
const menuRoutes = require('./menu.routes');
const openApiRoutes = require('./openApi.routes');
const orderRoutes = require('./order.routes');
const userRoutes = require('./user.routes');
const weatherRoutes = require('./weather.routes');
const requireAuth = require('../middlewares/requireAuth');

const router = express.Router();

// 公开路由（无需登录）：登录/注册/刷新/找回密码在 auth 内部细分；健康检查、天气公开
router.use('/auth', authRoutes);
router.use('/health', healthRoutes);
router.use('/weather', weatherRoutes);

// 开放 API：keys 管理需登录、open/orders 用 API Key，鉴权在该路由内部细分
router.use(openApiRoutes);

// 受保护路由（需登录，token 失效统一返回 401，触发前端重新登录）
router.use('/menu', requireAuth, menuRoutes);
router.use('/v1/orders', requireAuth, orderRoutes);
router.use('/user', requireAuth, userRoutes);
router.use('/v1/admin/dashboard', requireAuth, adminDashboardRoutes);
router.use('/v1/admin/permissions', requireAuth, adminPermissionRoutes);
router.use('/v1/dashboard', requireAuth, dashboardRoutes);

module.exports = router;
