const { getPool } = require('../config/database');

const ADMIN_ROLES = new Set(['super', 'admin']);
const PRICE_MODES = new Set(['default', 'discount', 'fixed']);

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

  return rows;
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
        GROUP_CONCAT(r.code ORDER BY FIELD(r.code, 'super', 'admin', 'user'), r.code) AS role_codes,
        GROUP_CONCAT(r.name ORDER BY FIELD(r.code, 'super', 'admin', 'user'), r.code) AS role_names
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
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
    discount_rate: Number(row.discount_rate) || 1,
    fixed_unit_price: row.fixed_unit_price === null ? null : Number(row.fixed_unit_price),
    id: Number(row.id),
    impression_fixed_unit_price:
      row.impression_fixed_unit_price === null ? null : Number(row.impression_fixed_unit_price),
    impression_discount_rate: Number(row.impression_discount_rate) || 1,
    impression_price_mode: PRICE_MODES.has(row.impression_price_mode)
      ? row.impression_price_mode
      : 'discount',
    price_mode: PRICE_MODES.has(row.price_mode) ? row.price_mode : 'discount',
    real_name: row.real_name || '',
    role_names: row.role_names ? row.role_names.split(',') : [],
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

const updateUserDiscounts = async (
  actorUserId,
  targetUserId,
  {
    discount_rate: viewDiscountRate,
    fixed_unit_price: viewFixedUnitPrice,
    impression_discount_rate: impressionDiscountRate,
    impression_fixed_unit_price: impressionFixedUnitPrice,
    impression_price_mode: impressionPriceMode,
    price_mode: viewPriceMode,
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
  const nextViewPriceMode = normalizePriceModeInput(viewPriceMode);
  const nextImpressionPriceMode = normalizePriceModeInput(impressionPriceMode);
  const nextViewFixedUnitPrice = normalizeFixedPriceInput(viewFixedUnitPrice, 'fixed_unit_price');
  const nextImpressionFixedUnitPrice = normalizeFixedPriceInput(
    impressionFixedUnitPrice,
    'impression_fixed_unit_price',
  );

  const [result] = await db.execute(
    `
      UPDATE users
      SET discount_rate = ?,
          impression_discount_rate = ?,
          price_mode = ?,
          impression_price_mode = ?,
          fixed_unit_price = ?,
          impression_fixed_unit_price = ?
      WHERE id = ?
    `,
    [
      nextViewDiscountRate,
      nextImpressionDiscountRate,
      nextViewPriceMode,
      nextImpressionPriceMode,
      nextViewFixedUnitPrice,
      nextImpressionFixedUnitPrice,
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
    impression_price_mode: nextImpressionPriceMode,
    price_mode: nextViewPriceMode,
    user_id: targetId,
  };
};

module.exports = {
  listRoles,
  listUsers,
  updateUserDiscounts,
  updateUserStatus,
  updateUserRoles,
};
