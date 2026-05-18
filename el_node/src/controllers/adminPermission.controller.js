const adminPermissionService = require('../services/adminPermission.service');
const { getCurrentUserId } = require('../utils/currentUser');

const listUsers = async (req, res, next) => {
  try {
    const data = await adminPermissionService.listUsers(getCurrentUserId(req), req.query);

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const listRoles = async (req, res, next) => {
  try {
    const data = await adminPermissionService.listRoles(getCurrentUserId(req));

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const updateUserRoles = async (req, res, next) => {
  try {
    const data = await adminPermissionService.updateUserRoles(
      getCurrentUserId(req),
      req.params.userId,
      req.body?.roles || [],
    );

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const updateUserStatus = async (req, res, next) => {
  try {
    const data = await adminPermissionService.updateUserStatus(
      getCurrentUserId(req),
      req.params.userId,
      req.body?.status,
    );

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const updateUserDiscounts = async (req, res, next) => {
  try {
    const data = await adminPermissionService.updateUserDiscounts(
      getCurrentUserId(req),
      req.params.userId,
      req.body,
    );

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const updateUserBalance = async (req, res, next) => {
  try {
    const data = await adminPermissionService.updateUserBalance(
      getCurrentUserId(req),
      req.params.userId,
      req.body,
    );

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  listRoles,
  listUsers,
  updateUserBalance,
  updateUserDiscounts,
  updateUserStatus,
  updateUserRoles,
};
