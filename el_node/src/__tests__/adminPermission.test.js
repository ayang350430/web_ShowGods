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
