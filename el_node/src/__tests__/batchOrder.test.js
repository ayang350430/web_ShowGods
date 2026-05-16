const request = require('supertest');

const app = require('../app');
const { closePool, getPool, initializeDatabase } = require('../config/database');
const batchOrderService = require('../services/batchOrder.service');

const originalFetch = global.fetch;
const TEST_ORDER_RAW_CONTENT = 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345 100';

const cleanupTestOrders = async () => {
  const db = getPool();
  const [batches] = await db.execute(
    'SELECT id FROM order_batches WHERE user_id = 1 AND raw_content = ?',
    [TEST_ORDER_RAW_CONTENT],
  );
  const batchIds = batches.map((batch) => batch.id);
  if (batchIds.length === 0) {
    return;
  }

  const batchPlaceholders = batchIds.map(() => '?').join(',');
  const [orders] = await db.execute(
    `SELECT id FROM orders WHERE batch_id IN (${batchPlaceholders})`,
    batchIds,
  );
  const orderIds = orders.map((order) => order.id);
  if (orderIds.length > 0) {
    const orderPlaceholders = orderIds.map(() => '?').join(',');
    await db.execute(
      `DELETE FROM account_records WHERE order_id IN (${orderPlaceholders})`,
      orderIds,
    );
    await db.execute(`DELETE FROM orders WHERE id IN (${orderPlaceholders})`, orderIds);
  }
  await db.execute(`DELETE FROM order_batches WHERE id IN (${batchPlaceholders})`, batchIds);
};

beforeAll(async () => {
  await initializeDatabase();
});

beforeEach(async () => {
  const db = getPool();
  await cleanupTestOrders();
  await batchOrderService._private.ensureNoteBasicCacheTable(db);
  await batchOrderService._private.ensureProblemLinkRecordTable(db);
  await batchOrderService._private.ensureBatchLinkCheckRecordTable(db);
  await db.execute('DELETE FROM note_basic_cache');
  await db.execute('DELETE FROM batch_problem_link_records');
  await db.execute('DELETE FROM batch_link_check_records');
  await db.execute(
    'UPDATE users SET discount_rate = 1, impression_discount_rate = 1 WHERE id = 1',
  );
  global.fetch = jest.fn(async () => ({
    json: async () => ({
      code: 0,
      data: {
        author: {
          avatar: 'https://cdn.example.com/avatar.png',
          nickname: '测试作者',
        },
        note_id: '64f1a2b3c4d5e6f789012345',
        title: '测试笔记',
      },
    }),
    ok: true,
  }));
});

afterEach(async () => {
  batchOrderService._private.setXhsTaskClient(null);
  await cleanupTestOrders();
});

afterAll(async () => {
  global.fetch = originalFetch;
  await closePool();
});

