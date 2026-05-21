const crypto = require('node:crypto');

const { getPool } = require('../config/database');
const batchOrderService = require('./batchOrder.service');

let openApiKeyTableReady;
let openApiLogTableReady;
const progressRateLimitMap = new Map();
const PROGRESS_RATE_LIMIT_MS = 10_000;

const ensureOpenApiKeyTable = async (db = getPool()) => {
  if (!openApiKeyTableReady) {
    openApiKeyTableReady = db.execute(`
      CREATE TABLE IF NOT EXISTS open_api_keys (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id INT UNSIGNED NOT NULL,
        key_name VARCHAR(100) NOT NULL DEFAULT '',
        key_prefix VARCHAR(32) NOT NULL,
        key_hash CHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        last_used_at DATETIME DEFAULT NULL,
        revoked_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_open_api_keys_hash (key_hash),
        KEY idx_open_api_keys_user_created_at (user_id, created_at),
        KEY idx_open_api_keys_prefix_status (key_prefix, status),
        CONSTRAINT fk_open_api_keys_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
  await openApiKeyTableReady;
};

const ensureOpenApiLogTable = async (db = getPool()) => {
  if (!openApiLogTableReady) {
    openApiLogTableReady = db.execute(`
      CREATE TABLE IF NOT EXISTS open_api_logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        key_id BIGINT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NOT NULL,
        endpoint VARCHAR(100) NOT NULL,
        status_code SMALLINT UNSIGNED NOT NULL DEFAULT 200,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_open_api_logs_created (created_at),
        KEY idx_open_api_logs_user (user_id, created_at),
        KEY idx_open_api_logs_endpoint (endpoint, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
  await openApiLogTableReady;
};

const logApiCall = async (keyId, userId, endpoint, statusCode = 200) => {
  try {
    const db = getPool();
    await ensureOpenApiLogTable(db);
    await db.execute(
      'INSERT INTO open_api_logs (key_id, user_id, endpoint, status_code) VALUES (?, ?, ?, ?)',
      [keyId, userId, endpoint, statusCode],
    );
  } catch {
    // fire-and-forget
  }
};

const getApiCallStats = async (userId) => {
  const db = getPool();
  await ensureOpenApiLogTable(db);

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  const userFilter = userId ? 'AND user_id = ?' : '';
  const userParams = userId ? [userId] : [];

  const [[stats]] = await db.execute(
    `
      SELECT
        COUNT(1) AS total_calls,
        COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS today_calls,
        COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END), 0) AS yesterday_calls,
        COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS week_calls,
        COALESCE(SUM(CASE WHEN endpoint = 'preview' THEN 1 ELSE 0 END), 0) AS preview_calls,
        COALESCE(SUM(CASE WHEN endpoint = 'submit' THEN 1 ELSE 0 END), 0) AS submit_calls,
        COALESCE(SUM(CASE WHEN endpoint = 'progress' THEN 1 ELSE 0 END), 0) AS progress_calls,
        COALESCE(SUM(CASE WHEN endpoint = 'stop' THEN 1 ELSE 0 END), 0) AS stop_calls
      FROM open_api_logs
      WHERE 1=1 ${userFilter}
    `,
    [todayStart, yesterdayStart, todayStart, weekStart, ...userParams],
  );

  return {
    preview_calls: Number(stats?.preview_calls) || 0,
    progress_calls: Number(stats?.progress_calls) || 0,
    stop_calls: Number(stats?.stop_calls) || 0,
    submit_calls: Number(stats?.submit_calls) || 0,
    today_calls: Number(stats?.today_calls) || 0,
    total_calls: Number(stats?.total_calls) || 0,
    week_calls: Number(stats?.week_calls) || 0,
    yesterday_calls: Number(stats?.yesterday_calls) || 0,
  };
};

const hashKey = (apiKey) => crypto.createHash('sha256').update(String(apiKey)).digest('hex');

const generateApiKey = () => `goods_${crypto.randomBytes(24).toString('base64url')}`;

const maskApiKey = (prefix) => `${prefix}************************`;

const isNumericId = (value) => /^\d+$/.test(String(value || '').trim());

const isUuidLike = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || '').trim(),
  );

const applyOpenOrderLocator = ({ batchNo, batchUuid, orderId, orderNo, params, where }) => {
  if (batchUuid) {
    where.push('ob.batch_id = ?');
    params.push(String(batchUuid));
  }
  if (batchNo) {
    where.push('ob.batch_no = ?');
    params.push(String(batchNo));
  }
  if (orderId) {
    if (isNumericId(orderId)) {
      where.push('o.id = ?');
      params.push(Number(orderId));
    } else if (isUuidLike(orderId)) {
      where.push('ob.batch_id = ?');
      params.push(String(orderId));
    } else {
      const error = new Error('order_id must be numeric. Use batch_id for batch UUID.');
      error.statusCode = 400;
      throw error;
    }
  }
  if (orderNo) {
    where.push('o.order_no = ?');
    params.push(String(orderNo));
  }
};

const createApiKey = async (userId, { name } = {}) => {
  const db = getPool();
  await ensureOpenApiKeyTable(db);

  const targetUserId = Number(userId);
  if (!targetUserId) {
    const error = new Error('Invalid user');
    error.statusCode = 401;
    throw error;
  }

  const [[user]] = await db.execute('SELECT id FROM users WHERE id = ? AND status = ?', [
    targetUserId,
    'active',
  ]);
  if (!user) {
    const error = new Error('User not found or disabled');
    error.statusCode = 403;
    throw error;
  }

  const [[existingActiveKey]] = await db.execute(
    `
      SELECT id
      FROM open_api_keys
      WHERE user_id = ? AND status = 'active'
      LIMIT 1
    `,
    [targetUserId],
  );
  if (existingActiveKey) {
    const error = new Error('当前账号已有可用 Open API key，请删除后再重新申请');
    error.statusCode = 400;
    throw error;
  }

  const apiKey = generateApiKey();
  const keyPrefix = apiKey.slice(0, 12);
  const now = new Date();
  const [result] = await db.execute(
    `
      INSERT INTO open_api_keys
        (user_id, key_name, key_prefix, key_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `,
    [targetUserId, String(name || 'default').slice(0, 100), keyPrefix, hashKey(apiKey), now, now],
  );

  return {
    api_key: apiKey,
    id: result.insertId,
    key_name: String(name || 'default').slice(0, 100),
    key_prefix: keyPrefix,
    masked_key: maskApiKey(keyPrefix),
  };
};

const listApiKeys = async (userId) => {
  const db = getPool();
  await ensureOpenApiKeyTable(db);
  const [rows] = await db.execute(
    `
      SELECT id, key_name, key_prefix, status, last_used_at, revoked_at, created_at
      FROM open_api_keys
      WHERE user_id = ?
      ORDER BY id DESC
    `,
    [Number(userId)],
  );

  return rows.map((row) => ({
    created_at: row.created_at,
    id: Number(row.id),
    key_name: row.key_name || '',
    key_prefix: row.key_prefix,
    last_used_at: row.last_used_at,
    masked_key: maskApiKey(row.key_prefix),
    revoked_at: row.revoked_at,
    status: row.status,
  }));
};

const revokeApiKey = async (userId, keyId) => {
  const db = getPool();
  await ensureOpenApiKeyTable(db);
  const now = new Date();
  const [result] = await db.execute(
    `
      UPDATE open_api_keys
      SET status = 'revoked', revoked_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'active'
    `,
    [now, now, Number(keyId), Number(userId)],
  );

  if (result.affectedRows === 0) {
    const error = new Error('API key not found or already revoked');
    error.statusCode = 404;
    throw error;
  }

  return {
    id: Number(keyId),
    status: 'revoked',
  };
};

const extractApiKey = (req) => {
  const authorization = req.headers.authorization || '';
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  return (
    req.headers['x-api-key'] ||
    req.headers['x-open-key'] ||
    bearerMatch?.[1] ||
    req.query?.key ||
    req.query?.api_key ||
    ''
  );
};

const authenticateOpenApiKey = async (req) => {
  const apiKey = String(extractApiKey(req) || '').trim();
  if (!apiKey) {
    const error = new Error('Open API key is required');
    error.statusCode = 401;
    throw error;
  }

  const db = getPool();
  await ensureOpenApiKeyTable(db);
  const [[row]] = await db.execute(
    `
      SELECT oak.id, oak.user_id, u.status AS user_status
      FROM open_api_keys oak
      INNER JOIN users u ON u.id = oak.user_id
      WHERE oak.key_hash = ? AND oak.status = 'active'
      LIMIT 1
    `,
    [hashKey(apiKey)],
  );

  if (!row || row.user_status !== 'active') {
    const error = new Error('Invalid or disabled Open API key');
    error.statusCode = 401;
    throw error;
  }

  await db.execute('UPDATE open_api_keys SET last_used_at = ?, updated_at = ? WHERE id = ?', [
    new Date(),
    new Date(),
    row.id,
  ]);

  return {
    key_id: Number(row.id),
    user_id: Number(row.user_id),
  };
};

const assertProgressRateLimit = (keyId) => {
  const now = Date.now();
  const previous = progressRateLimitMap.get(keyId) || 0;
  const waitMs = PROGRESS_RATE_LIMIT_MS - (now - previous);
  if (waitMs > 0) {
    const error = new Error(`进度查询接口每个 key 10 秒只能调用一次，请 ${Math.ceil(waitMs / 1000)} 秒后再试`);
    error.statusCode = 429;
    error.retryAfter = Math.ceil(waitMs / 1000);
    throw error;
  }
  progressRateLimitMap.set(keyId, now);
};

const previewOpenBatch = async (req) => {
  const auth = await authenticateOpenApiKey(req);
  void logApiCall(auth.key_id, auth.user_id, 'preview');
  const data = await batchOrderService.buildPreview(auth.user_id, req.body, {
    persistCheckRecords: false,
  });
  return {
    ...data,
    open_api_key_id: auth.key_id,
  };
};

const submitOpenBatch = async (req) => {
  const auth = await authenticateOpenApiKey(req);
  void logApiCall(auth.key_id, auth.user_id, 'submit');
  const remark = String(req.body?.remark || req.body?.source || '').trim();
  if (!remark) {
    const error = new Error('remark（备注）为必填项');
    error.statusCode = 400;
    throw error;
  }
  const preview = await batchOrderService.buildPreview(auth.user_id, req.body, {
    persistCheckRecords: false,
  });
  if (!preview.can_submit) {
    const message =
      preview.items?.find((item) => Array.isArray(item.errors) && item.errors.length > 0)
        ?.errors?.[0] ||
      preview.warnings?.[0] ||
      '预校验未通过';
    const error = new Error(`Open API preview validation failed: ${message}`);
    error.statusCode = 400;
    error.details = preview;
    throw error;
  }
  let data;
  try {
    data = await batchOrderService.submitBatch(auth.user_id, {
      ...req.body,
      source: `goodsAdmin:${remark}`,
      agree_policy: req.body?.agree_policy ?? true,
    });
  } catch (error) {
    const details = error?.details;
    if (
      details &&
      Number(details.total_amount) > Number(details.available_balance)
    ) {
      const insufficientError = new Error('当前 Open API key 账号余额不足');
      insufficientError.statusCode = 400;
      insufficientError.details = details;
      throw insufficientError;
    }
    throw error;
  }
  return {
    ...data,
    open_api_key_id: auth.key_id,
  };
};

const getOpenOrderProgress = async (req) => {
  const auth = await authenticateOpenApiKey(req);
  void logApiCall(auth.key_id, auth.user_id, 'progress');
  assertProgressRateLimit(auth.key_id);
  const { batch_id: batchUuid, batch_no: batchNo, order_id: orderId, order_no: orderNo } = req.query || {};
  if (!batchUuid && !batchNo && !orderId && !orderNo) {
    const error = new Error('batch_id, batch_no, order_id or order_no is required');
    error.statusCode = 400;
    throw error;
  }

  const where = ['ob.user_id = ?'];
  const params = [auth.user_id];
  applyOpenOrderLocator({ batchNo, batchUuid, orderId, orderNo, params, where });

  const db = getPool();
  const [targetBatches] = await db.execute(
    `
      SELECT DISTINCT ob.id
      FROM order_batches ob
      LEFT JOIN orders o ON o.batch_id = ob.id
      WHERE ${where.join(' AND ')}
    `,
    params,
  );
  if (targetBatches.length > 0) {
    await batchOrderService._private.syncRunningOrdersFromXhs(
      db,
      auth.user_id,
      targetBatches.map((row) => Number(row.id)).filter(Boolean),
    );
  }

  const [rows] = await db.execute(
    `
      SELECT
        ob.id AS batch_pk,
        ob.batch_id,
        ob.batch_no,
        ob.status AS batch_status,
        ob.total_count,
        ob.processing_count,
        ob.succeeded_count,
        ob.failed_count,
        ob.estimated_amount,
        ob.submitted_at,
        ob.finished_at,
        o.id AS order_id,
        o.order_no,
        o.batch_item_id,
        o.note_id,
        o.note_url,
        o.target_type,
        o.ordered_quantity,
        o.completed_quantity,
        o.external_task_id,
        o.external_status,
        o.external_progress,
        o.external_completed_quantity,
        o.order_status,
        o.reason_message,
        o.updated_at
      FROM order_batches ob
      LEFT JOIN orders o ON o.batch_id = ob.id
      WHERE ${where.join(' AND ')}
      ORDER BY ob.id DESC, o.batch_item_id ASC, o.id ASC
    `,
    params,
  );

  if (rows.length === 0) {
    const error = new Error('Open order progress not found');
    error.statusCode = 404;
    throw error;
  }

  const batchMap = new Map();
  for (const row of rows) {
    if (!batchMap.has(row.batch_pk)) {
      batchMap.set(row.batch_pk, {
        batch_id: row.batch_id,
        batch_no: row.batch_no,
        estimated_amount: Number(row.estimated_amount) || 0,
        failed_count: Number(row.failed_count) || 0,
        finished_at: row.finished_at,
        orders: [],
        processing_count: Number(row.processing_count) || 0,
        status: row.batch_status,
        submitted_at: row.submitted_at,
        succeeded_count: Number(row.succeeded_count) || 0,
        total_count: Number(row.total_count) || 0,
      });
    }

    if (row.order_id) {
      const orderedQuantity = Number(row.ordered_quantity) || 0;
      const completedQuantity = Number(row.completed_quantity) || 0;
      const externalCompletedQuantity = Number(row.external_completed_quantity) || 0;
      const progress = orderedQuantity > 0
        ? Math.min(Math.max(Math.max(completedQuantity, externalCompletedQuantity) / orderedQuantity, 0), 1)
        : Number(row.external_progress) || 0;
      const progressPercent = Math.round(progress * 10000) / 100;
      batchMap.get(row.batch_pk).orders.push({
        batch_item_id: Number(row.batch_item_id) || 0,
        completed_quantity: completedQuantity,
        external_completed_quantity: externalCompletedQuantity,
        external_progress: progress,
        external_status: row.external_status || '',
        external_task_id: row.external_task_id || '',
        note_id: row.note_id || '',
        note_url: row.note_url || '',
        order_id: Number(row.order_id),
        order_no: row.order_no,
        order_status: row.order_status,
        ordered_quantity: orderedQuantity,
        progress: progressPercent,
        progress_percent: progressPercent,
        reason_message: row.reason_message || '',
        target_type: row.target_type,
        updated_at: row.updated_at,
      });
    }
  }

  const batches = [...batchMap.values()].map((batch) => {
    const totalQuantity = batch.orders.reduce(
      (sum, order) => sum + (Number(order.ordered_quantity) || 0),
      0,
    );
    const completedQuantity = batch.orders.reduce((sum, order) => {
      const orderedQuantity = Number(order.ordered_quantity) || 0;
      const completed = Math.max(
        Number(order.completed_quantity) || 0,
        Number(order.external_completed_quantity) || 0,
      );
      return sum + Math.min(completed, orderedQuantity || completed);
    }, 0);
    const progress = totalQuantity > 0 ? Math.min(completedQuantity / totalQuantity, 1) : 0;
    return {
      ...batch,
      progress: {
        completed_quantity: completedQuantity,
        percent: Math.round(progress * 10000) / 100,
        total_quantity: totalQuantity,
      },
    };
  });
  return {
    batches,
    count: batches.length,
    open_api_key_id: auth.key_id,
  };
};

const stopOpenOrderTasks = async (req) => {
  const auth = await authenticateOpenApiKey(req);
  void logApiCall(auth.key_id, auth.user_id, 'stop');
  const {
    batch_id: batchUuid,
    batch_no: batchNo,
    order_id: orderId,
    order_no: orderNo,
  } = { ...(req.query || {}), ...(req.body || {}) };
  if (!batchUuid && !batchNo && !orderId && !orderNo) {
    const error = new Error('batch_id, batch_no, order_id or order_no is required');
    error.statusCode = 400;
    throw error;
  }

  const where = ['o.user_id = ?'];
  const params = [auth.user_id];
  applyOpenOrderLocator({ batchNo, batchUuid, orderId, orderNo, params, where });

  const db = getPool();
  const [orders] = await db.execute(
    `
      SELECT
        o.id,
        o.order_no,
        o.batch_id AS batch_pk,
        o.target_type,
        o.external_task_id,
        o.order_status,
        ob.batch_id,
        ob.batch_no
      FROM orders o
      INNER JOIN order_batches ob ON ob.id = o.batch_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.batch_item_id ASC, o.id ASC
    `,
    params,
  );

  if (orders.length === 0) {
    const error = new Error('Open order task not found');
    error.statusCode = 404;
    throw error;
  }

  const now = new Date();
  const reason = String(req.body?.reason || 'open api stop requested').slice(0, 255);
  const stoppableStatuses = new Set(['running', 'repair_review', 'refund_rejected']);
  const results = [];

  for (const order of orders) {
    if (!stoppableStatuses.has(order.order_status)) {
      results.push({
        batch_id: order.batch_id,
        batch_no: order.batch_no,
        external_task_id: order.external_task_id || '',
        order_id: Number(order.id),
        order_no: order.order_no,
        order_status: order.order_status,
        skipped: true,
        stop_status: 'skipped',
        target_type: order.target_type,
        message: 'Current order status cannot be stopped',
      });
      continue;
    }

    if (!/^\d+$/.test(String(order.external_task_id || ''))) {
      results.push({
        batch_id: order.batch_id,
        batch_no: order.batch_no,
        external_task_id: order.external_task_id || '',
        order_id: Number(order.id),
        order_no: order.order_no,
        order_status: order.order_status,
        skipped: true,
        stop_status: 'skipped',
        target_type: order.target_type,
        message: 'Missing upstream task id',
      });
      continue;
    }

    try {
      const upstream = await batchOrderService._private.stopXhsTask({
        reason: `goodsAdmin:order=${order.order_no} ${reason}`,
        taskId: order.external_task_id,
        targetType: order.target_type,
        userId: auth.user_id,
      });
      await db.execute(
        `
          UPDATE orders
          SET order_status = 'stopping',
              external_status = 'stop_requested',
              stop_requested_at = ?,
              stop_response_message = ?,
              updated_at = ?
          WHERE id = ? AND user_id = ?
        `,
        [now, reason, now, order.id, auth.user_id],
      );
      results.push({
        batch_id: order.batch_id,
        batch_no: order.batch_no,
        external_task_id: order.external_task_id,
        order_id: Number(order.id),
        order_no: order.order_no,
        order_status: 'stopping',
        skipped: false,
        stop_status: 'success',
        target_type: order.target_type,
        upstream_response: upstream || null,
      });
    } catch (error) {
      results.push({
        batch_id: order.batch_id,
        batch_no: order.batch_no,
        error: error?.message || 'XHS stop request failed',
        external_task_id: order.external_task_id,
        order_id: Number(order.id),
        order_no: order.order_no,
        order_status: order.order_status,
        skipped: false,
        stop_status: 'failed',
        target_type: order.target_type,
      });
    }
  }

  const batchIds = [...new Set(orders.map((order) => Number(order.batch_pk)).filter(Boolean))];
  for (const batchId of batchIds) {
    const [[stats]] = await db.execute(
      `
        SELECT
          COUNT(1) AS total_count,
          COALESCE(SUM(CASE WHEN order_status IN ('running', 'repair_review', 'stopping') THEN 1 ELSE 0 END), 0) AS processing_count,
          COALESCE(SUM(CASE WHEN order_status = 'completed' THEN 1 ELSE 0 END), 0) AS succeeded_count,
          COALESCE(SUM(CASE WHEN order_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
          COALESCE(SUM(CASE WHEN order_status IN ('failed', 'manual_review', 'repair_review') THEN 1 ELSE 0 END), 0) AS retryable_count
        FROM orders
        WHERE batch_id = ?
          AND user_id = ?
      `,
      [batchId, auth.user_id],
    );
    const totalCount = Number(stats.total_count) || 0;
    const processingCount = Number(stats.processing_count) || 0;
    const succeededCount = Number(stats.succeeded_count) || 0;
    const failedCount = Number(stats.failed_count) || 0;
    const nextStatus =
      totalCount > 0 && succeededCount === totalCount
        ? 'completed'
        : processingCount > 0
          ? 'processing'
          : failedCount > 0
            ? 'failed'
            : 'pending';
    await db.execute(
      `
        UPDATE order_batches
        SET status = ?,
            processing_count = ?,
            succeeded_count = ?,
            failed_count = ?,
            retryable_count = ?,
            updated_at = ?
        WHERE id = ? AND user_id = ?
      `,
      [
        nextStatus,
        processingCount,
        succeededCount,
        failedCount,
        Number(stats.retryable_count) || 0,
        now,
        batchId,
        auth.user_id,
      ],
    );
  }

  return {
    failed_count: results.filter((result) => result.stop_status === 'failed').length,
    open_api_key_id: auth.key_id,
    results,
    skipped_count: results.filter((result) => result.stop_status === 'skipped').length,
    stopped_count: results.filter((result) => result.stop_status === 'success').length,
    total_count: results.length,
  };
};

module.exports = {
  authenticateOpenApiKey,
  createApiKey,
  ensureOpenApiKeyTable,
  getApiCallStats,
  getOpenOrderProgress,
  listApiKeys,
  previewOpenBatch,
  revokeApiKey,
  stopOpenOrderTasks,
  submitOpenBatch,
  _private: {
    hashKey,
  },
};


