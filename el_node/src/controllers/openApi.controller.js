const openApiService = require('../services/openApi.service');
const { getCurrentUserId } = require('../utils/currentUser');

const createApiKey = async (req, res, next) => {
  try {
    const data = await openApiService.createApiKey(getCurrentUserId(req), req.body);
    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const listApiKeys = async (req, res, next) => {
  try {
    const data = await openApiService.listApiKeys(getCurrentUserId(req));
    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const revokeApiKey = async (req, res, next) => {
  try {
    const data = await openApiService.revokeApiKey(getCurrentUserId(req), req.params.keyId);
    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const previewOpenBatch = async (req, res, next) => {
  try {
    const data = await openApiService.previewOpenBatch(req);
    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const submitOpenBatch = async (req, res, next) => {
  try {
    const data = await openApiService.submitOpenBatch(req);
    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const getOpenOrderProgress = async (req, res, next) => {
  try {
    const data = await openApiService.getOpenOrderProgress(req);
    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const stopOpenOrderTasks = async (req, res, next) => {
  try {
    const data = await openApiService.stopOpenOrderTasks(req);
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
  createApiKey,
  getOpenOrderProgress,
  listApiKeys,
  previewOpenBatch,
  revokeApiKey,
  stopOpenOrderTasks,
  submitOpenBatch,
};
