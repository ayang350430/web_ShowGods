const request = require('supertest');

const app = require('../app');
const { closePool, getPool, initializeDatabase } = require('../config/database');
const batchOrderService = require('../services/batchOrder.service');

const originalFetch = global.fetch;
const TEST_ORDER_RAW_CONTENT = 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345 100';
const TEST_MULTI_ORDER_RAW_CONTENT = [
  'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345 100',
  'https://www.xiaohongshu.com/explore/6a01bbfd000000003502e655 200',
].join('\n');
const TEST_NOTE_IDS = ['64f1a2b3c4d5e6f789012345', '6a01bbfd000000003502e655'];

const cleanupTestOrders = async () => {
  const db = getPool();
  const [batches] = await db.execute(
    `
      SELECT id
      FROM order_batches
      WHERE user_id = 1
        AND (
          raw_content IN (?, ?)
          OR id IN (
            SELECT batch_id
            FROM orders
            WHERE user_id = 1 AND note_id IN (?, ?)
          )
        )
    `,
    [TEST_ORDER_RAW_CONTENT, TEST_MULTI_ORDER_RAW_CONTENT, ...TEST_NOTE_IDS],
  );
  const batchIds = batches.map((batch) => batch.id);
  if (batchIds.length === 0) {
    return;
  }

  const batchPlaceholders = batchIds.map(() => '?').join(',');
  await db.execute(
    `DELETE FROM order_replenishment_records WHERE batch_id IN (${batchPlaceholders})`,
    batchIds,
  ).catch(() => {});
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
  await batchOrderService._private.ensureReplenishmentRecordTable(db);
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
  batchOrderService._private.setXhsTaskClient({
    createTask: jest.fn(async () => ({ id: Date.now() })),
    getTaskStatus: jest.fn(async () => ({ completed: false })),
  });
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

    expect(
      global.fetch.mock.calls.filter(([url]) => String(url).includes('/api/v1/note/basic')),
    ).toHaveLength(1);
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

  test('charges quantity based price by ordered quantity', async () => {
    const db = getPool();
    process.env.TINYDATA_PREVIEW_TOKEN = 'jest-token';
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/order-batches/preview')) {
        return {
          json: async () => ({
            code: 'OK',
            data: {
              items: [
                {
                  note_id: '64f1a2b3c4d5e6f789012345',
                  target_quantity: 5000,
                  valid: true,
                },
              ],
            },
          }),
          ok: true,
        };
      }
      return {
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
      };
    });
    await db.execute(
      `
        UPDATE users
        SET price_mode = 'quantity',
            quantity_price_base = 1000,
            quantity_price_amount = 30,
            discount_rate = 1
        WHERE id = 1
      `,
    );
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );

    const response = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345 5000',
        target_type: 'view',
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      discounted_unit_price: 30,
      price_base_quantity: 1000,
      price_mode: 'quantity',
      total_amount: 150,
      unit_price: 30,
    });
    expect(response.body.data.items[0]).toMatchObject({
      ordered_quantity: 5000,
      original_amount: 150,
      payable_amount: 150,
    });
  });

  test('charges like orders with independent like quantity price', async () => {
    const db = getPool();
    process.env.TINYDATA_PREVIEW_TOKEN = 'jest-token';
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/order-batches/preview')) {
        return {
          json: async () => ({
            code: 'OK',
            data: {
              items: [
                {
                  note_id: '64f1a2b3c4d5e6f789012345',
                  target_quantity: 500,
                  valid: true,
                },
              ],
            },
          }),
          ok: true,
        };
      }
      if (String(url).includes('/api/v1/note/likes')) {
        return {
          json: async () => ({
            code: 0,
            data: {
              likes_num: 100,
            },
          }),
          ok: true,
        };
      }
      return {
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
      };
    });
    await db.execute(
      `
        UPDATE users
        SET price_mode = 'quantity',
            quantity_price_base = 1000,
            quantity_price_amount = 30,
            like_price_mode = 'quantity',
            like_quantity_price_base = 100,
            like_quantity_price_amount = 8,
            like_discount_rate = 1
        WHERE id = 1
      `,
    );
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );

    const response = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345 500',
        target_type: 'like',
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      discounted_unit_price: 8,
      price_base_quantity: 100,
      price_mode: 'quantity',
      total_amount: 40,
      unit_price: 8,
    });
    expect(response.body.data.items[0]).toMatchObject({
      ordered_quantity: 500,
      original_amount: 40,
      payable_amount: 40,
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
    expect(
      global.fetch.mock.calls.filter(([url]) => !String(url).includes('/api/v1/note/likes')),
    ).toHaveLength(2);
    expect(global.fetch.mock.calls[0][0].toString()).toContain(
      '/api/v1/note/id?url=http%3A%2F%2Fxhslink.com%2Fo%2F9ZJjhL8IV1H',
    );
    expect(global.fetch.mock.calls.find(([url]) => String(url).includes('/api/v1/note/basic'))?.[0].toString()).toContain(
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
    expect(
      global.fetch.mock.calls.filter(([url]) => !String(url).includes('/api/v1/note/likes')),
    ).toHaveLength(2);
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

  test('rejects previewing a note that already has a running order in the same target type', async () => {
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

    const previewResponse = await request(app)
      .post('/api/v1/orders/batch/preview')
      .send({
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'view',
      });

    expect(previewResponse.status).toBe(200);
    expect(previewResponse.body.data).toMatchObject({
      can_submit: false,
      invalid_count: 1,
      valid_count: 0,
    });
    expect(previewResponse.body.data.items[0].errors).toEqual(
      expect.arrayContaining([expect.stringContaining('阅读任务正在处理中')]),
    );
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
    expect(submitResponse.body.data.batch_no).toMatch(/^BATCH-/);
    expect(submitResponse.body.data.batch_no.length).toBeLessThan('BATCH-1778920202055'.length);

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

  test('keeps order note avatar after note basic cache is cleared', async () => {
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

    await db.execute('DELETE FROM note_basic_cache');

    const listResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(listResponse.status).toBe(200);
    const listedBatch = listResponse.body.data.find(
      (item) => item.batch_id === submitResponse.body.data.batch_id,
    );
    expect(listedBatch.orders[0]).toMatchObject({
      avatar_url: 'https://cdn.example.com/avatar.png',
      title: '测试笔记',
    });
  });

  test('keeps accepted downstream tasks running until progress is synced', async () => {
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
        SELECT o.completed_quantity, o.external_completed_quantity, o.external_progress,
          o.external_status, o.external_task_id, o.order_status
        FROM orders o
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ?
        LIMIT 1
      `,
      [submitResponse.body.data.batch_id],
    );
    expect(order).toMatchObject({
      completed_quantity: 0,
      external_completed_quantity: 0,
      external_status: 'accepted',
      order_status: 'running',
    });
    expect(Number(order.external_progress)).toBe(0);
    expect(order.external_task_id).toBeTruthy();

    const listResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(listResponse.status).toBe(200);
    const listedBatch = listResponse.body.data.find(
      (item) => item.batch_id === submitResponse.body.data.batch_id,
    );
    expect(listedBatch).toMatchObject({
      processing_count: 1,
      status: 'processing',
      succeeded_count: 0,
    });
    expect(listedBatch.orders[0]).toMatchObject({
      completed_quantity: 0,
      external_task_id: order.external_task_id,
      order_status: 'running',
    });
  });

  test('updates running order progress when xhs status query returns status 1', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const getTaskStatus = jest.fn(async (targetType, taskId) => ({
      body: {
        code: 0,
        data: {
          current_count: 25,
          status: 1,
          total_count: 100,
        },
      },
      ok: true,
      status: 200,
      taskId,
    }));
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 12345 })),
      getTaskStatus,
    });

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
    const listedBatch = listResponse.body.data.find(
      (item) => item.batch_id === submitResponse.body.data.batch_id,
    );
    expect(listedBatch).toMatchObject({
      processing_count: 1,
      status: 'processing',
      succeeded_count: 0,
    });
    expect(listedBatch.orders[0]).toMatchObject({
      completed_quantity: 25,
      external_task_id: '12345',
      order_status: 'running',
    });

    const [[order]] = await db.execute(
      `
        SELECT external_completed_quantity, external_progress
        FROM orders o
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ?
        LIMIT 1
      `,
      [submitResponse.body.data.batch_id],
    );
    expect(Number(order.external_completed_quantity)).toBe(25);
    expect(Number(order.external_progress)).toBe(0.25);
  });

  test('marks running order upstream completed before final completion confirmation', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const getTaskStatus = jest.fn(async (targetType, taskId) => ({
      body: {
        code: 0,
        data: {
          current_count: 100,
          status: 2,
          total_count: 100,
        },
      },
      ok: true,
      status: 200,
      taskId,
    }));
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 12345 })),
      getTaskStatus,
    });

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
    expect(getTaskStatus).toHaveBeenCalledWith(
      'view',
      '12345',
      {
        token: 'xhs-api-123456789',
      },
    );
    const listedBatch = listResponse.body.data.find(
      (item) => item.batch_id === submitResponse.body.data.batch_id,
    );
    expect(listedBatch).toMatchObject({
      processing_count: 1,
      status: 'processing',
      succeeded_count: 0,
    });
    expect(listedBatch.orders[0]).toMatchObject({
      completed_quantity: 100,
      external_status: 'completed',
      external_task_id: '12345',
      order_status: 'running',
    });
  });

  test('keeps status 1 count-complete tasks running until upstream status is 2', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const getTaskStatus = jest.fn(async (targetType, taskId) => ({
      body: {
        code: 0,
        data: {
          current_count: 120,
          status: 1,
          total_count: 120,
        },
      },
      ok: true,
      status: 200,
      taskId,
    }));
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 12345 })),
      getTaskStatus,
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'like',
      });

    expect(submitResponse.status).toBe(200);

    const listResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(listResponse.status).toBe(200);
    const listedBatch = listResponse.body.data.find(
      (item) => item.batch_id === submitResponse.body.data.batch_id,
    );
    expect(listedBatch.orders[0]).toMatchObject({
      completed_quantity: 100,
      external_status: 'running',
      external_task_id: '12345',
      order_status: 'running',
    });
  });

  test('searches existing orders by pasted note links', async () => {
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

    const searchResponse = await request(app)
      .post('/api/v1/orders/batch/search')
      .send({
        content: 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345',
      });

    expect(searchResponse.status).toBe(200);
    expect(searchResponse.body.data).toMatchObject({
      invalid_count: 0,
      total_count: 1,
    });
    expect(searchResponse.body.data.matched_count).toBeGreaterThanOrEqual(1);
    const submittedOrder = searchResponse.body.data.items.find(
      (item) => item.batch_no === submitResponse.body.data.batch_no,
    );
    expect(submittedOrder).toMatchObject({
      avatar_url: 'https://cdn.example.com/avatar.png',
      batch_no: submitResponse.body.data.batch_no,
      note_id: '64f1a2b3c4d5e6f789012345',
      ordered_quantity: 100,
      target_type: 'view',
    });

    const unmatchedDateResponse = await request(app)
      .post('/api/v1/orders/batch/search')
      .send({
        content: 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345',
        end_date: '2099-01-02',
        start_date: '2099-01-01',
      });
    expect(unmatchedDateResponse.status).toBe(200);
    expect(unmatchedDateResponse.body.data).toMatchObject({
      matched_count: 0,
      total_count: 1,
    });
  });

  test('searches short-link batch orders without returning sibling rows', async () => {
    const db = getPool();
    const now = new Date();
    const rawContent = 'http://xhslink.com/m/a-short 10\nhttp://xhslink.com/m/b-short 20';
    const [batchResult] = await db.execute(
      `
        INSERT INTO order_batches
          (
            batch_id, batch_no, user_id, source_type, submit_mode, raw_content,
            estimated_amount, status, total_count, pending_count, processing_count,
            succeeded_count, failed_count, retryable_count, submitted_at, created_at, updated_at
          )
        VALUES ('search-short-batch', 'BATCH-SEARCH-SHORT', 1, 'manual', 'batch', ?, 60, 'processing', 2, 0, 2, 0, 0, 0, ?, ?, ?)
      `,
      [rawContent, now, now, now],
    );
    await db.execute(
      `
        INSERT INTO orders
          (
            order_no, user_id, batch_id, batch_item_id, note_id, note_url, target_type,
            title, author_id, author_name, avatar_url, ordered_quantity, completed_quantity,
            order_status, external_progress, external_completed_quantity, created_at, updated_at
          )
        VALUES
          ('ORDER-SEARCH-SHORT-001', 1, ?, 1, 'note-short-a', 'https://www.xiaohongshu.com/explore/note-short-a', 'view', 'short a', 'author-a', 'author a', 'https://cdn.example.com/a.png', 10, 0, 'running', 0, 0, ?, ?),
          ('ORDER-SEARCH-SHORT-002', 1, ?, 2, 'note-short-b', 'https://www.xiaohongshu.com/explore/note-short-b', 'view', 'short b', 'author-b', 'author b', 'https://cdn.example.com/b.png', 20, 0, 'running', 0, 0, ?, ?)
      `,
      [batchResult.insertId, now, now, batchResult.insertId, now, now],
    );

    const searchResponse = await request(app)
      .post('/api/v1/orders/batch/search')
      .send({ content: 'http://xhslink.com/m/a-short' });

    expect(searchResponse.status).toBe(200);
    expect(searchResponse.body.data).toMatchObject({
      matched_count: 1,
      total_count: 1,
    });
    expect(searchResponse.body.data.items).toHaveLength(1);
    expect(searchResponse.body.data.items[0]).toMatchObject({
      note_id: 'note-short-a',
      source_note_url: 'http://xhslink.com/m/a-short',
    });

    await db.execute("DELETE FROM orders WHERE order_no LIKE 'ORDER-SEARCH-SHORT-%'");
    await db.execute("DELETE FROM order_batches WHERE batch_no = 'BATCH-SEARCH-SHORT'");
  });

  test('does not finalize count-complete upstream tasks until status is 2', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const getTaskStatus = jest.fn(async (targetType, taskId) => ({
      body: {
        code: 0,
        data: {
          current_count: 120,
          status: 1,
          total_count: 120,
        },
      },
      ok: true,
      status: 200,
      taskId,
    }));
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 12345 })),
      getTaskStatus,
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'view',
      });
    expect(submitResponse.status).toBe(200);

    const firstListResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(firstListResponse.status).toBe(200);

    const [[batch]] = await db.execute('SELECT id FROM order_batches WHERE batch_id = ?', [
      submitResponse.body.data.batch_id,
    ]);
    await db.execute(
      "UPDATE orders SET last_verified_at = DATE_SUB(NOW(), INTERVAL 6 MINUTE) WHERE batch_id = ?",
      [batch.id],
    );

    const secondListResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(secondListResponse.status).toBe(200);
    const listedBatch = secondListResponse.body.data.find(
      (item) => item.batch_id === submitResponse.body.data.batch_id,
    );
    expect(listedBatch).toMatchObject({
      processing_count: 1,
      status: 'processing',
      succeeded_count: 0,
    });
    expect(listedBatch.orders[0]).toMatchObject({
      external_status: 'running',
      order_status: 'running',
    });
  });

  test('finalizes upstream completed orders after five minutes and a second status 2 check', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const getTaskStatus = jest.fn(async (targetType, taskId) => ({
      body: {
        code: 0,
        data: {
          current_count: 100,
          status: 2,
          total_count: 100,
        },
      },
      ok: true,
      status: 200,
      taskId,
    }));
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 12345 })),
      getTaskStatus,
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'view',
      });
    expect(submitResponse.status).toBe(200);

    const firstListResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(firstListResponse.status).toBe(200);

    const [[batch]] = await db.execute('SELECT id FROM order_batches WHERE batch_id = ?', [
      submitResponse.body.data.batch_id,
    ]);
    await db.execute(
      "UPDATE orders SET last_verified_at = DATE_SUB(NOW(), INTERVAL 6 MINUTE) WHERE batch_id = ?",
      [batch.id],
    );

    const secondListResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(secondListResponse.status).toBe(200);
    const listedBatch = secondListResponse.body.data.find(
      (item) => item.batch_id === submitResponse.body.data.batch_id,
    );
    expect(listedBatch).toMatchObject({
      processing_count: 0,
      status: 'completed',
      succeeded_count: 1,
    });
    expect(listedBatch.orders[0]).toMatchObject({
      completed_quantity: 100,
      external_status: 'completed',
      external_task_id: '12345',
      order_status: 'completed',
    });
    expect(getTaskStatus.mock.calls.filter(([, taskId]) => taskId === '12345').length).toBeGreaterThanOrEqual(2);
  });

  test('sends the fixed xhs-api token as upstream authorization', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient(null);
    const previousToken = process.env.XHS_API_TOKEN;
    delete process.env.XHS_API_TOKEN;
    global.fetch = jest.fn(async (url, init = {}) => {
      const urlText = String(url);
      if (urlText.includes('/api/v2/note_likes') && init.method === 'GET') {
        return {
          json: async () => ({
            code: 0,
            data: {
              current_count: 106,
              status: 1,
              total_count: 20,
            },
            success: true,
          }),
          ok: true,
        };
      }
      if (urlText.includes('/api/v2/')) {
        return {
          json: async () => ({
            code: 0,
            data: { id: 123456 },
            success: true,
          }),
          ok: true,
        };
      }
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '64f1a2b3c4d5e6f789012345',
              title: 'test note',
              user: {
                id: '68c4f8c3000000001902309f',
                image: '',
                name: '',
              },
            },
            note_id: '64f1a2b3c4d5e6f789012345',
          },
        }),
        ok: true,
      };
    });

    try {
      const submitResponse = await request(app)
        .post('/api/v1/orders/batch/submit')
        .send({
          agree_policy: true,
          content: TEST_ORDER_RAW_CONTENT,
          target_type: 'view',
        });

      expect(submitResponse.status).toBe(200);
      const xhsCall = global.fetch.mock.calls.find(([url]) =>
        String(url).includes('/api/v2/note_views'),
      );
      expect(xhsCall?.[1]?.headers?.Authorization).toBe('Bearer xhs-api-123456789');
      const xhsPayload = JSON.parse(xhsCall?.[1]?.body || '{}');
      const [orders] = await db.execute(
        `
          SELECT o.id
          FROM orders o
          INNER JOIN order_batches ob ON ob.id = o.batch_id
          WHERE ob.batch_id = ?
          ORDER BY o.id ASC
        `,
        [submitResponse.body.data.batch_id],
      );
      expect(xhsPayload.author_id).toBe(
        '68c4f8c3000000001902309f',
      );
      expect(xhsPayload).not.toHaveProperty('current_count');
      expect(xhsPayload.source).toBe(`goods:${orders[0].id}`);
    } finally {
      if (previousToken === undefined) {
        delete process.env.XHS_API_TOKEN;
      } else {
        process.env.XHS_API_TOKEN = previousToken;
      }
    }
  });

  test('submits one note view task per link with matching note and author ids', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient(null);
    let nextTaskId = 123456;
    global.fetch = jest.fn(async (url, init = {}) => {
      const urlText = String(url);
      if (urlText.includes('/api/v2/')) {
        return {
          json: async () => ({
            code: 0,
            data: { id: nextTaskId++ },
            success: true,
          }),
          ok: true,
        };
      }
      if (urlText.includes('/api/v1/note/realtime')) {
        const apiUrl = new URL(String(url));
        return {
          json: async () => ({
            code: 0,
            data: {
              note_id: apiUrl.searchParams.get('note_id'),
              realTime: {
                viewNum: apiUrl.searchParams.get('note_id') === '64f1a2b3c4d5e6f789012345'
                  ? 1200
                  : 2200,
              },
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      if (urlText.includes('/api/v1/note/likes')) {
        return {
          json: async () => ({
            code: 0,
            data: {
              likes_num: 88,
              note_id: '64f1a2b3c4d5e6f789012345',
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      const apiUrl = new URL(String(url));
      const noteId = apiUrl.searchParams.get('note_id')
        || apiUrl.searchParams.get('url')?.match(/explore\/([^/?#]+)/)?.[1]
        || '64f1a2b3c4d5e6f789012345';
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: noteId,
              title: `test note ${noteId}`,
              user: {
                id: `author-${noteId}`,
                image: '',
                name: '',
              },
            },
            note_id: noteId,
          },
        }),
        ok: true,
      };
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_MULTI_ORDER_RAW_CONTENT,
        target_type: 'view',
      });

    expect(submitResponse.status).toBe(200);
    const xhsCalls = global.fetch.mock.calls.filter(([url]) =>
      String(url).includes('/api/v2/note_views'),
    );
    expect(xhsCalls).toHaveLength(2);
    const [orders] = await db.execute(
      `
        SELECT o.id, o.external_task_id, o.order_status, o.snapshot_current_read_count
        FROM orders o
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ?
        ORDER BY o.id ASC
      `,
      [submitResponse.body.data.batch_id],
    );
    expect(orders).toHaveLength(2);
    const payloads = xhsCalls.map((call) => JSON.parse(call?.[1]?.body || '{}'));
    expect(payloads.map((payload) => payload.note_id)).toEqual([
      '64f1a2b3c4d5e6f789012345',
      '6a01bbfd000000003502e655',
    ]);
    expect(payloads.map((payload) => payload.author_id)).toEqual([
      'author-64f1a2b3c4d5e6f789012345',
      'author-6a01bbfd000000003502e655',
    ]);
    expect(payloads.map((payload) => payload.source)).toEqual(
      orders.map((order) => `goods:${order.id}`),
    );
    expect(payloads.every((payload) => !Object.hasOwn(payload, 'current_count'))).toBe(true);
    expect(orders.map((order) => order.external_task_id)).toEqual(['123456', '123457']);
    expect(orders.map((order) => order.order_status)).toEqual(['running', 'running']);
    expect(orders.map((order) => Number(order.snapshot_current_read_count))).toEqual([1200, 2200]);
  });

  test('replenishes a completed view order by comparing realtime views with submit snapshot', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    let nextTaskNo = 910001;
    const createTask = jest.fn(async () => ({ id: nextTaskNo++ }));
    batchOrderService._private.setXhsTaskClient({
      createTask,
      getTaskStatus: jest.fn(async () => ({
        body: { code: 0, data: { current_count: 100, status: 2, total_count: 100 } },
        ok: true,
        status: 200,
      })),
    });
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      if (urlText.includes('/api/v1/note/realtime')) {
        return {
          json: async () => ({
            code: 0,
            data: {
              note_id: '64f1a2b3c4d5e6f789012345',
              realTime: {
                viewNum: 1050,
              },
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '64f1a2b3c4d5e6f789012345',
              title: 'test note',
              user: {
                id: 'author-1',
                image: '',
                name: '',
              },
            },
            note_id: '64f1a2b3c4d5e6f789012345',
          },
        }),
        ok: true,
      };
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'view',
      });

    expect(submitResponse.status).toBe(200);
    const [orders] = await db.execute(
      `
        SELECT o.id, o.batch_id, o.author_id
        FROM orders o
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ?
        ORDER BY o.id ASC
      `,
      [submitResponse.body.data.batch_id],
    );
    expect(orders[0].author_id).toBe('author-1');
    await db.execute('DELETE FROM note_basic_cache WHERE note_id = ?', [
      '64f1a2b3c4d5e6f789012345',
    ]);
    await db.execute(
      `
        UPDATE orders
        SET order_status = 'completed',
            external_status = 'completed',
            snapshot_current_read_count = 1000,
            snapshot_verified_read_count = NULL
        WHERE id = ?
      `,
      [orders[0].id],
    );

    const replenishResponse = await request(app)
      .post(`/api/v1/orders/batch/${orders[0].batch_id}/replenish`);

    expect(replenishResponse.status).toBe(200);
    expect(replenishResponse.body.data).toMatchObject({
      checked_count: 1,
      replenished_count: 1,
      total_replenish_quantity: 50,
    });
    expect(createTask).toHaveBeenCalledTimes(2);
    const replenishPayload = createTask.mock.calls[1][1];
    expect(replenishPayload.author_id).toBe('author-1');
    expect(replenishPayload.total_count).toBe(50);
    expect(replenishPayload.source).toBe(`goods:repair:${orders[0].id}:1`);

    const [[updatedOrder]] = await db.execute(
      `
        SELECT order_status, repair_count, external_task_id, snapshot_verified_read_count
        FROM orders
        WHERE id = ?
      `,
      [orders[0].id],
    );
    expect(updatedOrder.order_status).toBe('running');
    expect(Number(updatedOrder.repair_count)).toBe(1);
    expect(updatedOrder.external_task_id).toBe('910002');
    expect(Number(updatedOrder.snapshot_verified_read_count)).toBe(1050);
  });

  test('marks status 2 view orders as repair review after five minutes when realtime count is short', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const createTask = jest.fn(async () => ({ id: 910101 }));
    const getTaskStatus = jest.fn(async () => ({
      body: { code: 0, data: { current_count: 100, status: 2, total_count: 100 } },
      ok: true,
      status: 200,
    }));
    batchOrderService._private.setXhsTaskClient({ createTask, getTaskStatus });
    let realtimeCallCount = 0;
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      if (urlText.includes('/api/v1/note/realtime')) {
        realtimeCallCount += 1;
        return {
          json: async () => ({
            code: 0,
            data: {
              note_id: '64f1a2b3c4d5e6f789012345',
              realTime: {
                viewNum: realtimeCallCount === 1 ? 1000 : 1050,
              },
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '64f1a2b3c4d5e6f789012345',
              title: 'test note',
              user: { id: 'author-1', image: '', name: '' },
            },
            note_id: '64f1a2b3c4d5e6f789012345',
          },
        }),
        ok: true,
      };
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'view',
      });
    expect(submitResponse.status).toBe(200);

    const firstListResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(firstListResponse.status).toBe(200);
    const [[batch]] = await db.execute('SELECT id FROM order_batches WHERE batch_id = ?', [
      submitResponse.body.data.batch_id,
    ]);
    await db.execute(
      "UPDATE orders SET last_verified_at = DATE_SUB(NOW(), INTERVAL 6 MINUTE) WHERE batch_id = ?",
      [batch.id],
    );

    const secondListResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(secondListResponse.status).toBe(200);
    const listedBatch = secondListResponse.body.data.find(
      (item) => item.batch_id === submitResponse.body.data.batch_id,
    );
    expect(listedBatch).toMatchObject({
      processing_count: 1,
      status: 'processing',
      succeeded_count: 0,
    });
    expect(listedBatch.orders[0]).toMatchObject({
      completed_quantity: 50,
      external_status: 'completed',
      order_status: 'repair_review',
      reason_message: 'need replenish 50',
    });
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  test('creates a pending replenish request and lets admins approve it', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    let nextTaskNo = 930001;
    const createTask = jest.fn(async () => ({ id: nextTaskNo++ }));
    batchOrderService._private.setXhsTaskClient({
      createTask,
      getTaskStatus: jest.fn(async () => ({
        body: { code: 0, data: { current_count: 100, status: 2, total_count: 100 } },
        ok: true,
        status: 200,
      })),
    });
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      if (urlText.includes('/api/v1/note/realtime')) {
        return {
          json: async () => ({
            code: 0,
            data: {
              note_id: '64f1a2b3c4d5e6f789012345',
              realTime: { viewNum: 1050 },
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '64f1a2b3c4d5e6f789012345',
              title: 'test note',
              user: { id: 'author-1', image: '', name: '' },
            },
            note_id: '64f1a2b3c4d5e6f789012345',
          },
        }),
        ok: true,
      };
    });

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
    const [[order]] = await db.execute('SELECT id FROM orders WHERE batch_id = ?', [batch.id]);
    await db.execute(
      `
        UPDATE orders
        SET order_status = 'repair_review',
            external_status = 'completed',
            completed_quantity = 50,
            snapshot_current_read_count = 1000,
            snapshot_verified_read_count = 1050,
            reason_message = 'need replenish 50'
        WHERE id = ?
      `,
      [order.id],
    );

    const requestResponse = await request(app).post(
      `/api/v1/orders/batch/${batch.id}/replenish-request`,
    );
    expect(requestResponse.status).toBe(200);
    expect(requestResponse.body.data.status).toBe('pending');

    const listResponse = await request(app).get('/api/v1/orders/replenishments');
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.data.items[0]).toMatchObject({
      batch_id: batch.id,
      pending_order_count: 1,
      pending_quantity: 50,
      status: 'pending',
      user_id: 1,
    });

    await db.execute(
      "UPDATE orders SET order_status = 'running', completed_quantity = 80 WHERE id = ?",
      [order.id],
    );
    const changedOrderListResponse = await request(app).get('/api/v1/orders/replenishments');
    expect(changedOrderListResponse.status).toBe(200);
    expect(changedOrderListResponse.body.data.items[0]).toMatchObject({
      batch_id: batch.id,
      pending_order_count: 1,
      pending_quantity: 50,
    });

    const approveResponse = await request(app).post(
      `/api/v1/orders/replenishments/${listResponse.body.data.items[0].id}/approve`,
    );
    expect(approveResponse.status).toBe(200);
    expect(approveResponse.body.data.result.replenished_count).toBe(1);
    expect(createTask).toHaveBeenCalledTimes(2);

    const [[updatedRequest]] = await db.execute(
      'SELECT status FROM order_replenishment_records WHERE id = ?',
      [listResponse.body.data.items[0].id],
    );
    expect(updatedRequest.status).toBe('approved');
  });

  test('blocks non-admin users from approving replenish requests directly', async () => {
    const db = getPool();
    const [[normalUser]] = await db.execute(
      "SELECT u.id FROM users u INNER JOIN user_roles ur ON ur.user_id = u.id INNER JOIN roles r ON r.id = ur.role_id WHERE r.code = 'user' ORDER BY u.id DESC LIMIT 1",
    );
    const response = await request(app)
      .post('/api/v1/orders/replenishments/1/approve')
      .set('Authorization', `Bearer dev-token-${normalUser.id}`);

    expect(response.status).toBe(403);
  });

  test('replenishes a completed like order by comparing latest likes with submit snapshot', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    let nextTaskNo = 920001;
    const createTask = jest.fn(async () => ({ id: nextTaskNo++ }));
    batchOrderService._private.setXhsTaskClient({
      createTask,
      getTaskStatus: jest.fn(async () => ({
        body: { code: 0, data: { current_count: 120, status: 2, total_count: 120 } },
        ok: true,
        status: 200,
      })),
    });
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      if (urlText.includes('/api/v1/note/likes')) {
        return {
          json: async () => ({
            code: 0,
            data: {
              likes_num: urlText.includes('recheck') ? 112 : 100,
              note_id: '64f1a2b3c4d5e6f789012345',
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '64f1a2b3c4d5e6f789012345',
              title: 'test note',
              user: {
                id: 'author-1',
                image: '',
                name: '',
              },
            },
            note_id: '64f1a2b3c4d5e6f789012345',
          },
        }),
        ok: true,
      };
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345 20',
        target_type: 'like',
      });

    expect(submitResponse.status).toBe(200);
    const [orders] = await db.execute(
      `
        SELECT o.id, o.batch_id
        FROM orders o
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ?
        ORDER BY o.id ASC
      `,
      [submitResponse.body.data.batch_id],
    );
    await db.execute(
      `
        UPDATE orders
        SET order_status = 'completed',
            external_status = 'completed',
            like_count = 100
        WHERE id = ?
      `,
      [orders[0].id],
    );

    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      if (urlText.includes('/api/v1/note/likes')) {
        return {
          json: async () => ({
            code: 0,
            data: {
              likes_num: 112,
              note_id: '64f1a2b3c4d5e6f789012345',
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      return { json: async () => ({ code: 0 }), ok: true };
    });

    const replenishResponse = await request(app)
      .post(`/api/v1/orders/batch/${orders[0].batch_id}/replenish`);

    expect(replenishResponse.status).toBe(200);
    expect(replenishResponse.body.data).toMatchObject({
      checked_count: 1,
      replenished_count: 1,
      total_replenish_quantity: 8,
    });
    expect(createTask).toHaveBeenCalledTimes(2);
    const replenishPayload = createTask.mock.calls[1][1];
    expect(replenishPayload.total_count).toBe(120);
    expect(replenishPayload.source).toBe(`goods:repair:${orders[0].id}:1`);

    const [[updatedOrder]] = await db.execute(
      `
        SELECT order_status, repair_count, external_task_id, snapshot_verified_like_count
        FROM orders
        WHERE id = ?
      `,
      [orders[0].id],
    );
    expect(updatedOrder.order_status).toBe('running');
    expect(Number(updatedOrder.repair_count)).toBe(1);
    expect(updatedOrder.external_task_id).toBe('920002');
    expect(Number(updatedOrder.snapshot_verified_like_count)).toBe(112);
  });

  test('submits one impression task per link with matching note and author ids', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient(null);
    let nextTaskId = 56789;
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      if (urlText.includes('/api/v1/note/likes')) {
        return {
          json: async () => ({
            code: 0,
            data: {
              likes_num: 88,
              note_id: '64f1a2b3c4d5e6f789012345',
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      if (urlText.includes('/api/v2/')) {
        return {
          json: async () => ({
            code: 0,
            data: { id: nextTaskId++ },
            success: true,
          }),
          ok: true,
        };
      }
      const apiUrl = new URL(String(url));
      const noteId = apiUrl.searchParams.get('note_id')
        || apiUrl.searchParams.get('url')?.match(/explore\/([^/?#]+)/)?.[1]
        || '64f1a2b3c4d5e6f789012345';
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: noteId,
              title: `test note ${noteId}`,
              user: {
                id: `author-${noteId}`,
                image: '',
                name: '',
              },
            },
            note_id: noteId,
          },
        }),
        ok: true,
      };
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_MULTI_ORDER_RAW_CONTENT,
        target_type: 'impression',
      });

    expect(submitResponse.status).toBe(200);
    const xhsCalls = global.fetch.mock.calls.filter(([url]) =>
      String(url).includes('/api/v2/impression'),
    );
    expect(xhsCalls).toHaveLength(2);
    const [orders] = await db.execute(
      `
        SELECT o.id, o.external_task_id, o.order_status
        FROM orders o
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ?
        ORDER BY o.id ASC
      `,
      [submitResponse.body.data.batch_id],
    );
    expect(orders).toHaveLength(2);
    const payloads = xhsCalls.map((call) => JSON.parse(call?.[1]?.body || '{}'));
    expect(payloads.map((payload) => payload.note_id)).toEqual([
      '64f1a2b3c4d5e6f789012345',
      '6a01bbfd000000003502e655',
    ]);
    expect(payloads.map((payload) => payload.author_id)).toEqual([
      'author-64f1a2b3c4d5e6f789012345',
      'author-6a01bbfd000000003502e655',
    ]);
    expect(payloads.map((payload) => payload.source)).toEqual(
      orders.map((order) => `goods:${order.id}`),
    );
    expect(payloads.every((payload) => !Object.hasOwn(payload, 'current_count'))).toBe(true);
    expect(orders.map((order) => order.external_task_id)).toEqual(['56789', '56790']);
    expect(orders.map((order) => order.order_status)).toEqual(['running', 'running']);
  });

  test('submits one note like task per link with matching note and author ids', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient(null);
    let nextTaskId = 34567;
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      if (urlText.includes('/api/v1/note/likes')) {
        return {
          json: async () => ({
            code: 0,
            data: {
              likes_num: 88,
              note_id: '64f1a2b3c4d5e6f789012345',
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      if (urlText.includes('/api/v2/')) {
        return {
          json: async () => ({
            code: 0,
            data: { id: nextTaskId++ },
            success: true,
          }),
          ok: true,
        };
      }
      const apiUrl = new URL(String(url));
      const noteId = apiUrl.searchParams.get('note_id')
        || apiUrl.searchParams.get('url')?.match(/explore\/([^/?#]+)/)?.[1]
        || '64f1a2b3c4d5e6f789012345';
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: noteId,
              title: `test note ${noteId}`,
              user: {
                id: `author-${noteId}`,
                image: '',
                name: '',
              },
            },
            note_id: noteId,
          },
        }),
        ok: true,
      };
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_MULTI_ORDER_RAW_CONTENT,
        target_type: 'like',
      });

    expect(submitResponse.status).toBe(200);
    const xhsCalls = global.fetch.mock.calls.filter(([url, init]) =>
      String(url).includes('/api/v2/note_likes') && init?.method === 'POST',
    );
    expect(xhsCalls).toHaveLength(2);
    const [orders] = await db.execute(
      `
        SELECT o.id, o.external_task_id, o.like_count, o.order_status
        FROM orders o
        INNER JOIN order_batches ob ON ob.id = o.batch_id
        WHERE ob.batch_id = ?
        ORDER BY o.id ASC
      `,
      [submitResponse.body.data.batch_id],
    );
    expect(orders).toHaveLength(2);
    const payloads = xhsCalls.map((call) => JSON.parse(call?.[1]?.body || '{}'));
    expect(payloads.map((payload) => payload.note_id)).toEqual([
      '64f1a2b3c4d5e6f789012345',
      '6a01bbfd000000003502e655',
    ]);
    expect(payloads.map((payload) => payload.author_id)).toEqual([
      'author-64f1a2b3c4d5e6f789012345',
      'author-6a01bbfd000000003502e655',
    ]);
    expect(payloads.map((payload) => payload.source)).toEqual(
      orders.map((order) => `goods:${order.id}`),
    );
    expect(payloads.map((payload) => payload.total_count)).toEqual([188, 288]);
    expect(payloads.map((payload) => payload.need_sync)).toEqual([false, false]);
    expect(payloads.every((payload) => !Object.hasOwn(payload, 'current_count'))).toBe(true);
    expect(orders.map((order) => Number(order.like_count))).toEqual([88, 88]);
    expect(orders.map((order) => order.external_task_id)).toEqual(['34567', '34568']);
    expect(orders.map((order) => order.order_status)).toEqual(['running', 'running']);
  });

  test('queries impression status with the impression endpoint and updates progress', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const getTaskStatus = jest.fn(async (targetType, taskId) => ({
      body: {
        code: 0,
        data: {
          current_count: 50,
          status: 1,
          total_count: 100,
        },
      },
      ok: true,
      status: 200,
      taskId,
    }));
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 56789 })),
      getTaskStatus,
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'impression',
      });

    expect(submitResponse.status).toBe(200);
    const listResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(listResponse.status).toBe(200);
    expect(getTaskStatus).toHaveBeenCalledWith(
      'impression',
      '56789',
      {
        token: 'xhs-api-123456789',
      },
    );
    const listedBatch = listResponse.body.data.find(
      (item) => item.batch_id === submitResponse.body.data.batch_id,
    );
    expect(listedBatch).toMatchObject({
      processing_count: 1,
      status: 'processing',
      succeeded_count: 0,
    });
    expect(listedBatch.orders[0]).toMatchObject({
      completed_quantity: 50,
      external_task_id: '56789',
      order_status: 'running',
    });
  });

  test('queries note like status with the note_likes endpoint and updates progress', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient(null);
    global.fetch = jest.fn(async (url, init = {}) => {
      const urlText = String(url);
      if (urlText.includes('/api/v2/note_likes') && init.method === 'POST') {
        return {
          json: async () => ({ code: 0, data: { id: 34567 }, success: true }),
          ok: true,
          status: 200,
        };
      }
      if (urlText.includes('/api/v2/note_likes') && init.method === 'GET') {
        return {
          json: async () => ({
            code: 0,
            data: {
              current_count: 5,
              status: 1,
              total_count: 100,
            },
            success: true,
          }),
          ok: true,
          status: 200,
        };
      }
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '64f1a2b3c4d5e6f789012345',
              title: 'test note',
              user: {
                id: 'author-64f1a2b3c4d5e6f789012345',
                image: '',
                name: '',
              },
            },
            note_id: '64f1a2b3c4d5e6f789012345',
          },
        }),
        ok: true,
        status: 200,
      };
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'like',
      });
    expect(submitResponse.status).toBe(200);

    const listResponse = await request(app).get('/api/v1/orders/batch/records');
    expect(listResponse.status).toBe(200);
    expect(
      global.fetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/v2/note_likes?id=34567') && init?.method === 'GET',
      ),
    ).toBe(true);
    const listedBatch = listResponse.body.data.find(
      (item) => item.batch_id === submitResponse.body.data.batch_id,
    );
    expect(listedBatch.orders[0]).toMatchObject({
      completed_quantity: 5,
      external_task_id: '34567',
      order_status: 'running',
    });
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

  test('lists repair completion metadata in consumption order items', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 12345 })),
      getTaskStatus: jest.fn(async () => ({
        body: { code: 0, data: { current_count: 100, status: 2, total_count: 100 } },
        ok: true,
        status: 200,
      })),
    });

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
    await db.execute(
      `
        UPDATE orders
        SET order_status = 'running',
            external_status = 'completed',
            repair_count = 1,
            last_verified_at = NOW()
        WHERE id = ?
      `,
      [order.id],
    );

    const response = await request(app).get('/api/v1/orders/consumption-records');
    expect(response.status).toBe(200);
    const orderItems = response.body.data.items.flatMap((item) => item.order_items || []);
    expect(orderItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          external_status: 'completed',
          order_id: order.id,
          order_status: 'running',
          repair_count: 1,
        }),
      ]),
    );
  });

  test('refund approval returns only the unfinished upstream quantity amount', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const getTaskStatus = jest.fn(async () => ({
      body: {
        code: 0,
        data: {
          current_count: 40,
          status: 1,
          total_count: 100,
        },
      },
      ok: true,
      status: 200,
    }));
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 12345 })),
      getTaskStatus,
      updateTaskStatus: jest.fn(async () => ({ code: 0, success: true })),
    });

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
    const [[chargeRecord]] = await db.execute(
      "SELECT actual_paid_amount FROM account_records WHERE order_id = ? AND record_type = 'order_charge'",
      [order.id],
    );
    const expectedRefundAmount = Math.round(Number(chargeRecord.actual_paid_amount) * 0.6 * 10000) / 10000;

    expect((await request(app).post(`/api/v1/orders/${order.id}/refund-request`)).status).toBe(200);
    const reviewResponse = await request(app)
      .post(`/api/v1/orders/${order.id}/refund-review`)
      .send({ approved: true, reason: 'partial refund' });
    expect(reviewResponse.status).toBe(200);

    const [[updatedOrder]] = await db.execute(
      'SELECT completed_quantity, external_completed_quantity, refunded_quantity, refund_amount_total FROM orders WHERE id = ?',
      [order.id],
    );
    expect(updatedOrder).toMatchObject({
      completed_quantity: 40,
      external_completed_quantity: 40,
      refunded_quantity: 60,
    });
    expect(Number(updatedOrder.refund_amount_total)).toBe(expectedRefundAmount);

    const [[refundRecord]] = await db.execute(
      "SELECT completed_quantity, refunded_quantity, refund_amount FROM account_records WHERE order_id = ? AND record_type = 'refund'",
      [order.id],
    );
    expect(refundRecord).toMatchObject({
      completed_quantity: 40,
      refunded_quantity: 60,
    });
    expect(Number(refundRecord.refund_amount)).toBe(expectedRefundAmount);
    expect(getTaskStatus).toHaveBeenCalledWith(
      'view',
      '12345',
      {
        token: 'xhs-api-123456789',
      },
    );
  });

  test('refund rejection restores the order to running', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 12345 })),
      updateTaskStatus: jest.fn(async () => ({ code: 0, success: true })),
    });

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

    expect((await request(app).post(`/api/v1/orders/${order.id}/refund-request`)).status).toBe(200);
    const reviewResponse = await request(app)
      .post(`/api/v1/orders/${order.id}/refund-review`)
      .send({ approved: false, reason: 'reject test' });

    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.body.data).toMatchObject({
      order_status: 'running',
      refunded_amount: 0,
    });

    const [[updatedOrder]] = await db.execute(
      'SELECT order_status, reason_message FROM orders WHERE id = ?',
      [order.id],
    );
    expect(updatedOrder).toMatchObject({
      order_status: 'running',
      reason_message: 'reject test',
    });
  });

  test('refund rejection creates a replenishment request when actual delivery is short', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 34567 })),
      updateTaskStatus: jest.fn(async () => ({ code: 0, success: true })),
    });
    let likeCallCount = 0;
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      if (urlText.includes('/api/v1/note/likes')) {
        likeCallCount += 1;
        return {
          json: async () => ({
            code: 0,
            data: {
              likes_num: likeCallCount === 1 ? 100 : 106,
              note_id: '64f1a2b3c4d5e6f789012345',
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '64f1a2b3c4d5e6f789012345',
              title: 'test note',
              user: { id: 'author-1', image: '', name: '' },
            },
            note_id: '64f1a2b3c4d5e6f789012345',
          },
        }),
        ok: true,
      };
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345 20',
        target_type: 'like',
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

    expect((await request(app).post(`/api/v1/orders/${order.id}/refund-request`)).status).toBe(200);
    const reviewResponse = await request(app)
      .post(`/api/v1/orders/${order.id}/refund-review`)
      .send({ approved: false, reason: 'reject and check repair' });

    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.body.data).toMatchObject({
      order_status: 'repair_review',
      refunded_amount: 0,
    });
    expect(reviewResponse.body.data.replenishment_request_id).toBeTruthy();

    const [[updatedOrder]] = await db.execute(
      'SELECT order_status, completed_quantity, reason_message FROM orders WHERE id = ?',
      [order.id],
    );
    expect(updatedOrder).toMatchObject({
      completed_quantity: 6,
      order_status: 'repair_review',
    });
    expect(updatedOrder.reason_message).toContain('退款被拒绝后复查未完成');

    const [[repairRequest]] = await db.execute(
      'SELECT status, shortage_quantity, reason_message FROM order_replenishment_records WHERE order_id = ?',
      [order.id],
    );
    expect(repairRequest).toMatchObject({
      shortage_quantity: 14,
      status: 'pending',
    });
    expect(repairRequest.reason_message).toContain('退款被拒绝后复查未完成');
  });

  test('refund rejection completes the order when actual delivery is enough', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 34567 })),
      updateTaskStatus: jest.fn(async () => ({ code: 0, success: true })),
    });
    let likeCallCount = 0;
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      if (urlText.includes('/api/v1/note/likes')) {
        likeCallCount += 1;
        return {
          json: async () => ({
            code: 0,
            data: {
              likes_num: likeCallCount === 1 ? 100 : 120,
              note_id: '64f1a2b3c4d5e6f789012345',
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '64f1a2b3c4d5e6f789012345',
              title: 'test note',
              user: { id: 'author-1', image: '', name: '' },
            },
            note_id: '64f1a2b3c4d5e6f789012345',
          },
        }),
        ok: true,
      };
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345 20',
        target_type: 'like',
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

    expect((await request(app).post(`/api/v1/orders/${order.id}/refund-request`)).status).toBe(200);
    const reviewResponse = await request(app)
      .post(`/api/v1/orders/${order.id}/refund-review`)
      .send({ approved: false, reason: 'delivery enough' });

    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.body.data).toMatchObject({
      order_status: 'completed',
      refunded_amount: 0,
    });

    const [[updatedOrder]] = await db.execute(
      `
        SELECT order_status, completed_quantity, external_completed_quantity,
          external_progress, external_status, reason_message
        FROM orders
        WHERE id = ?
      `,
      [order.id],
    );
    expect(updatedOrder).toMatchObject({
      completed_quantity: 20,
      external_completed_quantity: 20,
      external_status: 'completed',
      order_status: 'completed',
      reason_message: 'delivery enough',
    });
    expect(Number(updatedOrder.external_progress)).toBe(1);
  });

  test('refund approval for repaired like orders refunds the real undelivered quantity', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const getTaskStatus = jest.fn(async () => ({
      body: {
        code: 0,
        data: {
          current_count: 20,
          status: 2,
          total_count: 20,
        },
      },
      ok: true,
      status: 200,
    }));
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 34567 })),
      getTaskStatus,
      updateTaskStatus: jest.fn(async () => ({ code: 0, success: true })),
    });
    let likeCallCount = 0;
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      if (urlText.includes('/api/v1/note/likes')) {
        likeCallCount += 1;
        return {
          json: async () => ({
            code: 0,
            data: {
              likes_num: likeCallCount === 1 ? 100 : 106,
              note_id: '64f1a2b3c4d5e6f789012345',
            },
            msg: 'ok',
          }),
          ok: true,
        };
      }
      return {
        json: async () => ({
          code: 0,
          data: {
            base_info: {
              id: '64f1a2b3c4d5e6f789012345',
              title: 'test note',
              user: { id: 'author-1', image: '', name: '' },
            },
            note_id: '64f1a2b3c4d5e6f789012345',
          },
        }),
        ok: true,
      };
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: 'https://www.xiaohongshu.com/explore/64f1a2b3c4d5e6f789012345 20',
        target_type: 'like',
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
    const [[chargeRecord]] = await db.execute(
      "SELECT actual_paid_amount FROM account_records WHERE order_id = ? AND record_type = 'order_charge'",
      [order.id],
    );
    await db.execute(
      `
        UPDATE orders
        SET repair_count = 1,
            completed_quantity = 4,
            external_completed_quantity = 4,
            external_status = 'completed'
        WHERE id = ?
      `,
      [order.id],
    );

    expect((await request(app).post(`/api/v1/orders/${order.id}/refund-request`)).status).toBe(200);
    const reviewResponse = await request(app)
      .post(`/api/v1/orders/${order.id}/refund-review`)
      .send({ approved: true, reason: 'repair partial refund' });

    const expectedRefundAmount =
      Math.round(Number(chargeRecord.actual_paid_amount) * (14 / 20) * 10000) / 10000;
    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.body.data.refunded_amount).toBe(expectedRefundAmount);

    const [[updatedOrder]] = await db.execute(
      'SELECT completed_quantity, external_completed_quantity, refunded_quantity, refund_amount_total FROM orders WHERE id = ?',
      [order.id],
    );
    expect(updatedOrder).toMatchObject({
      completed_quantity: 6,
      external_completed_quantity: 6,
      refunded_quantity: 14,
    });
    expect(Number(updatedOrder.refund_amount_total)).toBe(expectedRefundAmount);
  });

  test('refund approval closes zero-refundable requests without throwing', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: 12345 })),
      getTaskStatus: jest.fn(async () => ({
        body: {
          code: 0,
          data: {
            current_count: 100,
            status: 1,
            total_count: 100,
          },
        },
        ok: true,
        status: 200,
      })),
      updateTaskStatus: jest.fn(async () => ({ code: 0, success: true })),
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: 'like',
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

    expect((await request(app).post(`/api/v1/orders/${order.id}/refund-request`)).status).toBe(200);
    const reviewResponse = await request(app)
      .post(`/api/v1/orders/${order.id}/refund-review`)
      .send({ approved: true, reason: 'zero refundable' });

    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.body.data).toMatchObject({
      order_status: 'refund_rejected',
      refunded_amount: 0,
    });

    const [[updatedOrder]] = await db.execute(
      'SELECT order_status, refund_amount_total, refunded_quantity, reason_message FROM orders WHERE id = ?',
      [order.id],
    );
    expect(updatedOrder).toMatchObject({
      order_status: 'refund_rejected',
      refunded_quantity: 0,
    });
    expect(Number(updatedOrder.refund_amount_total)).toBe(0);
    expect(updatedOrder.reason_message).toBe('无可退款金额');
  });

  test.each([
    ['view', 'note_views', 12345],
    ['impression', 'impression', 56789],
    ['like', 'note_likes', 34567],
  ])('requests xhs %s task stop before entering refund review', async (targetType, endpoint, taskId) => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const updateTaskStatus = jest.fn(async () => ({ code: 0, success: true }));
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: taskId })),
      getTaskStatus: jest.fn(async () => ({
        body: { code: 0, data: { current_count: 0, status: 1, total_count: 100 } },
        ok: true,
        status: 200,
      })),
      updateTaskStatus,
    });

    const submitResponse = await request(app)
      .post('/api/v1/orders/batch/submit')
      .send({
        agree_policy: true,
        content: TEST_ORDER_RAW_CONTENT,
        target_type: targetType,
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

    const refundResponse = await request(app).post(`/api/v1/orders/${order.id}/refund-request`);
    expect(refundResponse.status).toBe(200);
    expect(updateTaskStatus).toHaveBeenCalledWith(
      targetType,
      {
        id: taskId,
        reason: expect.stringContaining('refund requested'),
        status: 3,
      },
      {
        token: 'xhs-api-123456789',
      },
    );

    const [[updatedOrder]] = await db.execute('SELECT order_status FROM orders WHERE id = ?', [
      order.id,
    ]);
    expect(updatedOrder.order_status).toBe('refund_requested');
    expect(endpoint).toBe(
      targetType === 'view'
        ? 'note_views'
        : targetType === 'like'
          ? 'note_likes'
          : 'impression',
    );
  });

  test('automatically refunds charged failed orders and disables retry', async () => {
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
    const [[beforeBalance]] = await db.execute(
      'SELECT available_amount FROM balance_accounts WHERE user_id = 1',
    );

    const retryResponse = await request(app).post(`/api/v1/orders/batch/${batch.id}/retry`);
    expect(retryResponse.status).toBe(400);

    const recordsResponse = await request(app).get('/api/v1/orders/batch/records?page=1&page_size=100');
    expect(recordsResponse.status).toBe(200);

    const [[order]] = await db.execute('SELECT order_status, refund_amount_total, refunded_quantity, reason_message FROM orders WHERE batch_id = ?', [
      batch.id,
    ]);
    expect(order).toMatchObject({
      order_status: 'failed',
      refunded_quantity: 100,
    });
    expect(Number(order.refund_amount_total)).toBeGreaterThan(0);

    const [[refundRecord]] = await db.execute(
      "SELECT refund_amount FROM account_records WHERE order_id = (SELECT id FROM orders WHERE batch_id = ?) AND record_type = 'refund'",
      [batch.id],
    );
    expect(Number(refundRecord.refund_amount)).toBeGreaterThan(0);

    const [[afterBalance]] = await db.execute(
      'SELECT available_amount FROM balance_accounts WHERE user_id = 1',
    );
    expect(Number(afterBalance.available_amount)).toBe(
      Number(beforeBalance.available_amount) + Number(refundRecord.refund_amount),
    );

    const listedBatch = recordsResponse.body.data.items.find((item) => item.id === batch.id);
    expect(listedBatch).toMatchObject({
      failed_count: 1,
      retryable_count: 0,
      status: 'failed',
      succeeded_count: 0,
    });
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

  test('treats missing XHS task ids as failed orders without charging', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 1000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    batchOrderService._private.setXhsTaskClient({
      createTask: jest.fn(async () => ({ id: null })),
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
    expect(order.reason_message).toContain('missing task id');

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

  test('does not retry unsubmitted XHS failures', async () => {
    const db = getPool();
    await db.execute(
      'INSERT INTO balance_accounts (user_id, available_amount) VALUES (1, 10000) ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)',
    );
    const createTask = jest
      .fn()
      .mockRejectedValueOnce(new Error('XHS service unreachable'));
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

    expect(retryResponse.status).toBe(400);
    expect(createTask).toHaveBeenCalledTimes(1);

    const [[order]] = await db.execute(
      'SELECT external_task_id, order_status, reason_message FROM orders WHERE batch_id = ?',
      [batch.id],
    );
    expect(order).toMatchObject({
      external_task_id: null,
      order_status: 'failed',
    });
    expect(order.reason_message).toContain('XHS service unreachable');

    const [[charge]] = await db.execute(
      "SELECT COUNT(1) AS count, COALESCE(SUM(payable_amount), 0) AS amount FROM account_records WHERE order_id = (SELECT id FROM orders WHERE batch_id = ?) AND record_type = 'order_charge'",
      [batch.id],
    );
    expect(Number(charge.count)).toBe(0);
    expect(Number(charge.amount)).toBe(0);

    const [[balance]] = await db.execute(
      'SELECT available_amount FROM balance_accounts WHERE user_id = 1',
    );
    expect(Number(balance.available_amount)).toBe(10000);
  });
});
