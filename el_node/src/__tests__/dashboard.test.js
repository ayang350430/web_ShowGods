const request = require('supertest');

const app = require('../app');
const { closePool, getPool, initializeDatabase } = require('../config/database');

beforeAll(async () => {
  process.env.SEED_DEMO_DATA = 'true';
  await initializeDatabase();
});

afterAll(async () => {
  process.env.SEED_DEMO_DATA = 'false';
  await initializeDatabase();
  delete process.env.SEED_DEMO_DATA;
  await closePool();
});

describe('goods dashboard endpoints', () => {
  test('returns the dashboard summary in the goods homepage shape', async () => {
    const response = await request(app).get('/api/v1/dashboard/summary');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      code: 0,
      message: 'ok',
      data: {
        is_admin: true,
        ranking_period: 'all',
        metrics: {
          order_total: expect.any(Number),
          running_total: expect.any(Number),
          completed_total: expect.any(Number),
          failed_total: expect.any(Number),
          manual_review_total: expect.any(Number),
          refund_approved_total: expect.any(Number),
          refunding_total: expect.any(Number),
          retryable_batch_items: expect.any(Number),
          recent_net_amount: expect.any(Number),
          order_quantity_all: expect.any(Number),
          order_quantity_yesterday: expect.any(Number),
          order_quantity_today: expect.any(Number),
          order_amount_all: expect.any(Number),
          order_amount_yesterday: expect.any(Number),
          order_amount_today: expect.any(Number),
          available_balance: expect.any(Number),
          xhs_total: expect.any(Number),
          xhs_active_total: expect.any(Number),
          xhs_cooling_total: expect.any(Number),
          xhs_invalid_total: expect.any(Number),
          xhs_disabled_total: expect.any(Number),
        },
        pricing: {
          discount_rate: expect.any(Number),
          view_discount_rate: expect.any(Number),
          impression_discount_rate: expect.any(Number),
          view_unit_price: expect.any(Number),
          impression_unit_price: expect.any(Number),
          discounted_view_unit_price: expect.any(Number),
          discounted_impression_unit_price: expect.any(Number),
          view_submit_enabled: expect.any(Boolean),
          impression_submit_enabled: expect.any(Boolean),
        },
        recent_orders: expect.any(Array),
        recent_batches: expect.any(Array),
        recent_records: expect.any(Array),
        alert_orders: expect.any(Array),
        risk_accounts: expect.any(Array),
      },
    });
  });

  test('returns dashboard rankings with period and target filters', async () => {
    const response = await request(app)
      .get('/api/v1/dashboard/rankings')
      .query({ ranking_period: 'today', target_type: 'impression' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      code: 0,
      message: 'ok',
      data: {
        ranking_period: 'today',
        target_type: 'impression',
        rankings_by_amount: expect.any(Array),
        rankings_by_quantity: expect.any(Array),
      },
    });
  });

  test('returns paginated admin dashboard users overview', async () => {
    const response = await request(app)
      .get('/api/v1/admin/dashboard/users-overview')
      .query({ page: 1, page_size: 10 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      code: 0,
      message: 'ok',
      data: {
        items: expect.any(Array),
        pagination: {
          page: 1,
          page_size: 10,
          total: expect.any(Number),
        },
      },
    });
  });

  test('seeds demo dashboard data for the analytics page', async () => {
    const response = await request(app).get('/api/v1/dashboard/summary');

    expect(response.status).toBe(200);
    expect(response.body.data.metrics.order_total).toBeGreaterThan(0);
    expect(response.body.data.metrics.order_quantity_today).toBeGreaterThan(0);
    expect(response.body.data.metrics.order_amount_all).toBeGreaterThan(0);
    expect(response.body.data.metrics.available_balance).toBeGreaterThan(0);
    expect(response.body.data.metrics.xhs_total).toBeGreaterThan(0);
    expect(response.body.data.recent_orders.length).toBeGreaterThan(0);
    expect(response.body.data.recent_batches.length).toBeGreaterThan(0);
    expect(response.body.data.recent_records.length).toBeGreaterThan(0);
  });

  test('uses order quantities, order-charge spending, and current account balance for headline metrics', async () => {
    const response = await request(app).get('/api/v1/dashboard/summary');
    expect(response.status).toBe(200);

    const db = getPool();
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const [[orderQuantities]] = await db.execute(
      `
        SELECT
          COALESCE(SUM(GREATEST(COALESCE(ordered_quantity, 0) - COALESCE(refunded_quantity, 0), 0)), 0) AS all_quantity,
          COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN GREATEST(COALESCE(ordered_quantity, 0) - COALESCE(refunded_quantity, 0), 0) ELSE 0 END), 0) AS today_quantity
        FROM orders
        WHERE order_status <> 'failed'
      `,
      [todayStart, tomorrowStart],
    );
    const [[todayCharge]] = await db.execute(
      `
        SELECT COALESCE(SUM(-net_amount), 0) AS today_amount
        FROM account_records
        WHERE record_type IN ('order_charge', 'refund')
          AND status = 'success'
          AND created_at >= ?
          AND created_at < ?
      `,
      [todayStart, tomorrowStart],
    );
    const [[adminBalance]] = await db.execute(
      'SELECT available_amount FROM balance_accounts WHERE user_id = 1',
    );

    expect(response.body.data.metrics.order_quantity_all).toBe(
      Number(orderQuantities.all_quantity) || 0,
    );
    expect(response.body.data.metrics.order_quantity_today).toBe(
      Number(orderQuantities.today_quantity) || 0,
    );
    expect(response.body.data.metrics.order_amount_today).toBe(
      Number(todayCharge.today_amount) || 0,
    );
    expect(response.body.data.metrics.available_balance).toBe(
      Number(adminBalance.available_amount) || 0,
    );
  });

  test('counts refunding and refunded orders for the abnormal/audit card inputs', async () => {
    const response = await request(app).get('/api/v1/dashboard/summary');
    expect(response.status).toBe(200);

    const db = getPool();
    const [[refundStats]] = await db.execute(
      `
        SELECT
          COALESCE(SUM(CASE WHEN order_status IN ('refund_requested', 'refund_calculating', 'stopping') THEN 1 ELSE 0 END), 0) AS refunding_total,
          COALESCE(SUM(CASE WHEN order_status = 'refund_approved' THEN 1 ELSE 0 END), 0) AS refund_approved_total
        FROM orders
      `,
    );

    expect(response.body.data.metrics.refunding_total).toBe(
      Number(refundStats.refunding_total) || 0,
    );
    expect(response.body.data.metrics.refund_approved_total).toBe(
      Number(refundStats.refund_approved_total) || 0,
    );
  });

  test('seeds rankings and database comments', async () => {
    const response = await request(app)
      .get('/api/v1/dashboard/rankings')
      .query({ ranking_period: 'all', target_type: 'all' });

    expect(response.status).toBe(200);
    expect(response.body.data.rankings_by_amount.length).toBeGreaterThan(0);
    expect(response.body.data.rankings_by_quantity.length).toBeGreaterThan(0);

    const db = getPool();
    const [tables] = await db.execute(
      `
        SELECT TABLE_NAME, TABLE_COMMENT
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('orders', 'account_records', 'balance_accounts')
      `,
    );
    const tableComments = Object.fromEntries(
      tables.map((row) => [row.TABLE_NAME, row.TABLE_COMMENT]),
    );

    expect(tableComments.orders).toBe('订单主表');
    expect(tableComments.account_records).toBe('账户流水记录表');
    expect(tableComments.balance_accounts).toBe('用户余额账户表');

    const [columns] = await db.execute(
      `
        SELECT TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND (
            (TABLE_NAME = 'orders' AND COLUMN_NAME = 'order_status')
            OR (TABLE_NAME = 'account_records' AND COLUMN_NAME = 'actual_paid_amount')
            OR (TABLE_NAME = 'balance_accounts' AND COLUMN_NAME = 'available_amount')
          )
      `,
    );
    const columnComments = Object.fromEntries(
      columns.map((row) => [
        `${row.TABLE_NAME}.${row.COLUMN_NAME}`,
        row.COLUMN_COMMENT,
      ]),
    );

    expect(columnComments['orders.order_status']).toBe('订单状态');
    expect(columnComments['account_records.actual_paid_amount']).toBe('实际支付金额');
    expect(columnComments['balance_accounts.available_amount']).toBe('可用余额');
  });
});
