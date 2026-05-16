const { getPool } = require('../config/database');

const ORDER_STATUS = {
  completed: 'completed',
  failed: 'failed',
  manualReview: 'manual_review',
  repairReview: 'repair_review',
  running: 'running',
};

const round4 = (value) => Math.round((Number(value) || 0) * 10_000) / 10_000;

const normalizeDiscountRate = (value) => {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) {
    return 1;
  }
  return round4(rate);
};

const getRoleLabel = (roles) => {
  if (roles.includes('super') || roles.includes('admin')) {
    return '管理员';
  }
  return '普通用户';
};

const getStatusLabel = (status) => {
  if (status === 'disabled') {
    return '已禁用';
  }
  if (status === 'locked') {
    return '已锁定';
  }
  return '正常';
};

const getUserProfile = async (userId) => {
  const db = getPool();
  const [[user]] = await db.execute(
    `
      SELECT id, username, real_name, nickname, user_no, status,
        discount_rate, impression_discount_rate, created_at
      FROM users
      WHERE id = ?
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
      ORDER BY FIELD(r.code, 'super', 'admin', 'user'), r.code
    `,
    [userId],
  );
  const roleCodes = roles.map((role) => role.code);

  const [[balance]] = await db.execute(
    `
      SELECT available_amount, updated_at
      FROM balance_accounts
      WHERE user_id = ?
      LIMIT 1
    `,
    [userId],
  );

  const [[orderStats]] = await db.execute(
    `
      SELECT
        COUNT(1) AS order_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS running_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS completed_total,
        COALESCE(SUM(CASE WHEN order_status = ? THEN 1 ELSE 0 END), 0) AS failed_total,
        COALESCE(SUM(CASE WHEN order_status IN (?, ?) THEN 1 ELSE 0 END), 0) AS manual_review_total,
        COALESCE(SUM(ordered_quantity), 0) AS ordered_quantity_total,
        COALESCE(SUM(completed_quantity), 0) AS completed_quantity_total
      FROM orders
      WHERE user_id = ?
    `,
    [
      ORDER_STATUS.running,
      ORDER_STATUS.completed,
      ORDER_STATUS.failed,
      ORDER_STATUS.manualReview,
      ORDER_STATUS.repairReview,
      userId,
    ],
  );

  const [recentOrders] = await db.execute(
    `
      SELECT order_no, target_type, ordered_quantity, completed_quantity,
        order_status, created_at, updated_at
      FROM orders
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 5
    `,
    [userId],
  );

  const [recentRecords] = await db.execute(
    `
      SELECT record_no, record_type, direction, status, order_no,
        actual_paid_amount, refund_amount, net_amount,
        before_available_amount, after_available_amount, reason_message, created_at
      FROM account_records
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 8
    `,
    [userId],
  );

  const displayName = String(user.nickname || user.real_name || user.username || '').trim();
  const viewDiscountRate = normalizeDiscountRate(user.discount_rate);
  const impressionDiscountRate = normalizeDiscountRate(user.impression_discount_rate);

  return {
    account: {
      account_status: getStatusLabel(user.status),
      created_at: user.created_at,
      display_name: displayName || user.username,
      role_label: getRoleLabel(roleCodes),
      roles: roleCodes,
      status: user.status || 'active',
      user_id: Number(user.id),
      user_no: user.user_no || `U${String(user.id).padStart(6, '0')}`,
      username: user.username,
    },
    balance: {
      available_amount: round4(balance?.available_amount),
      updated_at: balance?.updated_at || null,
    },
    discounts: {
      impression_discount_rate: impressionDiscountRate,
      view_discount_rate: viewDiscountRate,
    },
    order_stats: {
      completed_quantity_total: Number(orderStats.completed_quantity_total) || 0,
      completed_total: Number(orderStats.completed_total) || 0,
      failed_total: Number(orderStats.failed_total) || 0,
      manual_review_total: Number(orderStats.manual_review_total) || 0,
      order_total: Number(orderStats.order_total) || 0,
      ordered_quantity_total: Number(orderStats.ordered_quantity_total) || 0,
      running_total: Number(orderStats.running_total) || 0,
    },
    recent_orders: recentOrders.map((order) => ({
      ...order,
      completed_quantity: Number(order.completed_quantity) || 0,
      ordered_quantity: Number(order.ordered_quantity) || 0,
    })),
    recent_records: recentRecords.map((record) => ({
      ...record,
      actual_paid_amount: round4(record.actual_paid_amount),
      after_available_amount: round4(record.after_available_amount),
      before_available_amount: round4(record.before_available_amount),
      net_amount: round4(record.net_amount),
      refund_amount: round4(record.refund_amount),
    })),
  };
};

