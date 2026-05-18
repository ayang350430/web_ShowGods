const express = require('express');

const adminPermissionController = require('../controllers/adminPermission.controller');

const router = express.Router();

router.get('/roles', adminPermissionController.listRoles);
router.get('/users', adminPermissionController.listUsers);
router.put('/users/:userId/balance', adminPermissionController.updateUserBalance);
router.put('/users/:userId/discounts', adminPermissionController.updateUserDiscounts);
router.put('/users/:userId/roles', adminPermissionController.updateUserRoles);
router.put('/users/:userId/status', adminPermissionController.updateUserStatus);

module.exports = router;
