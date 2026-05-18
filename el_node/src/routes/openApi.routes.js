const express = require('express');

const openApiController = require('../controllers/openApi.controller');

const router = express.Router();

// Platform endpoints: logged-in users apply for and manage Open API keys.
router.get('/v1/open-api/keys', openApiController.listApiKeys);
router.post('/v1/open-api/keys', openApiController.createApiKey);
router.delete('/v1/open-api/keys/:keyId', openApiController.revokeApiKey);

// Public endpoints: downstream callers use Open API keys to place orders.
router.post('/open/orders/preview', openApiController.previewOpenBatch);
router.post('/open/orders/submit', openApiController.submitOpenBatch);
router.get('/open/orders/progress', openApiController.getOpenOrderProgress);
router.post('/open/orders/stop', openApiController.stopOpenOrderTasks);

module.exports = router;
