const express = require('express');

const dashboardController = require('../controllers/dashboard.controller');

const router = express.Router();

router.get('/users-overview', dashboardController.getAdminUsersOverview);

module.exports = router;
