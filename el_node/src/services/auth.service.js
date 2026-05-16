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

module.exports = {
  login,
  register,
};