const formatDateTime = (value) => {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const getUserRoles = async (db, userId) => {
  const [roles] = await db.execute(
    `
      SELECT r.code
      FROM roles r
      INNER JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ?
    `,
    [userId],
  );
  return roles.map((role) => role.code);
};

const getUserNotifications = async (userId) => {
  const db = getPool();
  const roleCodes = await getUserRoles(db, userId);
  const isAdmin = roleCodes.some((role) => role === 'super' || role === 'admin');
  const items = [];

  if (isAdmin) {
    const [refundRows] = await db.execute(
      `
        SELECT o.id, o.order_no, o.refund_requested_at, o.updated_at,
          u.username, COALESCE(NULLIF(u.real_name, ''), NULLIF(u.nickname, ''), u.username) AS display_name
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        WHERE o.order_status IN ('refund_requested', 'refund_calculating', 'stopping')
        ORDER BY COALESCE(o.refund_requested_at, o.updated_at) DESC
        LIMIT 10
      `,
    );
    for (const row of refundRows) {
      items.push({
        date: formatDateTime(row.refund_requested_at || row.updated_at),
        id: `refund-review-${row.id}-${row.updated_at?.getTime?.() || row.updated_at}`,
        link: '/orders/refunds',
        message: `${row.display_name || row.username} 申请订单 ${row.order_no} 退款`,
        title: '退款待审核',
        type: 'warning',
      });
    }
  }

  const [ownRefundRows] = await db.execute(
    `
      SELECT id, order_no, order_status, refund_amount_total, updated_at, reason_message
      FROM orders
      WHERE user_id = ?
        AND order_status IN ('refund_approved', 'refund_rejected')
      ORDER BY updated_at DESC
      LIMIT 10
    `,
    [userId],
  );
  for (const row of ownRefundRows) {
    const approved = row.order_status === 'refund_approved';
    items.push({
      date: formatDateTime(row.updated_at),
      id: `refund-result-${row.id}-${row.order_status}-${row.updated_at?.getTime?.() || row.updated_at}`,
      link: '/orders/refunds',
      message: approved
        ? `订单 ${row.order_no} 已退款 ￥${Number(row.refund_amount_total || 0).toFixed(2)}`
        : `订单 ${row.order_no} 退款申请已拒绝`,
      title: approved ? '退款审核通过' : '退款审核拒绝',
      type: approved ? 'success' : 'danger',
    });
  }

  const orderScopeSql = isAdmin ? '' : 'AND o.user_id = ?';
  const orderScopeParams = isAdmin ? [] : [userId];
  const [alertRows] = await db.execute(
    `
      SELECT o.id, o.order_no, o.order_status, o.reason_message, o.updated_at,
        u.username, COALESCE(NULLIF(u.real_name, ''), NULLIF(u.nickname, ''), u.username) AS display_name
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE o.order_status IN ('failed', 'manual_review', 'repair_review')
        ${orderScopeSql}
      ORDER BY o.updated_at DESC
      LIMIT 10
    `,
    orderScopeParams,
  );
  for (const row of alertRows) {
    items.push({
      date: formatDateTime(row.updated_at),
      id: `order-alert-${row.id}-${row.order_status}-${row.updated_at?.getTime?.() || row.updated_at}`,
      link: '/orders/records',
      message: `${isAdmin ? `${row.display_name || row.username} 的` : ''}订单 ${row.order_no} 需要处理`,
      title: row.order_status === 'failed' ? '订单失败提醒' : '订单审核提醒',
      type: 'danger',
    });
  }

  const [[balance]] = await db.execute(
    'SELECT available_amount, updated_at FROM balance_accounts WHERE user_id = ? LIMIT 1',
    [userId],
  );
  if (Number(balance?.available_amount || 0) < 100) {
    items.push({
      date: formatDateTime(balance?.updated_at || new Date()),
      id: `low-balance-${userId}-${balance?.updated_at?.getTime?.() || balance?.updated_at || ''}`,
      link: '/profile',
      message: `当前可用余额 ￥${Number(balance?.available_amount || 0).toFixed(2)}，请及时关注`,
      title: '余额不足提醒',
      type: 'warning',
    });
  }

  return items
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 20);
};

module.exports = {
  getUserProfile,
  getUserNotifications,
};
