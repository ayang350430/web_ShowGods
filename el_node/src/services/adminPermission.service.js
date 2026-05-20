const { getPool } = require('../config/database');

const ADMIN_ROLES = new Set(['super', 'admin']);
const PRICE_MODES = new Set(['default', 'discount', 'fixed', 'quantity']);

let userPriceColumnsReady;

const ensureUserPriceColumns = async (db) => {
  if (!userPriceColumnsReady) {
    userPriceColumnsReady = (async () => {
      const ensureColumn = async (columnName, definition) => {
        const [columns] = await db.execute(
          `
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'users'
              AND COLUMN_NAME = ?
          `,
          [columnName],
        );
        if (columns.length === 0) {
          await db.execute(`ALTER TABLE users ADD COLUMN ${columnName} ${definition}`);
        }
      };

      await ensureColumn('price_mode', "VARCHAR(32) NOT NULL DEFAULT 'discount'");
      await ensureColumn('impression_price_mode', "VARCHAR(32) NOT NULL DEFAULT 'discount'");
      await ensureColumn('fixed_unit_price', 'DECIMAL(18,4) DEFAULT NULL');
      await ensureColumn('impression_fixed_unit_price', 'DECIMAL(18,4) DEFAULT NULL');
      await ensureColumn('quantity_price_base', 'INT UNSIGNED DEFAULT NULL');
      await ensureColumn('quantity_price_amount', 'DECIMAL(18,4) DEFAULT NULL');
      await ensureColumn('impression_quantity_price_base', 'INT UNSIGNED DEFAULT NULL');
      await ensureColumn('impression_quantity_price_amount', 'DECIMAL(18,4) DEFAULT NULL');
      await ensureColumn('like_discount_rate', 'DECIMAL(10,4) NOT NULL DEFAULT 1.0000');
      await ensureColumn('like_price_mode', "VARCHAR(32) NOT NULL DEFAULT 'discount'");
      await ensureColumn('like_fixed_unit_price', 'DECIMAL(18,4) DEFAULT NULL');
      await ensureColumn('like_quantity_price_base', 'INT UNSIGNED DEFAULT NULL');
      await ensureColumn('like_quantity_price_amount', 'DECIMAL(18,4) DEFAULT NULL');
      await ensureColumn('order_view_enabled', 'TINYINT(1) NOT NULL DEFAULT 1');
      await ensureColumn('order_like_enabled', 'TINYINT(1) NOT NULL DEFAULT 1');
      await ensureColumn('order_impression_enabled', 'TINYINT(1) NOT NULL DEFAULT 1');
    })();
  }

  await userPriceColumnsReady;
};

const getActor = async (db, userId) => {
  const [[user]] = await db.execute(
    'SELECT id, username, real_name, nickname, status, created_at FROM users WHERE id = ?',
    [userId],
  );

  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const [roles] = await db.execute(
    `
      SELECT r.code, r.name
      FROM roles r
      INNER JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ?
      ORDER BY FIELD(r.code, 'super', 'admin', 'user'), r.code
    `,
    [userId],
  );

  const roleCodes = roles.map((role) => role.code);
  return {
    ...user,
    isAdmin: roleCodes.some((role) => ADMIN_ROLES.has(role)),
    isSuper: roleCodes.includes('super'),
    roles: roleCodes,
  };
};

const assertAdmin = async (db, userId) => {
  const actor = await getActor(db, userId);
  if (!actor.isAdmin) {
    const error = new Error('Admin permission required');
    error.statusCode = 403;
    throw error;
  }

  return actor;
};

const ROLE_LABELS = { super: '超级管理员', admin: '管理员', user: '普通用户' };

const listRoles = async (actorUserId) => {
  const db = getPool();
  const actor = await assertAdmin(db, actorUserId);
  const [rows] = await db.execute(
    `
      SELECT code, name
      FROM roles
      WHERE code IN (${actor.isSuper ? "'super', 'admin', 'user'" : "'admin', 'user'"})
      ORDER BY FIELD(code, 'super', 'admin', 'user'), code
    `,
  );

  return rows.map((r) => ({ ...r, name: ROLE_LABELS[r.code] || r.name }));
};

