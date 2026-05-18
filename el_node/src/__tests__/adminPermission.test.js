const request = require('supertest');

const app = require('../app');
const { closePool, getPool, initializeDatabase } = require('../config/database');

beforeAll(async () => {
  await initializeDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('admin permission management', () => {
  test('blocks normal users from permission management APIs', async () => {
    const registerResponse = await request(app).post('/api/auth/register').send({
      password: 'userpass123',
      username: `normal_${Date.now()}`,
    });
    const userId = registerResponse.body.data.id;

    const response = await request(app)
      .get('/api/v1/admin/permissions/users')
      .set('Authorization', `Bearer dev-token-${userId}`);

    expect(response.status).toBe(403);
  });

  test('allows admin to list users and update another user roles', async () => {
    const registerResponse = await request(app).post('/api/auth/register').send({
      password: 'userpass123',
      username: `target_${Date.now()}`,
    });
    const targetUserId = registerResponse.body.data.id;

    const listResponse = await request(app).get('/api/v1/admin/permissions/users');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.some((user) => user.id === targetUserId)).toBe(true);

    const updateResponse = await request(app)
      .put(`/api/v1/admin/permissions/users/${targetUserId}/roles`)
      .send({ roles: ['admin'] });
    expect(updateResponse.status).toBe(200);

    const db = getPool();
    const [roles] = await db.execute(
      `
        SELECT r.code
        FROM roles r
        INNER JOIN user_roles ur ON ur.role_id = r.id
        WHERE ur.user_id = ?
      `,
      [targetUserId],
    );
    expect(roles.map((role) => role.code)).toEqual(['admin']);
  });

  test('does not allow admin to modify own roles', async () => {
    const response = await request(app)
      .put('/api/v1/admin/permissions/users/1/roles')
      .send({ roles: ['user'] });

    expect(response.status).toBe(400);
  });

  test('allows admin to disable another user and blocks disabled login', async () => {
    const password = 'userpass123';
    const username = `disabled_${Date.now()}`;
    const registerResponse = await request(app).post('/api/auth/register').send({
      password,
      username,
    });
    const targetUserId = registerResponse.body.data.id;

    const updateResponse = await request(app)
      .put(`/api/v1/admin/permissions/users/${targetUserId}/status`)
      .send({ status: 'disabled' });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.data.status).toBe('disabled');

    const loginResponse = await request(app).post('/api/auth/login').send({
      password,
      username,
    });
    expect(loginResponse.status).toBe(403);
  });

  test('does not allow admin to modify own status', async () => {
    const response = await request(app)
      .put('/api/v1/admin/permissions/users/1/status')
      .send({ status: 'disabled' });

    expect(response.status).toBe(400);
  });

  test('allows admin to update user discounts', async () => {
    const registerResponse = await request(app).post('/api/auth/register').send({
      password: 'userpass123',
      username: `discount_${Date.now()}`,
    });
    const targetUserId = registerResponse.body.data.id;

    const response = await request(app)
      .put(`/api/v1/admin/permissions/users/${targetUserId}/discounts`)
      .send({
        discount_rate: 0.5,
        impression_discount_rate: 0.8,
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      discount_rate: 0.5,
      impression_discount_rate: 0.8,
      user_id: targetUserId,
    });

    const db = getPool();
    const [[user]] = await db.execute(
      'SELECT discount_rate, impression_discount_rate FROM users WHERE id = ?',
      [targetUserId],
    );
    expect(Number(user.discount_rate)).toBe(0.5);
    expect(Number(user.impression_discount_rate)).toBe(0.8);
  });

  test('allows admin to update quantity based prices', async () => {
    const registerResponse = await request(app).post('/api/auth/register').send({
      password: 'userpass123',
      username: `quantity_price_${Date.now()}`,
    });
    const targetUserId = registerResponse.body.data.id;

    const response = await request(app)
      .put(`/api/v1/admin/permissions/users/${targetUserId}/discounts`)
      .send({
        discount_rate: 1,
        fixed_unit_price: null,
        impression_discount_rate: 1,
        impression_fixed_unit_price: null,
        impression_price_mode: 'quantity',
        impression_quantity_price_amount: 12.5,
        impression_quantity_price_base: 1000,
        like_discount_rate: 1,
        like_fixed_unit_price: null,
        like_price_mode: 'quantity',
        like_quantity_price_amount: 8,
        like_quantity_price_base: 100,
        price_mode: 'quantity',
        quantity_price_amount: 30,
        quantity_price_base: 1000,
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      impression_price_mode: 'quantity',
      impression_quantity_price_amount: 12.5,
      impression_quantity_price_base: 1000,
      like_price_mode: 'quantity',
      like_quantity_price_amount: 8,
      like_quantity_price_base: 100,
      price_mode: 'quantity',
      quantity_price_amount: 30,
      quantity_price_base: 1000,
      user_id: targetUserId,
    });

    const db = getPool();
    const [[user]] = await db.execute(
      `
        SELECT price_mode, quantity_price_base, quantity_price_amount,
          impression_price_mode, impression_quantity_price_base, impression_quantity_price_amount,
          like_price_mode, like_quantity_price_base, like_quantity_price_amount
        FROM users
        WHERE id = ?
      `,
      [targetUserId],
    );
    expect(user.price_mode).toBe('quantity');
    expect(Number(user.quantity_price_base)).toBe(1000);
    expect(Number(user.quantity_price_amount)).toBe(30);
    expect(user.impression_price_mode).toBe('quantity');
    expect(Number(user.impression_quantity_price_base)).toBe(1000);
    expect(Number(user.impression_quantity_price_amount)).toBe(12.5);
    expect(user.like_price_mode).toBe('quantity');
    expect(Number(user.like_quantity_price_base)).toBe(100);
    expect(Number(user.like_quantity_price_amount)).toBe(8);
  });

  test('allows admin to set user balance and writes an account record', async () => {
    const registerResponse = await request(app).post('/api/auth/register').send({
      password: 'userpass123',
      username: `balance_${Date.now()}`,
    });
    const targetUserId = registerResponse.body.data.id;

    const response = await request(app)
      .put(`/api/v1/admin/permissions/users/${targetUserId}/balance`)
      .send({ amount: 1234.56, reason: 'test balance set' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      after_available_amount: 1234.56,
      before_available_amount: 0,
      delta_amount: 1234.56,
      user_id: targetUserId,
    });

    const db = getPool();
    const [[balance]] = await db.execute(
      'SELECT available_amount FROM balance_accounts WHERE user_id = ?',
      [targetUserId],
    );
    expect(Number(balance.available_amount)).toBe(1234.56);

    const [[record]] = await db.execute(
      `
        SELECT record_type, direction, net_amount, before_available_amount, after_available_amount, reason_message
        FROM account_records
        WHERE user_id = ? AND record_type = 'balance_adjustment'
        ORDER BY id DESC
        LIMIT 1
      `,
      [targetUserId],
    );
    expect(record).toMatchObject({
      direction: 'credit',
      reason_message: 'test balance set',
      record_type: 'balance_adjustment',
    });
    expect(Number(record.net_amount)).toBe(1234.56);
    expect(Number(record.before_available_amount)).toBe(0);
    expect(Number(record.after_available_amount)).toBe(1234.56);
  });

  test('rejects invalid user discounts', async () => {
    const response = await request(app)
      .put('/api/v1/admin/permissions/users/2/discounts')
      .send({
        discount_rate: 0,
        impression_discount_rate: 1.2,
      });

    expect(response.status).toBe(400);
  });
});
