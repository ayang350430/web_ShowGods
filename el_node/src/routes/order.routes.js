const express = require('express');

const batchOrderController = require('../controllers/batchOrder.controller');

const router = express.Router();

// 预览批量订单路由
router.post('/batch/preview', batchOrderController.previewBatchOrder);
router.post('/batch/preview-silent', batchOrderController.previewBatchOrderSilent);
router.post('/batch/search', batchOrderController.searchBatchOrders);
router.get('/batch/check-records', batchOrderController.listCheckRecords);
router.get('/batch/records', batchOrderController.listBatchOrderRecords);
router.get('/batch/:batchId/orders', batchOrderController.getBatchOrders);
router.get('/batch/problem-links', batchOrderController.listProblemLinks);
router.get('/consumption-records', batchOrderController.listConsumptionRecords);
router.get('/refund-records', batchOrderController.listRefundRecords);
router.get('/replenishments', batchOrderController.listReplenishmentRequests);
router.post('/batch/problem-links', batchOrderController.saveProblemLinks);
router.post('/batch/:batchId/replenish-request', batchOrderController.requestReplenishBatchOrder);
router.post('/batch/:batchId/replenish', batchOrderController.replenishBatchOrder);
router.post('/replenishments/:requestId/approve', batchOrderController.approveReplenishmentRequest);
router.post('/batch/:batchId/retry', batchOrderController.retryBatchOrder);
router.post('/batch/submit', batchOrderController.submitBatchOrder);
router.post('/batch/:batchId/refund-request', batchOrderController.requestBatchRefund);
router.post('/:orderId/refund-request', batchOrderController.requestOrderRefund);
router.post('/refund-batch-approve', batchOrderController.batchApproveRefunds);
router.post('/:orderId/refund-review', batchOrderController.reviewOrderRefund);

module.exports = router;