const listUsers = async (actorUserId, query = {}) => {
  const { keyword = '', page, page_size: pageSize } = query;
  const db = getPool();
  await ensureUserPriceColumns(db);
  await assertAdmin(db, actorUserId);
  const paginationRequested = page !== undefined || pageSize !== undefined;

  const params = [];
  let where = '';
  const normalizedKeyword = String(keyword || '').trim();
  if (normalizedKeyword) {
    where = `
      WHERE u.username LIKE ?
        OR u.real_name LIKE ?
        OR u.nickname LIKE ?
        OR u.user_no LIKE ?
    `;
    const like = `%${normalizedKeyword}%`;
    params.push(like, like, like, like);
  }
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const offset = (safePage - 1) * safePageSize;
  const paginationSql = paginationRequested ? `LIMIT ${safePageSize} OFFSET ${offset}` : '';

  const [[countRow]] = await db.execute(
    `
      SELECT COUNT(*) AS total
      FROM users u
      ${where}
    `,
    params,
  );

  const [rows] = await db.execute(
    `
      SELECT
        u.id, u.username, u.real_name, u.nickname, u.user_no, u.status, u.created_at,
        u.discount_rate, u.impression_discount_rate, u.price_mode, u.impression_price_mode,
        u.fixed_unit_price, u.impression_fixed_unit_price,
        u.quantity_price_base, u.quantity_price_amount,
        u.impression_quantity_price_base, u.impression_quantity_price_amount,
        u.like_discount_rate, u.like_price_mode, u.like_fixed_unit_price,
        u.like_quantity_price_base, u.like_quantity_price_amount,
        u.order_view_enabled, u.order_like_enabled, u.order_impression_enabled,
        COALESCE(ba.available_amount, 0) AS available_amount,
        GROUP_CONCAT(r.code ORDER BY FIELD(r.code, 'super', 'admin', 'user'), r.code) AS role_codes,
        GROUP_CONCAT(r.name ORDER BY FIELD(r.code, 'super', 'admin', 'user'), r.code) AS role_names
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
      LEFT JOIN balance_accounts ba ON ba.user_id = u.id
      ${where}
      GROUP BY u.id
      ORDER BY u.id ASC
      ${paginationSql}
    `,
    params,
  );

  const items = rows.map((row) => ({
    created_at: row.created_at,
    display_name: row.nickname || row.real_name || row.username,
    available_amount: Number(row.available_amount) || 0,
    discount_rate: Number(row.discount_rate) || 1,
    fixed_unit_price: row.fixed_unit_price === null ? null : Number(row.fixed_unit_price),
    id: Number(row.id),
    impression_fixed_unit_price:
      row.impression_fixed_unit_price === null ? null : Number(row.impression_fixed_unit_price),
    impression_quantity_price_amount:
      row.impression_quantity_price_amount === null
        ? null
        : Number(row.impression_quantity_price_amount),
    impression_quantity_price_base:
      row.impression_quantity_price_base === null ? null : Number(row.impression_quantity_price_base),
    impression_discount_rate: Number(row.impression_discount_rate) || 1,
    impression_price_mode: PRICE_MODES.has(row.impression_price_mode)
      ? row.impression_price_mode
      : 'discount',
    like_discount_rate: Number(row.like_discount_rate) || 1,
    like_fixed_unit_price:
      row.like_fixed_unit_price === null ? null : Number(row.like_fixed_unit_price),
    like_price_mode: PRICE_MODES.has(row.like_price_mode) ? row.like_price_mode : 'discount',
    like_quantity_price_amount:
      row.like_quantity_price_amount === null ? null : Number(row.like_quantity_price_amount),
    like_quantity_price_base:
      row.like_quantity_price_base === null ? null : Number(row.like_quantity_price_base),
    order_view_enabled: row.order_view_enabled !== 0,
    order_like_enabled: row.order_like_enabled !== 0,
    order_impression_enabled: row.order_impression_enabled !== 0,
    price_mode: PRICE_MODES.has(row.price_mode) ? row.price_mode : 'discount',
    quantity_price_amount:
      row.quantity_price_amount === null ? null : Number(row.quantity_price_amount),
    quantity_price_base: row.quantity_price_base === null ? null : Number(row.quantity_price_base),
    real_name: row.real_name || '',
    role_names: row.role_codes
      ? row.role_codes.split(',').map((c) => ROLE_LABELS[c] || c)
      : [],
    roles: row.role_codes ? row.role_codes.split(',') : [],
    status: row.status || 'active',
    user_no: row.user_no || '',
    username: row.username,
  }));

  if (!paginationRequested) {
    return items;
  }

  return {
    items,
    page: safePage,
    page_size: safePageSize,
    total: Number(countRow.total) || 0,
  };
};

