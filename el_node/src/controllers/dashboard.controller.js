const dashboardService = require('../services/dashboard.service');
const { getCurrentUserId } = require('../utils/currentUser');

const getSummary = async (req, res, next) => {
  try {
    const data = await dashboardService.getDashboardSummary(
      getCurrentUserId(req),
      req.query.ranking_period,
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

const getRankings = async (req, res, next) => {
  try {
    const data = await dashboardService.getDashboardRankings(
      getCurrentUserId(req),
      req.query.ranking_period,
      req.query.target_type,
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

const getAdminUsersOverview = async (req, res, next) => {
  try {
    const data = await dashboardService.listAdminDashboardUsersOverview(getCurrentUserId(req), {
      keyword: req.query.keyword,
      page: req.query.page,
      pageSize: req.query.page_size,
    });

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
  getAdminUsersOverview,
  getRankings,
  getSummary,
};
