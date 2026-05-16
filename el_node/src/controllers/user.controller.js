const permissionService = require('../services/permission.service');
const userProfileService = require('../services/userProfile.service');
const { getCurrentUserId } = require('../utils/currentUser');

const getUserInfo = async (req, res, next) => {
  try {
    const userInfo = await permissionService.getUserInfo(getCurrentUserId(req));

    if (!userInfo) {
      return res.status(404).json({
        message: 'User not found',
      });
    }

    return res.json({
      code: 0,
      data: userInfo,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const getUserProfile = async (req, res, next) => {
  try {
    const profile = await userProfileService.getUserProfile(getCurrentUserId(req));

    return res.json({
      code: 0,
      data: profile,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const getUserNotifications = async (req, res, next) => {
  try {
    const notifications = await userProfileService.getUserNotifications(getCurrentUserId(req));

    return res.json({
      code: 0,
      data: notifications,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getUserNotifications,
  getUserInfo,
  getUserProfile,
};