const updateUserRoles = async (actorUserId, targetUserId, roleCodes = []) => {
  const db = getPool();
  const actor = await assertAdmin(db, actorUserId);
  const targetId = Number(targetUserId);

  if (!targetId) {
    const error = new Error('Invalid target user');
    error.statusCode = 400;
    throw error;
  }
  if (targetId === Number(actorUserId)) {
    const error = new Error('Cannot modify your own roles');
    error.statusCode = 400;
    throw error;
  }

  const safeRoleCodes = [...new Set(roleCodes.map((role) => String(role).trim()).filter(Boolean))];
  if (safeRoleCodes.length === 0) {
    const error = new Error('At least one role is required');
    error.statusCode = 400;
    throw error;
  }
  if (!actor.isSuper && safeRoleCodes.includes('super')) {
    const error = new Error('Only super users can assign super role');
    error.statusCode = 403;
    throw error;
  }

  const [roles] = await db.execute(
    `SELECT id, code FROM roles WHERE code IN (${safeRoleCodes.map(() => '?').join(',')})`,
    safeRoleCodes,
  );
  if (roles.length !== safeRoleCodes.length) {
    const error = new Error('Invalid role code');
    error.statusCode = 400;
    throw error;
  }

  const [[target]] = await db.execute('SELECT id FROM users WHERE id = ?', [targetId]);
  if (!target) {
    const error = new Error('Target user not found');
    error.statusCode = 404;
    throw error;
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM user_roles WHERE user_id = ?', [targetId]);
    for (const role of roles) {
      await connection.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [
        targetId,
        role.id,
      ]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return {
    roles: safeRoleCodes,
    user_id: targetId,
  };
};

const updateUserStatus = async (actorUserId, targetUserId, status) => {
  const db = getPool();
  await assertAdmin(db, actorUserId);
  const targetId = Number(targetUserId);
  const nextStatus = String(status || '').trim();

  if (!targetId) {
    const error = new Error('Invalid target user');
    error.statusCode = 400;
    throw error;
  }
  if (targetId === Number(actorUserId)) {
    const error = new Error('Cannot modify your own status');
    error.statusCode = 400;
    throw error;
  }
  if (!['active', 'disabled'].includes(nextStatus)) {
    const error = new Error('Invalid user status');
    error.statusCode = 400;
    throw error;
  }

  const [result] = await db.execute('UPDATE users SET status = ? WHERE id = ?', [
    nextStatus,
    targetId,
  ]);

  if (result.affectedRows === 0) {
    const error = new Error('Target user not found');
    error.statusCode = 404;
    throw error;
  }

  return {
    status: nextStatus,
    user_id: targetId,
  };
};

const normalizeDiscountRateInput = (value, fieldName) => {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
    const error = new Error(`${fieldName} must be greater than 0 and less than or equal to 1`);
    error.statusCode = 400;
    throw error;
  }

  return Math.round(rate * 10_000) / 10_000;
};

const normalizePriceModeInput = (value, fallback = 'discount') => {
  const mode = String(value || fallback).trim();
  return PRICE_MODES.has(mode) ? mode : fallback;
};

const normalizeFixedPriceInput = (value, fieldName) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) {
    const error = new Error(`${fieldName} must be greater than 0`);
    error.statusCode = 400;
    throw error;
  }
  return Math.round(price * 10_000) / 10_000;
};

const normalizeQuantityBaseInput = (value, fieldName) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    const error = new Error(`${fieldName} must be a positive integer`);
    error.statusCode = 400;
    throw error;
  }
  return quantity;
};

