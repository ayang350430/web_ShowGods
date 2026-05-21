const batchOrderService = require('../services/batchOrder.service');
const { getCurrentUserId } = require('../utils/currentUser');

const previewBatchOrder = async (req, res, next) => {
  try {
    const data = await batchOrderService.buildPreview(getCurrentUserId(req), req.body);

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const previewBatchOrderSilent = async (req, res, next) => {
  try {
    const data = await batchOrderService.buildPreview(getCurrentUserId(req), req.body, {
      persistCheckRecords: false,
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

const previewBatchOrderStream = async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const data = await batchOrderService.buildPreview(getCurrentUserId(req), req.body, {
      onStart: (info) => write({ type: 'start', data: info }),
      onItem: (item) => write({ type: 'item', data: item }),
    });

    write({ type: 'done', data });
  } catch (error) {
    write({ type: 'error', message: error.message || 'Preview failed' });
  }

  res.end();
};

const getBatchOrders = async (req, res, next) => {
  try {
    const data = await batchOrderService.getBatchOrders(getCurrentUserId(req), req.params.batchId);

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const submitBatchOrder = async (req, res, next) => {
  try {
    const data = await batchOrderService.submitBatch(getCurrentUserId(req), req.body);

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const saveProblemLinks = async (req, res, next) => {
  try {
    const data = await batchOrderService.saveProblemLinkRecords(getCurrentUserId(req), req.body);

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const listProblemLinks = async (req, res, next) => {
  try {
    const data = await batchOrderService.listProblemLinkRecords(getCurrentUserId(req), req.query);

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const listCheckRecords = async (req, res, next) => {
  try {
    const data = await batchOrderService.listBatchLinkCheckRecords(getCurrentUserId(req), req.query);

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const listBatchOrderRecords = async (req, res, next) => {
  try {
    const data = await batchOrderService.listBatchOrderRecords(getCurrentUserId(req), req.query);

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const searchBatchOrders = async (req, res, next) => {
  try {
    const data = await batchOrderService.searchBatchOrdersByLinks(
      getCurrentUserId(req),
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

const listConsumptionRecords = async (req, res, next) => {
  try {
    const data = await batchOrderService.listConsumptionRecords(getCurrentUserId(req), req.query);

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const listRefundRecords = async (req, res, next) => {
  try {
    const data = await batchOrderService.listRefundRecords(getCurrentUserId(req), req.query);

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const retryBatchOrder = async (req, res, next) => {
  try {
    const data = await batchOrderService.retryBatch(getCurrentUserId(req), req.params.batchId);

    return res.json({
      code: 0,
      data,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const replenishBatchOrder = async (req, res, next) => {
  try {
    const data = await batchOrderService.approveReplenishmentBatch(
      getCurrentUserId(req),
      req.params.batchId,
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

const requestReplenishBatchOrder = async (req, res, next) => {
  try {
    const data = await batchOrderService.requestReplenishBatch(
      getCurrentUserId(req),
      req.params.batchId,
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

const listReplenishmentRequests = async (req, res, next) => {
  try {
    const data = await batchOrderService.listReplenishmentRequests(
      getCurrentUserId(req),
      req.query,
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

const approveReplenishmentRequest = async (req, res, next) => {
  try {
    const data = await batchOrderService.approveReplenishmentRequest(
      getCurrentUserId(req),
      req.params.requestId,
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

const requestOrderRefund = async (req, res, next) => {
  try {
    const data = await batchOrderService.requestOrderRefund(
      getCurrentUserId(req),
      req.params.orderId,
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

const requestBatchRefund = async (req, res, next) => {
  try {
    const data = await batchOrderService.requestBatchRefund(
      getCurrentUserId(req),
      req.params.batchId,
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

const reviewOrderRefund = async (req, res, next) => {
  try {
    const data = await batchOrderService.reviewOrderRefund(
      getCurrentUserId(req),
      req.params.orderId,
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

const fullRefundOrder = async (req, res, next) => {
  try {
    const data = await batchOrderService.fullRefundOrder(
      getCurrentUserId(req),
      req.params.orderId,
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

const fullRefundBatch = async (req, res, next) => {
  try {
    const data = await batchOrderService.fullRefundBatch(
      getCurrentUserId(req),
      req.body?.batch_no,
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

const batchApproveRefunds = async (req, res, next) => {
  try {
    const data = await batchOrderService.batchApproveRefunds(
      getCurrentUserId(req),
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

const batchRejectRefunds = async (req, res, next) => {
  try {
    const data = await batchOrderService.batchRejectRefunds(
      getCurrentUserId(req),
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

const getOrderTypeStatus = async (req, res, next) => {
  try {
    const data = await batchOrderService.getOrderTypeStatus(getCurrentUserId(req));
    return res.json({ code: 0, data, message: 'ok' });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  batchApproveRefunds,
  batchRejectRefunds,
  fullRefundBatch,
  fullRefundOrder,
  getBatchOrders,
  getOrderTypeStatus,
  listBatchOrderRecords,
  listCheckRecords,
  listConsumptionRecords,
  listProblemLinks,
  listReplenishmentRequests,
  listRefundRecords,
  approveReplenishmentRequest,
  previewBatchOrder,
  previewBatchOrderSilent,
  previewBatchOrderStream,
  replenishBatchOrder,
  requestBatchRefund,
  requestReplenishBatchOrder,
  retryBatchOrder,
  requestOrderRefund,
  reviewOrderRefund,
  saveProblemLinks,
  searchBatchOrders,
  submitBatchOrder,
};
