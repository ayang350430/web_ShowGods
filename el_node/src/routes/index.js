const express = require('express');

const adminDashboardRoutes = require('./adminDashboard.routes');
const adminPermissionRoutes = require('./adminPermission.routes');
const authRoutes = require('./auth.routes');
const dashboardRoutes = require('./dashboard.routes');
const healthRoutes = require('./health.routes');
const menuRoutes = require('./menu.routes');
const orderRoutes = require('./order.routes');
const userRoutes = require('./user.routes');
const weatherRoutes = require('./weather.routes');

const router = express.Router();

// 批量下单路由
router.use('/auth', authRoutes);
router.use('/health', healthRoutes);
router.use('/menu', menuRoutes);
router.use('/v1/orders', orderRoutes);
router.use('/user', userRoutes);
router.use('/weather', weatherRoutes);
router.use('/v1/admin/dashboard', adminDashboardRoutes);
router.use('/v1/admin/permissions', adminPermissionRoutes);
router.use('/v1/dashboard', dashboardRoutes);

module.exports = router;