const updateUserDiscounts = async (
  actorUserId,
  targetUserId,
  {
    discount_rate: viewDiscountRate,
    fixed_unit_price: viewFixedUnitPrice,
    impression_discount_rate: impressionDiscountRate,
    impression_fixed_unit_price: impressionFixedUnitPrice,
    impression_price_mode: impressionPriceMode,
    impression_quantity_price_amount: impressionQuantityPriceAmount,
    impression_quantity_price_base: impressionQuantityPriceBase,
    like_discount_rate: likeDiscountRate,
    like_fixed_unit_price: likeFixedUnitPrice,
    like_price_mode: likePriceMode,
    like_quantity_price_amount: likeQuantityPriceAmount,
    like_quantity_price_base: likeQuantityPriceBase,
    price_mode: viewPriceMode,
    quantity_price_amount: viewQuantityPriceAmount,
    quantity_price_base: viewQuantityPriceBase,
  } = {},
) => {
  const db = getPool();
  await ensureUserPriceColumns(db);
  await assertAdmin(db, actorUserId);
  const targetId = Number(targetUserId);

  if (!targetId) {
    const error = new Error('Invalid target user');
    error.statusCode = 400;
    throw error;
  }

  const nextViewDiscountRate = normalizeDiscountRateInput(viewDiscountRate, 'discount_rate');
  const nextImpressionDiscountRate = normalizeDiscountRateInput(
    impressionDiscountRate,
    'impression_discount_rate',
  );
  const nextLikeDiscountRate = normalizeDiscountRateInput(
    likeDiscountRate === undefined ? viewDiscountRate : likeDiscountRate,
    'like_discount_rate',
  );
  const nextViewPriceMode = normalizePriceModeInput(viewPriceMode);
  const nextImpressionPriceMode = normalizePriceModeInput(impressionPriceMode);
  const nextLikePriceMode = normalizePriceModeInput(likePriceMode, nextViewPriceMode);
  const nextViewFixedUnitPrice = normalizeFixedPriceInput(viewFixedUnitPrice, 'fixed_unit_price');
  const nextImpressionFixedUnitPrice = normalizeFixedPriceInput(
    impressionFixedUnitPrice,
    'impression_fixed_unit_price',
  );
  const nextViewQuantityPriceBase = normalizeQuantityBaseInput(
    viewQuantityPriceBase,
    'quantity_price_base',
  );
  const nextViewQuantityPriceAmount = normalizeFixedPriceInput(
    viewQuantityPriceAmount,
    'quantity_price_amount',
  );
  const nextImpressionQuantityPriceBase = normalizeQuantityBaseInput(
    impressionQuantityPriceBase,
    'impression_quantity_price_base',
  );
  const nextImpressionQuantityPriceAmount = normalizeFixedPriceInput(
    impressionQuantityPriceAmount,
    'impression_quantity_price_amount',
  );
  const nextLikeFixedUnitPrice = normalizeFixedPriceInput(
    likeFixedUnitPrice === undefined ? viewFixedUnitPrice : likeFixedUnitPrice,
    'like_fixed_unit_price',
  );
  const nextLikeQuantityPriceBase = normalizeQuantityBaseInput(
    likeQuantityPriceBase === undefined ? viewQuantityPriceBase : likeQuantityPriceBase,
    'like_quantity_price_base',
  );
  const nextLikeQuantityPriceAmount = normalizeFixedPriceInput(
    likeQuantityPriceAmount === undefined ? viewQuantityPriceAmount : likeQuantityPriceAmount,
    'like_quantity_price_amount',
  );

  if (nextViewPriceMode === 'quantity' && (!nextViewQuantityPriceBase || !nextViewQuantityPriceAmount)) {
    const error = new Error('quantity price requires quantity_price_base and quantity_price_amount');
    error.statusCode = 400;
    throw error;
  }
  if (
    nextImpressionPriceMode === 'quantity' &&
    (!nextImpressionQuantityPriceBase || !nextImpressionQuantityPriceAmount)
  ) {
    const error = new Error(
      'impression quantity price requires impression_quantity_price_base and impression_quantity_price_amount',
    );
    error.statusCode = 400;
    throw error;
  }
  if (nextLikePriceMode === 'quantity' && (!nextLikeQuantityPriceBase || !nextLikeQuantityPriceAmount)) {
    const error = new Error(
      'like quantity price requires like_quantity_price_base and like_quantity_price_amount',
    );
    error.statusCode = 400;
    throw error;
  }

  const [result] = await db.execute(
    `
      UPDATE users
      SET discount_rate = ?,
          impression_discount_rate = ?,
          price_mode = ?,
          impression_price_mode = ?,
          fixed_unit_price = ?,
          impression_fixed_unit_price = ?,
          quantity_price_base = ?,
          quantity_price_amount = ?,
          impression_quantity_price_base = ?,
          impression_quantity_price_amount = ?,
          like_discount_rate = ?,
          like_price_mode = ?,
          like_fixed_unit_price = ?,
          like_quantity_price_base = ?,
          like_quantity_price_amount = ?
      WHERE id = ?
    `,
    [
      nextViewDiscountRate,
      nextImpressionDiscountRate,
      nextViewPriceMode,
      nextImpressionPriceMode,
      nextViewFixedUnitPrice,
      nextImpressionFixedUnitPrice,
      nextViewQuantityPriceBase,
      nextViewQuantityPriceAmount,
      nextImpressionQuantityPriceBase,
      nextImpressionQuantityPriceAmount,
      nextLikeDiscountRate,
      nextLikePriceMode,
      nextLikeFixedUnitPrice,
      nextLikeQuantityPriceBase,
      nextLikeQuantityPriceAmount,
      targetId,
    ],
  );

  if (result.affectedRows === 0) {
    const error = new Error('Target user not found');
    error.statusCode = 404;
    throw error;
  }

  return {
    discount_rate: nextViewDiscountRate,
    fixed_unit_price: nextViewFixedUnitPrice,
    impression_discount_rate: nextImpressionDiscountRate,
    impression_fixed_unit_price: nextImpressionFixedUnitPrice,
    impression_quantity_price_amount: nextImpressionQuantityPriceAmount,
    impression_quantity_price_base: nextImpressionQuantityPriceBase,
    impression_price_mode: nextImpressionPriceMode,
    like_discount_rate: nextLikeDiscountRate,
    like_fixed_unit_price: nextLikeFixedUnitPrice,
    like_price_mode: nextLikePriceMode,
    like_quantity_price_amount: nextLikeQuantityPriceAmount,
    like_quantity_price_base: nextLikeQuantityPriceBase,
    price_mode: nextViewPriceMode,
    quantity_price_amount: nextViewQuantityPriceAmount,
    quantity_price_base: nextViewQuantityPriceBase,
    user_id: targetId,
  };
};

