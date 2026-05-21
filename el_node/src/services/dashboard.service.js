const { getPool } = require('../config/database');
const openApiService = require('./openApi.service');

const ORDER_STATUS = {
  completed: 'completed',
  failed: 'failed',
  manualReview: 'manual_review',
  refundCalculating: 'refund_calculating',
  refundApproved: 'refund_approved',
  refundRequested: 'refund_requested',
  repairReview: 'repair_review',
  running: 'running',
  stopping: 'stopping',
};

const RECORD_TYPE = {
  orderCharge: 'order_charge',
};

const RECORD_STATUS = {
  success: 'success',
};

const XHS_STATUS = {
  active: 'active',
  cooling: 'cooling',
  disabled: 'disabled',
  invalid: 'invalid',
};

const clampPage = (value) => {
  const page = Number(value) || 1;
  return page > 0 ? page : 1;
};

const clampPageSize = (value) => {
  const pageSize = Number(value) || 10;
  return Math.min(Math.max(pageSize, 1), 100);
};

const round4 = (value) => Math.round((Number(value) || 0) * 10_000) / 10_000;

// 归一化折扣率
const normalizeDiscountRate = (value) => {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) {
    return 1;
  }
  return round4(rate);
};

// 归一化排名周期
const normalizeRankingPeriod = (value) => {
  const period = String(value || '').trim().toLowerCase();
  if (period === 'today' || period === 'yesterday') {
    return period;
  }
  return 'all';
};

// 归一化目标类型
const normalizeTargetType = (value) => {
  const targetType = String(value || '').trim().toLowerCase();
  if (!targetType || ['view', 'read', 'reading', 'note_views'].includes(targetType)) {
    return 'view';
  }
  if (['impression', 'impressions', 'exposure'].includes(targetType)) {
    return 'impression';
  }
  if (['like', 'likes', 'note_likes'].includes(targetType)) {
    return 'like';
  }
  if (targetType === 'all') {
    return 'all';
  }

  const error = new Error('invalid target_type');
  error.statusCode = 400;
  throw error;
};

// 获取排名周期的时间范围
const rankingPeriodRange = (period) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (normalizeRankingPeriod(period) === 'today') {
    return {
      end: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000),
      start: todayStart,
    };
  }

  if (normalizeRankingPeriod(period) === 'yesterday') {
    return {
      end: todayStart,
      start: new Date(todayStart.getTime() - 24 * 60 * 60 * 1000),
    };
  }

  return {
    end: new Date('2100-01-01T00:00:00'),
    start: new Date('1970-01-01T00:00:00'),
  };
};

// 构建排名周期的查询条件
const buildPeriodClause = (column, period, params) => {
  const normalized = normalizeRankingPeriod(period);
  if (normalized === 'all') {
    return '';
  }

  const { start, end } = rankingPeriodRange(normalized);
  params.push(start, end);
  return ` AND ${column} >= ? AND ${column} < ?`;
};

// 获取当前用户信息
const getCurrentUser = async (db, userId) => {
  const [[user]] = await db.execute(
    `
      SELECT u.id, u.username, u.real_name, u.user_no, u.nickname, u.status,
        u.discount_rate, u.impression_discount_rate
      FROM users u
      WHERE u.id = ?
      LIMIT 1
    `,
    [userId],
  );

  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const [roles] = await db.execute(
    `
      SELECT r.code
      FROM roles r
      INNER JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ?
    `,
    [userId],
  );

  return {
    ...user,
    isAdmin: roles.some((role) => role.code === 'super' || role.code === 'admin'),
    roles: roles.map((role) => role.code),
  };
};

// 获取数值配置
const getNumericConfig = async (db, group, key, defaultValue) => {
  const [[row]] = await db.execute(
    `
      SELECT config_value
      FROM system_configs
      WHERE config_group = ? AND config_key = ? AND status = 'active'
      LIMIT 1
    `,
    [group, key],
  );

  if (!row) {
    return defaultValue;
  }

  try {
    const value = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value;
    const numberValue = Number(value?.value ?? value);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : defaultValue;
  } catch {
    return defaultValue;
  }
};

