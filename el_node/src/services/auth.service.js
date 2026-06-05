const bcrypt = require('bcryptjs');

const { getPool } = require('../config/database');

const login = async ({ username, password }) => {
  const db = getPool();
  const [rows] = await db.execute(
    'SELECT id, username, password_hash, status FROM users WHERE username = ? LIMIT 1',
    [username],
  );

  const user = rows[0];
  if (!user) {
    return null;
  }

  const isValidPassword = await bcrypt.compare(password, user.password_hash);
  if (!isValidPassword) {
    return null;
  }
  if (user.status && user.status !== 'active') {
    const error = new Error('Account disabled');
    error.statusCode = 403;
    throw error;
  }

  return {
    id: user.id,
    username: user.username,
  };
};

const register = async ({ username, password }) => {
  const db = getPool();
  const [existingUsers] = await db.execute('SELECT id FROM users WHERE username = ?', [
    username,
  ]);

  if (existingUsers.length > 0) {
    const error = new Error('Username already exists');
    error.statusCode = 409;
    throw error;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const [result] = await db.execute(
    'INSERT INTO users (username, password_hash, real_name, home_path, nickname) VALUES (?, ?, ?, ?, ?)',
    [username, passwordHash, username, '/analytics', username],
  );
  await db.execute(
    "UPDATE users SET user_no = CONCAT('U', LPAD(id, 6, '0')) WHERE id = ?",
    [result.insertId],
  );
  await db.execute(
    'INSERT IGNORE INTO balance_accounts (user_id, available_amount) VALUES (?, 0)',
    [result.insertId],
  );

  const [[userRole]] = await db.execute('SELECT id FROM roles WHERE code = ?', ['user']);

  if (userRole) {
    await db.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [
      result.insertId,
      userRole.id,
    ]);
  }

  return {
    id: result.insertId,
    username,
  };
};

const requestPasswordReset = async ({ username }) => {
  const db = getPool();
  const [[user]] = await db.execute(
    'SELECT id, username, real_name FROM users WHERE username = ? LIMIT 1',
    [username],
  );
  if (!user) {
    const error = new Error('账号不存在');
    error.statusCode = 404;
    throw error;
  }

  // 防重复：5 分钟内同一用户只能提交一次
  const [[recent]] = await db.execute(
    `SELECT id FROM password_reset_requests
     WHERE user_id = ? AND status = 'pending' AND created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)
     LIMIT 1`,
    [user.id],
  );
  if (recent) {
    const error = new Error('已提交过申请，请等待管理员处理');
    error.statusCode = 429;
    throw error;
  }

  await db.execute(
    `INSERT INTO password_reset_requests (user_id, username, status, created_at)
     VALUES (?, ?, 'pending', NOW())`,
    [user.id, user.username],
  );

  return { username: user.username };
};

const getPasswordResetRequests = async () => {
  const db = getPool();
  const [rows] = await db.execute(
    `SELECT pr.id, pr.user_id, pr.username, u.real_name, pr.status, pr.created_at, pr.handled_at
     FROM password_reset_requests pr
     LEFT JOIN users u ON u.id = pr.user_id
     ORDER BY pr.id DESC
     LIMIT 50`,
  );
  return rows;
};

const handlePasswordResetRequest = async (requestId, { action, newPassword }) => {
  const db = getPool();
  const [[req]] = await db.execute(
    'SELECT id, user_id, status FROM password_reset_requests WHERE id = ? LIMIT 1',
    [requestId],
  );
  if (!req) {
    const error = new Error('申请不存在');
    error.statusCode = 404;
    throw error;
  }
  if (req.status !== 'pending') {
    const error = new Error('该申请已处理');
    error.statusCode = 400;
    throw error;
  }

  if (action === 'approve') {
    if (!newPassword || newPassword.length < 6) {
      const error = new Error('新密码至少 6 位');
      error.statusCode = 400;
      throw error;
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.user_id]);
    await db.execute(
      "UPDATE password_reset_requests SET status = 'approved', handled_at = NOW() WHERE id = ?",
      [requestId],
    );
    return { status: 'approved' };
  }

  await db.execute(
    "UPDATE password_reset_requests SET status = 'rejected', handled_at = NOW() WHERE id = ?",
    [requestId],
  );
  return { status: 'rejected' };
};

module.exports = {
  getPasswordResetRequests,
  handlePasswordResetRequest,
  login,
  register,
  requestPasswordReset,
};
