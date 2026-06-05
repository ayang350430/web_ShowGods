const express = require('express');

const adminPermissionController = require('../controllers/adminPermission.controller');
const authController = require('../controllers/auth.controller');

const router = express.Router();

router.get('/order-switches', adminPermissionController.getOrderSwitches);
router.put('/order-switches', adminPermissionController.updateOrderSwitches);
router.get('/roles', adminPermissionController.listRoles);
router.get('/users', adminPermissionController.listUsers);
router.put('/users/:userId/balance', adminPermissionController.updateUserBalance);
router.put('/users/:userId/discounts', adminPermissionController.updateUserDiscounts);
router.put('/users/:userId/order-types', adminPermissionController.updateUserOrderTypes);
router.put('/users/:userId/roles', adminPermissionController.updateUserRoles);
router.put('/users/:userId/status', adminPermissionController.updateUserStatus);
router.get('/password-reset-requests', authController.getPasswordResetRequests);
router.put('/password-reset-requests/:id', authController.handlePasswordResetRequest);

module.exports = router;
