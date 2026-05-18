const request = require('supertest');
const crypto = require('crypto');

const app = require('../app');
const { closePool, getPool, initializeDatabase } = require('../config/database');
const batchOrderService = require('../services/batchOrder.service');
const openApiService = require('../services/openApi.service');

const originalFetch = global.fetch;
const OPEN_API_CONTENT = 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f7890abcde 100';

const createTestOpenApiKey = async (userId = 1) => {
  const db = getPool();
  await openApiService.ensureOpenApiKeyTable(db);
  const apiKey = `goods_jest_${crypto.randomBytes(16).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const now = new Date();
  const [result] = await db.execute(
    `
      INSERT INTO open_api_keys
        (user_id, key_name, key_prefix, key_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `,
    [userId, `jest-open-api-${Date.now()}`, apiKey.slice(0, 12), keyHash, now, now],
  );
  return { apiKey, keyId: result.insertId };
};

const createRunningOpenOrder = async (userId = 1) => {
  const db = getPool();
  const batchUuid = crypto.randomUUID();
  const batchNo = `BATCH-JEST-${Date.now()}`;
  const orderNo = `ORDER-JEST-${Date.now()}-001`;
  const now = new Date();
  const [batchResult] = await db.execute(
    `
      INSERT INTO order_batches
        (batch_id, batch_no, user_id, source_type, submit_mode, raw_content, estimated_amount,
         status, total_count, pending_count, processing_count, succeeded_count, failed_count,
         retryable_count, submitted_at, created_at, updated_at)
      VALUES (?, ?, ?, 'open_api', 'batch', ?, 30, 'processing', 1, 0, 1, 0, 0, 0, ?, ?, ?)
    `,
    [batchUuid, batchNo, userId, OPEN_API_CONTENT, now, now, now],
  );
  const [orderResult] = await db.execute(
    `
      INSERT INTO orders
        (order_no, user_id, batch_id, batch_item_id, note_id, note_url, target_type,
         ordered_quantity, completed_quantity, order_status, external_task_id, external_status,
         created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, 'view', 100, 0, 'running', '998877', 'running', ?, ?)
    `,
    [
      orderNo,
      userId,
      batchResult.insertId,
      '64f1a2b3c4d5e6f7890abcde',
      'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f7890abcde',
      now,
      now,
    ],
  );
  return {
    batchId: batchUuid,
    batchNo,
    orderId: orderResult.insertId,
    orderNo,
  };
};

const cleanupOpenApiData = async () => {
  const db = getPool();
  await openApiService.ensureOpenApiKeyTable(db);
  await db.execute("DELETE FROM open_api_keys WHERE key_name LIKE 'jest-open-api-%'");
  const [batches] = await db.execute(
    'SELECT id FROM order_batches WHERE raw_content = ?',
    [OPEN_API_CONTENT],
  );
  const batchIds = batches.map((batch) => batch.id);
  if (batchIds.length === 0) {
    return;
  }
  const placeholders = batchIds.map(() => '?').join(',');
  const [orders] = await db.execute(`SELECT id FROM orders WHERE batch_id IN (${placeholders})`, batchIds);
  const orderIds = orders.map((order) => order.id);
  if (orderIds.length > 0) {
    const orderPlaceholders = orderIds.map(() => '?').join(',');
    await db.execute(`DELETE FROM account_records WHERE order_id IN (${orderPlaceholders})`, orderIds);
    await db.execute(`DELETE FROM orders WHERE id IN (${orderPlaceholders})`, orderIds);
  }
  await db.execute(`DELETE FROM order_batches WHERE id IN (${placeholders})`, batchIds);
};

beforeAll(async () => {
  await initializeDatabase();
});

beforeEach(async () => {
  await cleanupOpenApiData();
  global.fetch = jest.fn(async () => ({
    json: async () => ({
      code: 0,
      data: {
        base_info: {
          id: '64f1a2b3c4d5e6f7890abcde',
          title: 'open api note',
          user: {
            id: 'open-api-author',
            image: 'https://cdn.example.com/open-api.png',
            name: 'open api author',
          },
        },
        note_id: '64f1a2b3c4d5e6f7890abcde',
      },
    }),
    ok: true,
  }));
  batchOrderService._private.setXhsTaskClient({
    createTask: jest.fn(async () => ({ id: 998877 })),
    getTaskStatus: jest.fn(async () => ({ completed: false })),
    updateTaskStatus: jest.fn(async () => ({ code: 0, success: true })),
  });
});

afterEach(async () => {
  batchOrderService._private.setXhsTaskClient(null);
  await cleanupOpenApiData();
});

afterAll(async () => {
  global.fetch = originalFetch;
  await closePool();
});

describe('open api order bridge', () => {
  test('lets a platform user create, list, and revoke an api key', async () => {
    const createResponse = await request(app)
      .post('/api/v1/open-api/keys')
      .send({ name: `jest-open-api-${Date.now()}` });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.data.api_key).toMatch(/^goods_/);
    expect(createResponse.body.data.masked_key).toContain('********');

    const listResponse = await request(app).get('/api/v1/open-api/keys');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createResponse.body.data.id,
          status: 'active',
        }),
      ]),
    );
    expect(JSON.stringify(listResponse.body.data)).not.toContain(createResponse.body.data.api_key);

    const duplicateResponse = await request(app)
      .post('/api/v1/open-api/keys')
      .send({ name: `jest-open-api-${Date.now()}-duplicate` });
    expect(duplicateResponse.status).toBe(400);
    expect(duplicateResponse.body.message).toBe(
      '当前账号已有可用 Open API key，请删除后再重新申请',
    );

    const revokeResponse = await request(app).delete(
      `/api/v1/open-api/keys/${createResponse.body.data.id}`,
    );
    expect(revokeResponse.status).toBe(200);
    expect(revokeResponse.body.data).toMatchObject({
      id: createResponse.body.data.id,
      status: 'revoked',
    });
  });

  test('requires an open api key for public order endpoints', async () => {
    const response = await request(app)
      .post('/api/open/orders/preview')
      .send({ content: OPEN_API_CONTENT, target_type: 'view' });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Open API key is required');
  });

  test('submits a batch order through the public api key bridge', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const keyResponse = await request(app)
      .post('/api/v1/open-api/keys')
      .set('Authorization', 'Bearer dev-token-3')
      .send({ name: `jest-open-api-${Date.now()}` });
    const apiKey = keyResponse.body.data.api_key;

    const previewResponse = await request(app)
      .post('/api/open/orders/preview')
      .set('X-Api-Key', apiKey)
      .send({ content: OPEN_API_CONTENT, target_type: 'view' });
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.body.data).toMatchObject({
      can_submit: true,
      open_api_key_id: keyResponse.body.data.id,
      valid_count: 1,
    });

    const submitResponse = await request(app)
      .post('/api/open/orders/submit')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ content: OPEN_API_CONTENT, target_type: 'view' });

    expect(submitResponse.status).toBe(200);
    expect(submitResponse.body.data).toMatchObject({
      failed_count: 0,
      open_api_key_id: keyResponse.body.data.id,
      submitted_count: 1,
    });

    const [[order]] = await db.execute(
      `
        SELECT o.external_task_id, o.order_status, o.user_id
        FROM orders o
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ?
        LIMIT 1
      `,
      [submitResponse.body.data.batch_id],
    );
    expect(order).toMatchObject({
      external_task_id: '998877',
      order_status: 'running',
      user_id: 1,
    });
  });

  test('rejects public submit when preview validation fails', async () => {
    const db = getPool();
    await db.execute('DELETE FROM open_api_keys WHERE user_id = 1');
    const { apiKey, keyId } = await createTestOpenApiKey(1);
    const previewDetails = {
      can_submit: false,
      invalid_count: 1,
      items: [
        {
          errors: ['链接格式不正确'],
          line_no: 1,
          raw: 'bad-link 100',
          valid: false,
        },
      ],
      total_count: 1,
      valid_count: 0,
      warnings: ['存在格式错误的行，请修正后再提交'],
    };
    const previewSpy = jest
      .spyOn(batchOrderService, 'buildPreview')
      .mockResolvedValue(previewDetails);
    const submitSpy = jest.spyOn(batchOrderService, 'submitBatch');

    const response = await request(app)
      .post('/api/open/orders/submit')
      .set('X-Api-Key', apiKey)
      .send({ content: 'bad-link 100', target_type: 'view' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Open API preview validation failed: 链接格式不正确');
    expect(response.body.details).toMatchObject(previewDetails);
    expect(previewSpy).toHaveBeenCalledWith(
      1,
      { content: 'bad-link 100', target_type: 'view' },
      { persistCheckRecords: false },
    );
    expect(submitSpy).not.toHaveBeenCalled();

    previewSpy.mockRestore();
    submitSpy.mockRestore();
  });

  test('charges the account that owns the open api key and records its consumption', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (3, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const [[beforeBalance]] = await db.execute(
      'SELECT available_amount FROM balance_accounts WHERE user_id = 3',
    );
    const keyResponse = await request(app)
      .post('/api/v1/open-api/keys')
      .set('Authorization', 'Bearer dev-token-3')
      .send({ name: `jest-open-api-${Date.now()}` });
    const apiKey = keyResponse.body.data.api_key;

    const submitResponse = await request(app)
      .post('/api/open/orders/submit')
      .set('X-Api-Key', apiKey)
      .send({ content: OPEN_API_CONTENT, target_type: 'view' });

    expect(submitResponse.status).toBe(200);
    const chargedAmount = Number(submitResponse.body.data.total_amount);
    expect(chargedAmount).toBeGreaterThan(0);

    const [[order]] = await db.execute(
      `
        SELECT id, user_id
        FROM orders
        WHERE batch_id = (SELECT id FROM order_batches WHERE batch_id = ?)
        LIMIT 1
      `,
      [submitResponse.body.data.batch_id],
    );
    expect(order.user_id).toBe(3);

    const [[record]] = await db.execute(
      `
        SELECT user_id, actual_paid_amount
        FROM account_records
        WHERE order_id = ? AND record_type = 'order_charge'
        LIMIT 1
      `,
      [order.id],
    );
    expect(record.user_id).toBe(3);
    expect(Number(record.actual_paid_amount)).toBe(chargedAmount);

    const [[afterBalance]] = await db.execute(
      'SELECT available_amount FROM balance_accounts WHERE user_id = 3',
    );
    expect(Number(afterBalance.available_amount)).toBe(
      Number(beforeBalance.available_amount) - chargedAmount,
    );
  });

  test('uses the key owner fixed unit price configured by admin permissions', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (3, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    await db.execute(
      `
        UPDATE users
        SET price_mode = 'fixed',
            fixed_unit_price = 0.1234,
            impression_price_mode = 'fixed',
            impression_fixed_unit_price = 0.5678
        WHERE id = 3
      `,
    );
    const keyResponse = await request(app)
      .post('/api/v1/open-api/keys')
      .set('Authorization', 'Bearer dev-token-3')
      .send({ name: `jest-open-api-${Date.now()}` });

    const submitResponse = await request(app)
      .post('/api/open/orders/submit')
      .set('X-Api-Key', keyResponse.body.data.api_key)
      .send({ content: OPEN_API_CONTENT, target_type: 'view' });

    expect(submitResponse.status).toBe(200);
    expect(submitResponse.body.data.total_amount).toBe(0.1234);

    const [[record]] = await db.execute(
      `
        SELECT ar.discounted_unit_price, ar.actual_paid_amount, ar.user_id
        FROM account_records ar
        INNER JOIN orders o ON o.id = ar.order_id
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ? AND ar.record_type = 'order_charge'
        LIMIT 1
      `,
      [submitResponse.body.data.batch_id],
    );
    expect(record.user_id).toBe(3);
    expect(Number(record.discounted_unit_price)).toBe(0.1234);
    expect(Number(record.actual_paid_amount)).toBe(0.1234);
  });

  test('rejects open api submission when the key owner balance is insufficient', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (3, 0) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const keyResponse = await request(app)
      .post('/api/v1/open-api/keys')
      .set('Authorization', 'Bearer dev-token-3')
      .send({ name: `jest-open-api-${Date.now()}` });

    const submitResponse = await request(app)
      .post('/api/open/orders/submit')
      .set('X-Api-Key', keyResponse.body.data.api_key)
      .send({ content: OPEN_API_CONTENT, target_type: 'view' });

    expect(submitResponse.status).toBe(400);
    expect(submitResponse.body.message).toBe('当前 Open API key 账号余额不足');

    const [[orderCount]] = await db.execute(
      'SELECT COUNT(1) AS count FROM orders WHERE user_id = 3 AND note_id = ?',
      ['64f1a2b3c4d5e6f7890abcde'],
    );
    expect(Number(orderCount.count)).toBe(0);
  });

  test('lets open api callers poll batch progress', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const { apiKey, keyId } = await createTestOpenApiKey(1);
    const runningOrder = await createRunningOpenOrder(1);
    await db.execute(
      `
        UPDATE orders
        SET completed_quantity = 40, external_completed_quantity = 40, external_progress = 0.4
        WHERE id = ?
      `,
      [runningOrder.orderId],
    );

    const progressResponse = await request(app)
      .get('/api/open/orders/progress')
      .set('Authorization', `Bearer ${apiKey}`)
      .query({ batch_id: runningOrder.batchId });

    expect(progressResponse.status).toBe(200);
    expect(progressResponse.body.data).toMatchObject({
      count: 1,
      open_api_key_id: keyId,
    });
    expect(progressResponse.body.data.batches[0]).toMatchObject({
      batch_id: runningOrder.batchId,
      progress: {
        completed_quantity: 40,
        percent: 40,
        total_quantity: 100,
      },
    });
    expect(progressResponse.body.data.batches[0].orders[0]).toMatchObject({
      external_task_id: '998877',
      order_id: runningOrder.orderId,
      progress: 40,
      progress_percent: 40,
    });
  });

  test('rate limits open api progress polling per key to once every 10 seconds', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const keyResponse = await request(app)
      .post('/api/v1/open-api/keys')
      .send({ name: `jest-open-api-${Date.now()}` });
    const apiKey = keyResponse.body.data.api_key;

    const submitResponse = await request(app)
      .post('/api/open/orders/submit')
      .set('X-Api-Key', apiKey)
      .send({ content: OPEN_API_CONTENT, target_type: 'view' });
    expect(submitResponse.status).toBe(200);

    const firstResponse = await request(app)
      .get('/api/open/orders/progress')
      .set('X-Api-Key', apiKey)
      .query({ batch_id: submitResponse.body.data.batch_id });
    expect(firstResponse.status).toBe(200);

    const limitedResponse = await request(app)
      .get('/api/open/orders/progress')
      .set('X-Api-Key', apiKey)
      .query({ batch_id: submitResponse.body.data.batch_id });
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.body.message).toContain('10 秒只能调用一次');
  });

  test('lets open api callers stop submitted upstream tasks', async () => {
    const db = getPool();
    const updateTaskStatus = jest.fn(async () => ({ code: 0, success: true }));
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 998877 })),
      getTaskStatus: jest.fn(async () => ({ completed: false })),
      updateTaskStatus,
    });
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const { apiKey, keyId } = await createTestOpenApiKey(1);
    const runningOrder = await createRunningOpenOrder(1);

    const stopResponse = await request(app)
      .post('/api/open/orders/stop')
      .set('X-Api-Key', apiKey)
      .send({
        batch_id: runningOrder.batchId,
        reason: 'downstream requested stop',
      });

    expect(stopResponse.status).toBe(200);
    expect(stopResponse.body.data).toMatchObject({
      failed_count: 0,
      open_api_key_id: keyId,
      skipped_count: 0,
      stopped_count: 1,
      total_count: 1,
    });
    expect(updateTaskStatus).toHaveBeenCalledWith(
      'view',
      expect.objectContaining({
        id: 998877,
        status: 3,
      }),
      { token: 'xhs-api-123456789' },
    );

    const [[order]] = await db.execute(
      `
        SELECT o.external_status, o.order_status, o.stop_requested_at
        FROM orders o
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ?
        LIMIT 1
      `,
      [runningOrder.batchId],
    );
    expect(order.order_status).toBe('stopping');
    expect(order.external_status).toBe('stop_requested');
    expect(order.stop_requested_at).toBeTruthy();
  });

  test('treats uuid-shaped order_id as batch_id when stopping open api tasks', async () => {
    const db = getPool();
    const updateTaskStatus = jest.fn(async () => ({ code: 0, success: true }));
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 998877 })),
      getTaskStatus: jest.fn(async () => ({ completed: false })),
      updateTaskStatus,
    });
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const { apiKey } = await createTestOpenApiKey(1);
    const runningOrder = await createRunningOpenOrder(1);

    const stopResponse = await request(app)
      .post('/api/open/orders/stop')
      .set('X-Api-Key', apiKey)
      .send({
        order_id: runningOrder.batchId,
        reason: 'downstream requested stop',
      });

    expect(stopResponse.status).toBe(200);
    expect(stopResponse.body.data).toMatchObject({
      failed_count: 0,
      skipped_count: 0,
      stopped_count: 1,
      total_count: 1,
    });
    expect(updateTaskStatus).toHaveBeenCalledWith(
      'view',
      expect.objectContaining({
        id: 998877,
        status: 3,
      }),
      { token: 'xhs-api-123456789' },
    );
  });
});