describe('batch order endpoints', () => {
  test('stores every previewed link in one check batch including failed rows', async () => {
    const response = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: [
          'https://www.xiaohongshu.com/explore/demo-note-1 100',
          'bad-url 20',
        ].join('\n'),
        target_type: 'view',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.check_batch_no).toMatch(/^CHECK-/);

    const db = getPool();
    const [rows] = await db.execute(
      `
        SELECT check_batch_no, raw_content, valid, errors
        FROM batch_link_check_records
        WHERE check_batch_no = ?
        ORDER BY line_no ASC
      `,
      [response.body.data.check_batch_no],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      check_batch_no: response.body.data.check_batch_no,
      raw_content: 'https://www.xiaohongshu.com/explore/demo-note-1 100',
      valid: 1,
    });
    expect(rows[1]).toMatchObject({
      raw_content: 'bad-url 20',
      valid: 0,
    });
    const rowErrors =
      typeof rows[1].errors === 'string' ? JSON.parse(rows[1].errors) : rows[1].errors;
    expect(rowErrors).toContain('链接格式不正确');

    const listResponse = await request(app).get('/api/v1/orders/batch/check-records');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data[0]).toMatchObject({
      check_batch_no: response.body.data.check_batch_no,
      raw: 'bad-url 20',
      valid: false,
    });
  });

  test('silent preview validates without creating a check batch record', async () => {
    const response = await request(app)
      .post('/api/v1/orders/batch/preview-silent')
      .send({
        content: 'bad-url 20',
        target_type: 'view',
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      invalid_count: 1,
      total_count: 1,
    });

    const db = getPool();
    const [[row]] = await db.execute(
      'SELECT COUNT(1) AS count FROM batch_link_check_records',
    );
    expect(Number(row.count)).toBe(0);
  });

  test('stores and lists removed problem link records in database', async () => {
    const saveResponse = await request(app)
      .post('/api/v1/orders/batch/problem-links')
      .send({
        records: [
          {
            errors: ['链接格式不正确'],
            line_no: 2,
            note_id: '',
            note_url: 'bad-url',
            raw: 'bad-url 20',
          },
        ],
        target_type: 'view',
      });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body.data).toMatchObject({
      saved_count: 1,
    });

    const listResponse = await request(app).get('/api/v1/orders/batch/problem-links');

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data[0]).toMatchObject({
      errors: ['链接格式不正确'],
      line_no: 2,
      note_url: 'bad-url',
      raw: 'bad-url 20',
      target_type: 'view',
    });

    const db = getPool();
    const [[record]] = await db.execute(
      'SELECT raw_content, user_id FROM batch_problem_link_records LIMIT 1',
    );
    expect(record).toMatchObject({
      raw_content: 'bad-url 20',
      user_id: 1,
    });
  });

  test('previews valid and invalid batch order lines', async () => {
    const response = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: [
          'https://www.xiaohongshu.com/explore/demo-note-1 100',
          'bad-url 20',
        ].join('\n'),
        target_type: 'view',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      code: 0,
      message: 'ok',
      data: {
        can_submit: expect.any(Boolean),
        invalid_count: 1,
        items: expect.any(Array),
        total_amount: expect.any(Number),
        total_count: 2,
        valid_count: 1,
      },
    });
  });

  test('extracts a note id from the submitted link before validation', async () => {
    const response = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345?xsec_token=demo 100',
        target_type: 'view',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.items[0]).toMatchObject({
      author_name: '测试作者',
      avatar_url: 'https://cdn.example.com/avatar.png',
      note_id: '64f1a2b3c4d5e6f789012345',
      title: '测试笔记',
      valid: true,
    });
  });

  test('uses database cached note data for the same link and charges by valid row', async () => {
    const content = 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345 100';

    const firstResponse = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({ content, target_type: 'view' });
    const secondResponse = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: content.replace('100', '300'),
        target_type: 'view',
      });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(firstResponse.body.data.items[0].payable_amount).toBe(
      firstResponse.body.data.discounted_unit_price,
    );
    expect(secondResponse.body.data.items[0].payable_amount).toBe(
      secondResponse.body.data.discounted_unit_price,
    );
    expect(firstResponse.body.data.total_amount).toBe(
      firstResponse.body.data.discounted_unit_price,
    );
    expect(secondResponse.body.data.total_amount).toBe(
      secondResponse.body.data.discounted_unit_price,
    );
    expect(secondResponse.body.data.items[0]).toMatchObject({
      avatar_url: 'https://cdn.example.com/avatar.png',
      cache_hit: true,
    });

    const db = getPool();
    const [[cacheRow]] = await db.execute(
      'SELECT source_url, note_id FROM note_basic_cache WHERE source_url = ?',
      ['https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345'],
    );
    expect(cacheRow).toMatchObject({
      note_id: '64f1a2b3c4d5e6f789012345',
      source_url: 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345',
    });
  });

  test('uses note id API for a short link before loading note basic data', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            note_id: '6a01bbfd000000003502e655',
            url: 'http://xhslink.com/o/9ZJjhL8IV1H',
          },
        }),
        ok: true,
      })
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '6a01bbfd000000003502e655',
              title: '接口直查笔记',
              user: {
                image: 'https://cdn.example.com/direct-avatar.png',
                name: '接口作者',
              },
            },
            note_id: '6a01bbfd000000003502e655',
          },
        }),
        ok: true,
      });

    const response = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: 'http://xhslink.com/o/9ZJjhL8IV1H 500',
        target_type: 'view',
      });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0].toString()).toContain(
      '/api/v1/note/id?url=http%3A%2F%2Fxhslink.com%2Fo%2F9ZJjhL8IV1H',
    );
    expect(global.fetch.mock.calls[1][0].toString()).toContain(
      'note_id=6a01bbfd000000003502e655',
    );
    expect(response.body.data.items[0]).toMatchObject({
      author_name: '接口作者',
      avatar_url: 'https://cdn.example.com/direct-avatar.png',
      note_id: '6a01bbfd000000003502e655',
      title: '接口直查笔记',
      valid: true,
    });
  });

  test('resolves an xhs short link through the note id API before calling note basic', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            note_id: '6a02f2080000000008003ad9',
            url: 'http://xhslink.com/o/6O8WChYmKZp',
          },
        }),
        ok: true,
      })
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            author: {
              avatar: 'https://cdn.example.com/real-avatar.png',
              nickname: '短链作者',
            },
            note_id: '6a02f2080000000008003ad9',
            title: '短链笔记',
          },
        }),
        ok: true,
      });

    const response = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: 'http://xhslink.com/o/6O8WChYmKZp 100',
        target_type: 'view',
      });

    expect(response.status).toBe(200);
    expect(global.fetch.mock.calls[0][0].toString()).toContain(
      '/api/v1/note/id?url=http%3A%2F%2Fxhslink.com%2Fo%2F6O8WChYmKZp',
    );
    expect(global.fetch.mock.calls[1][0].toString()).toContain(
      'note_id=6a02f2080000000008003ad9',
    );
    expect(response.body.data.items[0]).toMatchObject({
      avatar_url: 'https://cdn.example.com/real-avatar.png',
      note_id: '6a02f2080000000008003ad9',
      resolved_note_url: 'http://xhslink.com/o/6O8WChYmKZp',
      title: '短链笔记',
      valid: true,
    });
  });

  test('uses the note id API for short links instead of browser redirects', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            note_id: '6a02da64000000003700d38f',
            url: 'http://xhslink.com/o/52sJPpRW4pf',
          },
        }),
        ok: true,
      })
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '6a02da64000000003700d38f',
              title: '登录跳转笔记',
              user: {
                image: 'https://cdn.example.com/login-redirect-avatar.png',
                name: '跳转作者',
              },
            },
            note_id: '6a02da64000000003700d38f',
          },
        }),
        ok: true,
      });

    const response = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: 'http://xhslink.com/o/52sJPpRW4pf 1000',
        target_type: 'view',
      });

    expect(response.status).toBe(200);
    expect(global.fetch.mock.calls[0][0].toString()).toContain('/api/v1/note/id');
    expect(global.fetch.mock.calls[1][0].toString()).toContain(
      'note_id=6a02da64000000003700d38f',
    );
    expect(response.body.data.items[0]).toMatchObject({
      author_name: '跳转作者',
      avatar_url: 'https://cdn.example.com/login-redirect-avatar.png',
      note_id: '6a02da64000000003700d38f',
      title: '登录跳转笔记',
      valid: true,
    });
  });

  test('reuses the same short-link lookup inside one preview request', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            note_id: '6a02da64000000003700d38f',
            url: 'http://xhslink.com/o/52sJPpRW4pf',
          },
        }),
        ok: true,
      })
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '6a02da64000000003700d38f',
              title: '缓存复用笔记',
              user: {
                image: 'https://cdn.example.com/reuse-avatar.png',
                name: '缓存作者',
              },
            },
            note_id: '6a02da64000000003700d38f',
          },
        }),
        ok: true,
      });

    const response = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: [
          'http://xhslink.com/o/52sJPpRW4pf 1000',
          'http://xhslink.com/o/52sJPpRW4pf 2000',
        ].join('\n'),
        target_type: 'view',
      });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(response.body.data).toMatchObject({
      invalid_count: 1,
      valid_count: 1,
    });
  });

  test('marks duplicate links by note id as invalid', async () => {
    const response = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: [
          'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345 100',
          'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345?xsec_token=demo 200',
        ].join('\n'),
        target_type: 'view',
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      invalid_count: 1,
      valid_count: 1,
    });
    expect(response.body.data.items[1]).toMatchObject({
      duplicate: true,
      errors: expect.arrayContaining(['链接重复']),
      note_id: '64f1a2b3c4d5e6f789012345',
      valid: false,
    });
  });

  test('rejects submitting invalid batch content', async () => {
    const response = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: 'bad-url 20',
        target_type: 'view',
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Batch content validation failed');
  });

  test('lists submitted batch order records with order items', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'view',
      });

    expect(submitResponse.status).toBe(200);

    const listResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          batch_no: submitResponse.body.data.batch_no,
          orders: expect.arrayContaining([
            expect.objectContaining({
              ordered_quantity: 100,
              target_type: 'view',
            }),
          ]),
          total_count: 1,
        }),
      ]),
    );
  });

  test('lists refund records with the balance after an approved refund', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'view',
      });
    expect(submitResponse.status).toBe(200);

    const [[order]] = await db.execute(
      `
        SELECT o.id
        FROM orders o
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ?
        LIMIT 1
      `,
      [submitResponse.body.data.batch_id],
    );

    expect(order.id).toBeTruthy();
    expect((await request(app).post(`/api/v1/orders/${order.id}/refund-request`)).status).toBe(200);
    expect(
      (
        await request(app)
          .post(`/api/v1/orders/${order.id}/refund-review`)
          .send({ approved: true, reason: '测试退款通过' })
      ).status,
    ).toBe(200);

    const [[refundRecord]] = await db.execute(
      `
        SELECT after_available_amount
        FROM account_records
        WHERE order_id = ? AND record_type = 'refund'
        ORDER BY id DESC
        LIMIT 1
      `,
      [order.id],
    );

    const listResponse = await request(app).get('/api/v1/orders/refund-records');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          after_available_amount: Number(refundRecord.after_available_amount),
          order_id: order.id,
          order_status: 'refund_approved',
        }),
      ]),
    );

    const recordsResponse = await request(app).get('/api/v1/orders/batch/records?page=1&page_size=100');
    expect(recordsResponse.status).toBe(200);
    const listedOrders = recordsResponse.body.data.items.flatMap((batch) => batch.orders);
    const listedOrderIds = listedOrders.map((item) => item.id);
    expect(listedOrderIds.filter((id) => id === order.id)).toHaveLength(1);
  });

  test('retries failed orders in a batch without creating a new charge', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'view',
      });
    expect(submitResponse.status).toBe(200);

    const [[batch]] = await db.execute('SELECT id FROM order_batches WHERE batch_id = ?', [
      submitResponse.body.data.batch_id,
    ]);
    await db.execute(
      "UPDATE orders SET order_status = 'failed', reason_message = 'test failed' WHERE batch_id = ?",
      [batch.id],
    );
    await db.execute(
      "UPDATE order_batches SET status = 'failed', processing_count = 0, failed_count = 1, retryable_count = 1 WHERE id = ?",
      [batch.id],
    );
    const [[beforeCount]] = await db.execute(
      'SELECT COUNT(1) AS count FROM account_records WHERE user_id = 1',
    );

    const retryResponse = await request(app).post(`/api/v1/orders/batch/${batch.id}/retry`);

    expect(retryResponse.status).toBe(200);
    expect(retryResponse.body.data).toMatchObject({
      batch_id: batch.id,
      retried_count: 1,
      status: 'processing',
    });

    const [[order]] = await db.execute('SELECT order_status, reason_message FROM orders WHERE batch_id = ?', [
      batch.id,
    ]);
    expect(order).toMatchObject({
      order_status: 'running',
      reason_message: null,
    });

    const [[afterCount]] = await db.execute(
      'SELECT COUNT(1) AS count FROM account_records WHERE user_id = 1',
    );
    expect(Number(afterCount.count)).toBe(Number(beforeCount.count));
  });

  test('records XHS network failures without charging the user', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => {
        throw new Error('connect ETIMEDOUT 192.168.31.134:9101');
      }),
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'view',
      });

    expect(submitResponse.status).toBe(200);
    expect(submitResponse.body.data).toMatchObject({
      failed_count: 1,
      submitted_count: 0,
      total_amount: 0,
    });

    const [[order]] = await db.execute(
      `
        SELECT o.external_task_id, o.order_status, o.reason_message
        FROM orders o
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ?
        LIMIT 1
      `,
      [submitResponse.body.data.batch_id],
    );
    expect(order).toMatchObject({
      external_task_id: null,
      order_status: 'failed',
    });
    expect(order.reason_message).toContain('connect ETIMEDOUT');

    const [[balance]] = await db.execute(
      'SELECT available_amount FROM balance_accounts WHERE user_id = 1',
    );
    expect(Number(balance.available_amount)).toBe(1000);

    const [[chargeCount]] = await db.execute(
      `
        SELECT COUNT(1) AS count
        FROM account_records ar
        INNER JOIN orders o ON o.id = ar.order_id
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ? AND ar.record_type = 'order_charge'
      `,
      [submitResponse.body.data.batch_id],
    );
    expect(Number(chargeCount.count)).toBe(0);
  });

  test('retries unsubmitted XHS failures and charges only after downstream success', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 10000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const createTask = jest
      .fn()
      .mockRejectedValueOnce(new Error('XHS service unreachable'))
      .mockResolvedValueOnce({ id: 98765 });
    batchOrderService._private.setXhsTaskClient({ createTask });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'view',
      });
    expect(submitResponse.status).toBe(200);

    const [[batch]] = await db.execute('SELECT id FROM order_batches WHERE batch_id = ?', [
      submitResponse.body.data.batch_id,
    ]);
    const retryResponse = await request(app).post(`/api/v1/orders/batch/${batch.id}/retry`);

    expect(retryResponse.status).toBe(200);
    expect(retryResponse.body.data).toMatchObject({
      batch_id: batch.id,
      retried_count: 1,
      status: 'processing',
    });
    expect(createTask).toHaveBeenCalledTimes(2);

    const [[order]] = await db.execute(
      'SELECT external_task_id, order_status, reason_message FROM orders WHERE batch_id = ?',
      [batch.id],
    );
    expect(order).toMatchObject({
      external_task_id: '98765',
      order_status: 'running',
      reason_message: null,
    });

    const [[charge]] = await db.execute(
      "SELECT COUNT(1) AS count, COALESCE(SUM(payable_amount), 0) AS amount FROM account_records WHERE order_id = (SELECT id FROM orders WHERE batch_id = ?) AND record_type = 'order_charge'",
      [batch.id],
    );
    expect(Number(charge.count)).toBe(1);
    expect(Number(charge.amount)).toBeGreaterThan(0);

    const [[balance]] = await db.execute(
      'SELECT available_amount FROM balance_accounts WHERE user_id = 1',
    );
    expect(Number(balance.available_amount)).toBe(10000 - Number(charge.amount));
  });
});