const getBoolConfig = async (db, group, key, defaultValue) => {
  const [[row]] = await db.execute(
    `
      SELECT config_value
      FROM system_configs
      WHERE config_group = ? AND config_key = ? AND status = 'active'
      LIMIT 1
    `,
    [group, key],
  );

  if (!row) {
    return defaultValue;
  }

  try {
    const value = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value;
    if (typeof value?.enabled === 'boolean') {
      return value.enabled;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    return defaultValue;
  } catch {
    return defaultValue;
  }
};

const sumScalar = async (db, sql, params = []) => {
  const [[row]] = await db.execute(sql, params);
  return Number(Object.values(row || {})[0]) || 0;
};

const selectRows = async (db, sql, params = []) => {
  const [rows] = await db.execute(sql, params);
  return rows;
};

const serializeOrderRows = (rows, batchMap = {}) =>
  rows.map((row) => ({
    ...row,
    batch_id: batchMap[row.batch_id] || String(row.batch_id || ''),
  }));

const loadBatchMap = async (db, rows) => {
  const ids = [...new Set(rows.map((row) => row.batch_id).filter(Boolean))];
  if (ids.length === 0) {
    return {};
  }

  const placeholders = ids.map(() => '?').join(', ');
  const [batches] = await db.execute(
    `SELECT id, batch_id FROM order_batches WHERE id IN (${placeholders})`,
    ids,
  );

  return Object.fromEntries(batches.map((batch) => [batch.id, batch.batch_id]));
};

const getUserRows = async (db, { keyword = '', limit, offset } = {}) => {
  const params = [];
  let where = `
    WHERE EXISTS (
      SELECT 1
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = u.id AND r.code = 'user'
    )
  `;

  const normalizedKeyword = String(keyword || '').trim();
  if (normalizedKeyword) {
    where += ' AND (u.username LIKE ? OR u.real_name LIKE ? OR u.user_no LIKE ? OR u.nickname LIKE ?)';
    const like = `%${normalizedKeyword}%`;
    params.push(like, like, like, like);
  }

  let limitSql = '';
  if (Number.isFinite(limit) && Number.isFinite(offset)) {
    limitSql = ` LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`;
  }

  const rows = await selectRows(
    db,
    `
      SELECT u.id, u.username, u.real_name, u.user_no, u.nickname, u.status,
        u.discount_rate, u.impression_discount_rate, u.created_at
      FROM users u
      ${where}
      ORDER BY u.id DESC
      ${limitSql}
    `,
    params,
  );

  return rows;
};

const countUserRows = async (db, keyword = '') => {
  const params = [];
  let where = `
    WHERE EXISTS (
      SELECT 1
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = u.id AND r.code = 'user'
    )
  `;

  const normalizedKeyword = String(keyword || '').trim();
  if (normalizedKeyword) {
    where += ' AND (u.username LIKE ? OR u.real_name LIKE ? OR u.user_no LIKE ? OR u.nickname LIKE ?)';
    const like = `%${normalizedKeyword}%`;
    params.push(like, like, like, like);
  }

  return sumScalar(db, `SELECT COUNT(1) AS total FROM users u ${where}`, params);
};

const queryUserAggregates = async (db, userIds, period = 'all', targetType = 'all') => {
  const balanceMap = {};
  const orderMap = {};
  const chargeMap = {};

  if (userIds.length === 0) {
    return { balanceMap, chargeMap, orderMap };
  }

  const placeholders = userIds.map(() => '?').join(', ');

  const orderParams = [...userIds];
  let orderWhere = `user_id IN (${placeholders})`;
  if (targetType === 'view' || targetType === 'impression' || targetType === 'like') {
    orderWhere += ' AND target_type = ?';
    orderParams.push(targetType);
  }
  orderWhere += buildPeriodClause('created_at', period, orderParams);

  const chargeParams = [...userIds, RECORD_TYPE.orderCharge, RECORD_STATUS.success];
  let chargeJoin = '';
  let chargeWhere = `ar.user_id IN (${placeholders}) AND ar.record_type = ? AND ar.status = ?`;
  if (targetType === 'view' || targetType === 'impression' || targetType === 'like') {
    chargeJoin = ' INNER JOIN orders o ON o.id = ar.order_id';
    chargeWhere += ' AND o.target_type = ?';
    chargeParams.push(targetType);
  }
  chargeWhere += buildPeriodClause('ar.created_at', period, chargeParams);

  const [balances, orderRows, chargeRows] = await Promise.all([
    selectRows(
      db,
      `SELECT user_id, available_amount FROM balance_accounts WHERE user_id IN (${placeholders})`,
      userIds,
    ),
    selectRows(
      db,
      `
        SELECT user_id,
          COUNT(1) AS order_total,
          COALESCE(SUM(ordered_quantity), 0) AS ordered_quantity_total,
          COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS completed_orders,
          COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS failed_orders,
          MAX(created_at) AS last_order_at
        FROM orders
        WHERE ${orderWhere}
        GROUP BY user_id
      `,
      [ORDER_STATUS.completed, ORDER_STATUS.failed, ...orderParams],
    ),
    selectRows(
      db,
      `
        SELECT ar.user_id,
          COALESCE(SUM(COALESCE(ar.actual_paid_amount, 0)), 0) AS charge_amount_total,
          COALESCE(SUM(COALESCE(ar.discount_amount, 0)), 0) AS discount_amount_total
        FROM account_records ar
        ${chargeJoin}
        WHERE ${chargeWhere}
        GROUP BY ar.user_id
      `,
      chargeParams,
    ),
  ]);

  for (const row of balances) {
    balanceMap[row.user_id] = Number(row.available_amount) || 0;
  }

  for (const row of orderRows) {
    orderMap[row.user_id] = {
      completed_orders: Number(row.completed_orders) || 0,
      failed_orders: Number(row.failed_orders) || 0,
      last_order_at: row.last_order_at || null,
      order_total: Number(row.order_total) || 0,
      ordered_quantity_total: Number(row.ordered_quantity_total) || 0,
    };
  }

  for (const row of chargeRows) {
    chargeMap[row.user_id] = {
      charge_amount_total: Number(row.charge_amount_total) || 0,
      discount_amount_total: Number(row.discount_amount_total) || 0,
    };
  }

  return { balanceMap, chargeMap, orderMap };
};

const buildUserDashboardRow = (user, balance, orderAgg = {}, chargeAgg = {}) => {
  const displayName = String(user.nickname || user.real_name || user.username || '').trim();
  const viewDiscountRate = normalizeDiscountRate(user.discount_rate);
  const impressionDiscountRate = normalizeDiscountRate(user.impression_discount_rate);

  return {
    available_balance: round4(balance),
    charge_amount_total: round4(chargeAgg.charge_amount_total),
    completed_orders: Number(orderAgg.completed_orders) || 0,
    created_at: user.created_at || null,
    discount_amount_total: round4(chargeAgg.discount_amount_total),
    discount_rate: viewDiscountRate,
    display_name: displayName || user.username,
    failed_orders: Number(orderAgg.failed_orders) || 0,
    impression_discount_rate: impressionDiscountRate,
    last_order_at: orderAgg.last_order_at || null,
    nickname: user.nickname || user.real_name || null,
    order_total: Number(orderAgg.order_total) || 0,
    ordered_quantity_total: Number(orderAgg.ordered_quantity_total) || 0,
    status: user.status || 'active',
    user_id: user.id,
    user_no: user.user_no || `U${String(user.id).padStart(6, '0')}`,
    username: user.username,
    view_discount_rate: viewDiscountRate,
  };
};

const getDashboardSummary = async (userId, rankingPeriod = 'all') => {
  const db = getPool();
  const currentUser = await getCurrentUser(db, userId);
  const isAdmin = currentUser.isAdmin;
  const scopeSql = isAdmin ? '' : ' WHERE user_id = ?';
  const scopeParams = isAdmin ? [] : [userId];
  const normalizedRankingPeriod = normalizeRankingPeriod(rankingPeriod);

  const [[orderStats]] = await db.execute(
    `
      SELECT
        COUNT(1) AS order_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS running_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS completed_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS failed_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS manual_review_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS repair_review_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS refund_requested_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS stopping_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS refund_calculating_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS refund_approved_total
      FROM orders
      ${scopeSql}
    `,
    [
      ORDER_STATUS.running,
      ORDER_STATUS.completed,
      ORDER_STATUS.failed,
      ORDER_STATUS.manualReview,
      ORDER_STATUS.repairReview,
      ORDER_STATUS.refundRequested,
      ORDER_STATUS.stopping,
      ORDER_STATUS.refundCalculating,
      ORDER_STATUS.refundApproved,
      ...scopeParams,
    ],
  );

  const recentBatches = await selectRows(
    db,
    `SELECT * FROM order_batches${scopeSql} ORDER BY id DESC LIMIT 5`,
    scopeParams,
  );
  const recentOrderRows = await selectRows(
    db,
    `SELECT * FROM orders${scopeSql} ORDER BY id DESC LIMIT 5`,
    scopeParams,
  );
  const recentRecordRows = await selectRows(
    db,
    `SELECT * FROM account_records${scopeSql} ORDER BY id DESC LIMIT 8`,
    scopeParams,
  );
  const batchMap = await loadBatchMap(db, recentOrderRows);
  const recentOrders = serializeOrderRows(recentOrderRows, batchMap);

  const retryableBatchItems = await sumScalar(
    db,
    `SELECT COALESCE(SUM(retryable_count), 0) AS total FROM order_batches${scopeSql}`,
    scopeParams,
  );
  const recentNetAmount = round4(
    recentRecordRows.reduce((total, row) => total + (Number(row.net_amount) || 0), 0),
  );

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const quantityWhere = isAdmin ? 'WHERE order_status <> ?' : 'WHERE order_status <> ? AND user_id = ?';
  const quantityParams = [
    yesterdayStart,
    todayStart,
    todayStart,
    tomorrowStart,
    ORDER_STATUS.failed,
    ...(isAdmin ? [] : [userId]),
  ];
  const [[quantityStats]] = await db.execute(
    `
      SELECT
        COALESCE(SUM(GREATEST(COALESCE(ordered_quantity, 0) - COALESCE(refunded_quantity, 0), 0)), 0) AS order_quantity_all,
        COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN GREATEST(COALESCE(ordered_quantity, 0) - COALESCE(refunded_quantity, 0), 0) ELSE 0 END), 0) AS order_quantity_yesterday,
        COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN GREATEST(COALESCE(ordered_quantity, 0) - COALESCE(refunded_quantity, 0), 0) ELSE 0 END), 0) AS order_quantity_today
      FROM orders
      ${quantityWhere}
    `,
    quantityParams,
  );

  const chargeWhere = isAdmin ? '' : ' AND user_id = ?';
  const chargeParams = [
    RECORD_TYPE.orderCharge,
    RECORD_STATUS.success,
    RECORD_TYPE.orderCharge,
    RECORD_STATUS.success,
    yesterdayStart,
    todayStart,
    RECORD_TYPE.orderCharge,
    RECORD_STATUS.success,
    todayStart,
    tomorrowStart,
    ...(isAdmin ? [] : [userId]),
  ];
  const [[chargeStats]] = await db.execute(
    `
      SELECT
        COALESCE(SUM(CASE WHEN record_type IN (?, 'refund') AND status = ? THEN -COALESCE(net_amount, 0) ELSE 0 END), 0) AS order_amount_all,
        COALESCE(SUM(CASE WHEN record_type IN (?, 'refund') AND status = ? AND created_at >= ? AND created_at < ? THEN -COALESCE(net_amount, 0) ELSE 0 END), 0) AS order_amount_yesterday,
        COALESCE(SUM(CASE WHEN record_type IN (?, 'refund') AND status = ? AND created_at >= ? AND created_at < ? THEN -COALESCE(net_amount, 0) ELSE 0 END), 0) AS order_amount_today
      FROM account_records
      WHERE 1 = 1
        ${chargeWhere}
    `,
    chargeParams,
  );

  const alertScopeSql = isAdmin ? '' : ' AND user_id = ?';
  const alertOrders = await selectRows(
    db,
    `
      SELECT * FROM orders
      WHERE order_status IN (?, ?, ?)
        ${alertScopeSql}
      ORDER BY updated_at DESC
      LIMIT 5
    `,
    [
      ORDER_STATUS.failed,
      ORDER_STATUS.manualReview,
      ORDER_STATUS.refundCalculating,
      ...(isAdmin ? [] : [userId]),
    ],
  );
  const alertBatchMap = await loadBatchMap(db, alertOrders);

  let xhsStats = {
    xhs_active_total: 0,
    xhs_cooling_total: 0,
    xhs_disabled_total: 0,
    xhs_invalid_total: 0,
    xhs_total: 0,
  };
  let riskAccounts = [];
  if (isAdmin) {
    const [[stats]] = await db.execute(
      `
        SELECT
          COUNT(1) AS xhs_total,
          COALESCE(SUM(CASE WHEN status = ? AND enabled = 1 THEN 1 ELSE 0 END), 0) AS xhs_active_total,
          COALESCE(SUM(CASE WHEN status = ? AND enabled = 1 THEN 1 ELSE 0 END), 0) AS xhs_cooling_total,
          COALESCE(SUM(CASE WHEN status = ? THEN 1 ELSE 0 END), 0) AS xhs_invalid_total,
          COALESCE(SUM(CASE WHEN status = ? THEN 1 ELSE 0 END), 0) AS xhs_disabled_total
        FROM xhs_query_accounts
      `,
      [XHS_STATUS.active, XHS_STATUS.cooling, XHS_STATUS.invalid, XHS_STATUS.disabled],
    );
    xhsStats = Object.fromEntries(
      Object.entries(stats || {}).map(([key, value]) => [key, Number(value) || 0]),
    );
    riskAccounts = await selectRows(
      db,
      `
        SELECT * FROM xhs_query_accounts
        WHERE status IN (?, ?) OR consecutive_failures >= ?
        ORDER BY updated_at DESC
        LIMIT 5
      `,
      [XHS_STATUS.cooling, XHS_STATUS.invalid, 2],
    );
  }

  const availableBalance = await sumScalar(
    db,
    'SELECT COALESCE(SUM(available_amount), 0) AS total FROM balance_accounts WHERE user_id = ?',
    [userId],
  );

  let apiCallStats = {
    preview_calls: 0, progress_calls: 0, stop_calls: 0, submit_calls: 0,
    today_calls: 0, total_calls: 0, week_calls: 0, yesterday_calls: 0,
  };
  try {
    apiCallStats = await openApiService.getApiCallStats(isAdmin ? null : userId);
  } catch {
    // table may not exist yet
  }

  const viewUnitPrice = await getNumericConfig(db, 'pricing', 'view_unit_price', 0.01);
  const impressionUnitPrice = await getNumericConfig(db, 'pricing', 'impression_unit_price', 0.01);
  const viewSubmitEnabled = await getBoolConfig(db, 'system', 'view_submit_enabled', true);
  const likeSubmitEnabled = await getBoolConfig(db, 'system', 'like_submit_enabled', true);
  const impressionSubmitEnabled = await getBoolConfig(db, 'system', 'impression_submit_enabled', true);
  const viewDiscountRate = normalizeDiscountRate(currentUser.discount_rate);
  const impressionDiscountRate = normalizeDiscountRate(currentUser.impression_discount_rate);

  return {
    alert_orders: serializeOrderRows(alertOrders, alertBatchMap),
    all_users_overview: [],
    api_call_stats: apiCallStats,
    is_admin: isAdmin,
    metrics: {
      available_balance: round4(availableBalance),
      completed_total: Number(orderStats.completed_total) || 0,
      failed_total: Number(orderStats.failed_total) || 0,
      manual_review_total:
        (Number(orderStats.manual_review_total) || 0) + (Number(orderStats.repair_review_total) || 0),
      order_amount_all: round4(chargeStats.order_amount_all),
      order_amount_today: round4(chargeStats.order_amount_today),
      order_amount_yesterday: round4(chargeStats.order_amount_yesterday),
      order_quantity_all: Number(quantityStats.order_quantity_all) || 0,
      order_quantity_today: Number(quantityStats.order_quantity_today) || 0,
      order_quantity_yesterday: Number(quantityStats.order_quantity_yesterday) || 0,
      order_total: Number(orderStats.order_total) || 0,
      recent_net_amount: recentNetAmount,
      refund_approved_total: Number(orderStats.refund_approved_total) || 0,
      refunding_total:
        (Number(orderStats.refund_requested_total) || 0) +
        (Number(orderStats.stopping_total) || 0) +
        (Number(orderStats.refund_calculating_total) || 0),
      retryable_batch_items: retryableBatchItems,
      running_total: Number(orderStats.running_total) || 0,
      xhs_active_total: xhsStats.xhs_active_total || 0,
      xhs_cooling_total: xhsStats.xhs_cooling_total || 0,
      xhs_disabled_total: xhsStats.xhs_disabled_total || 0,
      xhs_invalid_total: xhsStats.xhs_invalid_total || 0,
      xhs_total: xhsStats.xhs_total || 0,
    },
    pricing: {
      discounted_impression_unit_price: round4(impressionUnitPrice * impressionDiscountRate),
      discounted_view_unit_price: round4(viewUnitPrice * viewDiscountRate),
      discount_rate: viewDiscountRate,
      impression_discount_rate: impressionDiscountRate,
      impression_submit_enabled: impressionSubmitEnabled,
      impression_unit_price: impressionUnitPrice,
      like_submit_enabled: likeSubmitEnabled,
      view_discount_rate: viewDiscountRate,
      view_submit_enabled: viewSubmitEnabled,
      view_unit_price: viewUnitPrice,
    },
    ranking_period: normalizedRankingPeriod,
    rankings_by_amount: [],
    rankings_by_quantity: [],
    recent_batches: recentBatches,
    recent_orders: recentOrders,
    recent_records: recentRecordRows,
    risk_accounts: riskAccounts,
  };
};

const getDashboardRankings = async (userId, rankingPeriod = 'all', targetType = 'view') => {
  const db = getPool();
  const currentUser = await getCurrentUser(db, userId);
  const period = normalizeRankingPeriod(rankingPeriod);
  const normalizedTargetType = normalizeTargetType(targetType);

  if (!currentUser.isAdmin) {
    return {
      ranking_period: period,
      rankings_by_amount: [],
      rankings_by_quantity: [],
      target_type: normalizedTargetType,
    };
  }

  const users = await getUserRows(db);
  const userIds = users.map((user) => user.id);
  const { balanceMap, chargeMap, orderMap } = await queryUserAggregates(
    db,
    userIds,
    period,
    normalizedTargetType,
  );
  const rows = users.map((user) => buildUserDashboardRow(user, balanceMap[user.id], orderMap[user.id], chargeMap[user.id]));

  const rankingsByAmount = [...rows]
    .sort((a, b) => b.charge_amount_total - a.charge_amount_total || b.order_total - a.order_total)
    .slice(0, 10)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  const rankingsByQuantity = [...rows]
    .sort((a, b) => b.ordered_quantity_total - a.ordered_quantity_total || b.charge_amount_total - a.charge_amount_total)
    .slice(0, 10)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return {
    ranking_period: period,
    rankings_by_amount: rankingsByAmount,
    rankings_by_quantity: rankingsByQuantity,
    target_type: normalizedTargetType,
  };
};

const listAdminDashboardUsersOverview = async (userId, { keyword, page, pageSize }) => {
  const db = getPool();
  const currentUser = await getCurrentUser(db, userId);
  if (!currentUser.isAdmin) {
    const error = new Error('Forbidden');
    error.statusCode = 403;
    throw error;
  }

  const normalizedPage = clampPage(page);
  const normalizedPageSize = clampPageSize(pageSize);
  const total = await countUserRows(db, keyword);
  const users = await getUserRows(db, {
    keyword,
    limit: normalizedPageSize,
    offset: (normalizedPage - 1) * normalizedPageSize,
  });
  const userIds = users.map((user) => user.id);
  const { balanceMap, chargeMap, orderMap } = await queryUserAggregates(db, userIds, 'all', 'all');

  return {
    items: users.map((user) => buildUserDashboardRow(user, balanceMap[user.id], orderMap[user.id], chargeMap[user.id])),
    pagination: {
      page: normalizedPage,
      page_size: normalizedPageSize,
      total,
    },
  };
};

module.exports = {
  getDashboardRankings,
  getDashboardSummary,
  listAdminDashboardUsersOverview,
};
