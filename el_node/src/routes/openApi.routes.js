const express = require('express');

const openApiController = require('../controllers/openApi.controller');
const requireAuth = require('../middlewares/requireAuth');

const router = express.Router();

// Platform endpoints: logged-in users apply for and manage Open API keys.
// 需登录，token 失效返回 401，触发前端重新登录。
router.get('/v1/open-api/keys', requireAuth, openApiController.listApiKeys);
router.post('/v1/open-api/keys', requireAuth, openApiController.createApiKey);
router.delete('/v1/open-api/keys/:keyId', requireAuth, openApiController.revokeApiKey);

// Public endpoints: downstream callers use Open API keys to place orders.
// 使用 API Key 鉴权，不挂登录校验。
router.post('/open/orders/preview', openApiController.previewOpenBatch);
router.post('/open/orders/submit', openApiController.submitOpenBatch);
router.get('/open/orders/progress', openApiController.getOpenOrderProgress);
router.post('/open/orders/stop', openApiController.stopOpenOrderTasks);

module.exports = router;
