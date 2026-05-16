const request = require('supertest');

const app = require('../app');
const { closePool, initializeDatabase } = require('../config/database');

beforeAll(async () => {
  await initializeDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('user profile endpoint', () => {
  test('returns account, balance, discount, order, and record data for the profile page', async () => {
    const response = await request(app).get('/api/user/profile');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      code: 0,
      message: 'ok',
      data: {
        account: {
          account_status: expect.any(String),
          display_name: expect.any(String),
          role_label: expect.any(String),
          roles: expect.any(Array),
          user_id: expect.any(Number),
          user_no: expect.any(String),
          username: expect.any(String),
        },
        balance: {
          available_amount: expect.any(Number),
        },
        discounts: {
          impression_discount_rate: expect.any(Number),
          view_discount_rate: expect.any(Number),
        },
        order_stats: {
          completed_total: expect.any(Number),
          failed_total: expect.any(Number),
          order_total: expect.any(Number),
          running_total: expect.any(Number),
        },
        recent_orders: expect.any(Array),
        recent_records: expect.any(Array),
      },
    });
  });
});
