const permissionService = require('../services/permission.service');
const { getCurrentUserId } = require('../utils/currentUser');

const getAllMenus = async (req, res, next) => {
  try {
    const menus = await permissionService.getMenus(getCurrentUserId(req));

    return res.json({
      code: 0,
      data: menus,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getAllMenus,
};