const updateUserBalance = async (actorUserId, targetUserId, { amount, reason } = {}) => {
  const db = getPool();
  await assertAdmin(db, actorUserId);
  const targetId = Number(targetUserId);
  const nextAmount = Number(amount);

  if (!targetId) {
    const error = new Error('Invalid target user');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(nextAmount) || nextAmount < 0) {
    const error = new Error('Balance amount must be greater than or equal to 0');
    error.statusCode = 400;
    throw error;
  }

  const [[target]] = await db.execute('SELECT id, username FROM users WHERE id = ?', [targetId]);
  if (!target) {
    const error = new Error('Target user not found');
    error.statusCode = 404;
    throw error;
  }

  const connection = await db.getConnection();
  const now = new Date();
  const roundedAmount = Math.round(nextAmount * 10_000) / 10_000;
  try {
    await connection.beginTransaction();
    await connection.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (?, 0) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)',
      [targetId],
    );
    const [[balance]] = await connection.execute(
      'SELECT available_amount FROM balance_accounts WHERE user_id = ? FOR UPDATE',
      [targetId],
    );
    const beforeAmount = Number(balance?.available_amount) || 0;
    const delta = Math.round((roundedAmount - beforeAmount) * 10_000) / 10_000;
    await connection.execute(
      'UPDATE balance_accounts SET available_amount = ?, updated_at = ? WHERE user_id = ?',
      [roundedAmount, now, targetId],
    );
    await connection.execute(
      `
        INSERT INTO account_records
          (
            record_no, user_id, record_type, direction, status, actual_paid_amount,
            net_amount, before_available_amount, after_available_amount,
            reason_code, reason_message, remark, created_at, updated_at
          )
        VALUES (?, ?, 'balance_adjustment', ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        `BAL-${Date.now()}-${targetId}`,
        targetId,
        delta >= 0 ? 'credit' : 'debit',
        Math.abs(delta),
        delta,
        beforeAmount,
        roundedAmount,
        'admin_balance_update',
        reason || `管理员调整余额为 ${roundedAmount.toFixed(4)}`,
        `operator=${actorUserId}`,
        now,
        now,
      ],
    );
    await connection.commit();

    return {
      after_available_amount: roundedAmount,
      before_available_amount: beforeAmount,
      delta_amount: delta,
      user_id: targetId,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const updateUserOrderTypes = async (actorUserId, targetUserId, { order_view_enabled, order_like_enabled, order_impression_enabled } = {}) => {
  const db = getPool();
  await ensureUserPriceColumns(db);
  await assertAdmin(db, actorUserId);
  const targetId = Number(targetUserId);

  if (!targetId) {
    const error = new Error('Invalid target user');
    error.statusCode = 400;
    throw error;
  }

  const viewEnabled = order_view_enabled === false ? 0 : 1;
  const likeEnabled = order_like_enabled === false ? 0 : 1;
  const impressionEnabled = order_impression_enabled === false ? 0 : 1;

  const [result] = await db.execute(
    'UPDATE users SET order_view_enabled = ?, order_like_enabled = ?, order_impression_enabled = ? WHERE id = ?',
    [viewEnabled, likeEnabled, impressionEnabled, targetId],
  );

  if (result.affectedRows === 0) {
    const error = new Error('Target user not found');
    error.statusCode = 404;
    throw error;
  }

  return {
    order_impression_enabled: impressionEnabled === 1,
    order_like_enabled: likeEnabled === 1,
    order_view_enabled: viewEnabled === 1,
    user_id: targetId,
  };
};

module.exports = {
  listRoles,
  listUsers,
  updateUserBalance,
  updateUserDiscounts,
  updateUserOrderTypes,
  updateUserStatus,
  updateUserRoles,
};
