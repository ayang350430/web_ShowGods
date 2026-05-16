const crypto = require('node:crypto');

const { getPool } = require('../config/database');

const TARGET_TYPES = new Set(['view', 'impression', 'like']);
const NOTE_BASIC_API = 'http://zl.2kpi.cn/api/v1/note/basic';
const NOTE_ID_API = 'http://zl.2kpi.cn/api/v1/note/id';
const XHS_API_ENDPOINTS = {
  impression: '/api/v2/impression',
  like: '/api/v2/note_likes',
  view: '/api/v2/note_views',
};
let noteBasicCacheTableReady;
let problemLinkRecordTableReady;
let batchLinkCheckRecordTableReady;
let orderSnapshotColumnsReady;
let xhsTaskClientOverride = null;

const round4 = (value) => Math.round((Number(value) || 0) * 10_000) / 10_000;

const ADMIN_ROLES = new Set(['super', 'admin']);

const getUserRoleCodes = async (db, userId) => {
  const [rows] = await db.execute(
    `
      SELECT r.code
      FROM roles r
      INNER JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ?
      ORDER BY FIELD(r.code, 'super', 'admin', 'user'), r.code
    `,
    [userId],
  );

  return rows.map((row) => row.code);
};

const canViewAllAccountRecords = async (db, userId) => {
  const roleCodes = await getUserRoleCodes(db, userId);
  return roleCodes.some((roleCode) => ADMIN_ROLES.has(roleCode));
};

const normalizeTargetType = (value) => {
  const targetType = String(value || 'view').trim().toLowerCase();
  return TARGET_TYPES.has(targetType) ? targetType : 'view';
};

const normalizeDiscountRate = (value) => {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? round4(rate) : 1;
};

const getBatchCheckConcurrency = () => {
  const concurrency = Number(process.env.BATCH_CHECK_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    return 30;
  }

  return Math.min(concurrency, 100);
};

const setXhsTaskClient = (client) => {
  xhsTaskClientOverride = client || null;
};

// XHS API configuration
const getXhsApiConfig = () => ({
  baseUrl: process.env.XHS_API_BASE_URL || 'http://192.168.31.134:9101',
  timeoutMs: Number(process.env.XHS_API_TIMEOUT_MS) || 10_000,
});

const createDefaultXhsTaskClient = () => ({
  getTaskStatus: async (targetType, taskId, options = {}) => {
    const config = getXhsApiConfig();
    const token = options.token || process.env.XHS_API_TOKEN || '';
    if (!token) {
      throw new Error('XHS authorization token is not configured');
    }
    const endpoint = XHS_API_ENDPOINTS[targetType];
    if (!endpoint) {
      throw new Error(`Unsupported XHS task type: ${targetType}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const url = new URL(`${config.baseUrl}${endpoint}`);
    url.searchParams.set('id', taskId);
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    try {
      console.log(`GET ${url.pathname}${url.search}`);
      const response = await fetch(url, {
        headers,
        method: 'GET',
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      console.log(`RESPONSE ${url.pathname}${url.search}`, JSON.stringify(body, null, 2));
      return {
        body,
        completed: getXhsTaskStatus(body) === 2,
        ok: response.ok,
        status: response.status,
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`XHS status request timed out after ${config.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  },

  createTask: async (targetType, payload, options = {}) => {
    const config = getXhsApiConfig();
    const token = options.token || process.env.XHS_API_TOKEN || '';
    if (!token) {
      throw new Error('XHS authorization token is not configured');
    }

    const endpoint = XHS_API_ENDPOINTS[targetType];
    if (!endpoint) {
      throw new Error(`Unsupported XHS task type: ${targetType}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const url = `${config.baseUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    try {
      if (targetType === 'impression') {
        console.log(`POST ${endpoint}`, JSON.stringify(payload, null, 2));
      }
      const response = await fetch(url, {
        body: JSON.stringify(payload),
        headers,
        method: 'POST',
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (targetType === 'impression') {
        console.log(`RESPONSE ${endpoint}`, JSON.stringify(body, null, 2));
      }
      if (!response.ok || body?.success === false || body?.code !== 0) {
        throw new Error(body?.message || `XHS API request failed with HTTP ${response.status}`);
      }

      const taskId = body?.data?.id;
      if (taskId === null || taskId === undefined || taskId === '') {
        throw new Error('XHS API response missing task id');
      }

      return { id: taskId };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`XHS API request timed out after ${config.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  },

  updateTaskStatus: async (targetType, payload, options = {}) => {
    const config = getXhsApiConfig();
    const token = options.token || process.env.XHS_API_TOKEN || '';
    if (!token) {
      throw new Error('XHS authorization token is not configured');
    }

    const endpoint = XHS_API_ENDPOINTS[targetType];
    if (!endpoint) {
      throw new Error(`Unsupported XHS task type: ${targetType}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const statusEndpoint = `${endpoint}/status`;
    const url = `${config.baseUrl}${statusEndpoint}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const sendStatusUpdate = async (statusPayload) => {
      console.log(`POST ${statusEndpoint}`, JSON.stringify(statusPayload, null, 2));
      const response = await fetch(url, {
        body: JSON.stringify(statusPayload),
        headers,
        method: 'POST',
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      console.log(`RESPONSE ${statusEndpoint}`, JSON.stringify(body, null, 2));
      return { body, response };
    };

    try {
      const { body, response } = await sendStatusUpdate(payload);

      if (!response.ok || body?.success === false || body?.code !== 0) {
        throw new Error(body?.message || `XHS status update failed with HTTP ${response.status}`);
      }
      return body;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`XHS status update timed out after ${config.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  },
});

const getXhsTaskClient = () => {
  const defaultClient = createDefaultXhsTaskClient();
  return xhsTaskClientOverride ? { ...defaultClient, ...xhsTaskClientOverride } : defaultClient;
};

const createCurrentUserToken = () => 'xhs-api-123456789';

const getXhsStatusData = (body) => body?.data ?? body ?? {};

const getXhsTaskStatus = (body) => {
  const data = getXhsStatusData(body);
  return Number(data.status ?? body?.status ?? 0) || 0;
};

const getXhsTaskCount = (body, key) => {
  const data = getXhsStatusData(body);
  return Number(data[key] ?? body?.[key] ?? 0) || 0;
};

const createXhsTaskPayload = ({ batchNo, item, orderNo, source, targetType }) => ({
  author_id: item.author_id || '',
  current_count: 0,
  note_id: item.note_id,
  priority: 0,
  reason: `goods_order=${orderNo};session=${batchNo}`,
  source: source || `goods:${batchNo}`,
  status: 1,
  total_count: item.ordered_quantity,
  ...(targetType === 'view'
    ? {
        app_count: 0,
        channel: 1,
        mp_count: 0,
        web_count: 0,
      }
    : {}),
  ...(targetType === 'like'
    ? {
        need_sync: false,
      }
    : {}),
});

const normalizeXhsErrorMessage = (error) =>
  `XHS task create failed: ${String(error?.message || error || 'unknown error').slice(0, 220)}`;

const createAsyncLimiter = (limit) => {
  let activeCount = 0;
  const queue = [];

  const next = () => {
    activeCount -= 1;
    const pending = queue.shift();
    if (pending) {
      pending();
    }
  };

  return (task) =>
    new Promise((resolve, reject) => {
      const run = () => {
        activeCount += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(next);
      };

      if (activeCount < limit) {
        run();
        return;
      }

      queue.push(run);
    });
};

const extractNoteId = (noteUrl) => {
  try {
    const url = new URL(noteUrl);
    const redirectPath = url.searchParams.get('redirectPath');
    if (redirectPath) {
      const redirectedNoteId = extractNoteId(redirectPath);
      if (redirectedNoteId) {
        return redirectedNoteId;
      }
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const markerIndex = segments.findIndex((segment) =>
      ['discovery', 'explore', 'item'].includes(segment),
    );
    const candidates = markerIndex >= 0 ? segments.slice(markerIndex + 1) : segments;

    return candidates.find((segment) => /^[a-zA-Z0-9_-]{8,}$/.test(segment)) || '';
  } catch {
    return '';
  }
};

// 检查笔记链接是否为短链接
const isShortNoteLink = (noteUrl) => {
  try {
    const url = new URL(noteUrl);
    return /(^|\.)xhslink\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
};

// 规范媒体URL中的特殊字符
const normalizeMediaUrl = (value) =>
  String(value || '').replaceAll('\\u002F', '/').replaceAll('\\/', '/');

const findFirstStringByKey = (value, keyPattern) => {
  if (!value || typeof value !== 'object') {
    return '';
  }

  for (const [key, entry] of Object.entries(value)) {
    if (keyPattern.test(key) && typeof entry === 'string' && entry) {
      return normalizeMediaUrl(entry);
    }

    if (entry && typeof entry === 'object') {
      const childValue = findFirstStringByKey(entry, keyPattern);
      if (childValue) {
        return childValue;
      }
    }
  }

  return '';
};

// 规范笔记基本信息响应
const normalizeNoteBasicResponse = (payload, noteId, noteUrl) => {
  const data = payload?.data ?? payload?.result ?? payload;
  const success =
    payload?.code === 0 ||
    payload?.success === true ||
    data?.success === true ||
    Boolean(data && !payload?.code && !payload?.msg);

  if (!success || !data) {
    return null;
  }

  const avatarUrl =
    findFirstStringByKey(data, /avatar|avatarUrl|image|imageUrl|icon/i) || '';
  const resolvedNoteId =
    findFirstStringByKey(data, /^note_?id$|^id$/i) || noteId;
  const title = findFirstStringByKey(data, /^title$|desc|display_title/i);
  const authorName = findFirstStringByKey(data, /nickname|nickName|userName|name/i);
  const authorId =
    data?.base_info?.user?.id ||
    data?.baseInfo?.user?.id ||
    data?.user?.id ||
    data?.author?.id ||
    '';

  return {
    author_id: authorId,
    author_name: authorName,
    avatar_url: avatarUrl,
    note_id: resolvedNoteId,
    note_url: noteUrl,
    title,
  };
};

// 确保笔记基本信息缓存表存在
const ensureNoteBasicCacheTable = async (db) => {
  if (!noteBasicCacheTableReady) {
    noteBasicCacheTableReady = db.execute(`
      CREATE TABLE IF NOT EXISTS note_basic_cache (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        source_url VARCHAR(1024) NOT NULL,
        note_id VARCHAR(64) NOT NULL,
        resolved_note_url VARCHAR(1024) DEFAULT NULL,
        title VARCHAR(255) DEFAULT NULL,
        author_id VARCHAR(64) DEFAULT NULL,
        author_name VARCHAR(128) DEFAULT NULL,
        avatar_url VARCHAR(1024) DEFAULT NULL,
        raw_payload JSON DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_note_basic_cache_source_url (source_url(255)),
        KEY idx_note_basic_cache_note_id (note_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  await noteBasicCacheTableReady;
  const ensureColumn = async (name, definition) => {
    const [[row]] = await db.execute(
      `
        SELECT COUNT(1) AS count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'note_basic_cache'
          AND COLUMN_NAME = ?
      `,
      [name],
    );
    if (Number(row.count) === 0) {
      await db.execute(`ALTER TABLE note_basic_cache ADD COLUMN ${name} ${definition}`);
    }
  };
  await ensureColumn('author_id', 'VARCHAR(64) DEFAULT NULL AFTER title');
};

// 从缓存中获取笔记基本信息
const ensureOrderSnapshotColumns = async (db) => {
  if (!orderSnapshotColumnsReady) {
    orderSnapshotColumnsReady = (async () => {
      const ensureColumn = async (name, definition) => {
        const [[row]] = await db.execute(
          `
            SELECT COUNT(1) AS count
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'orders'
              AND COLUMN_NAME = ?
          `,
          [name],
        );
        if (Number(row.count) === 0) {
          await db.execute(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
        }
      };
      await ensureColumn('title', 'VARCHAR(255) DEFAULT NULL AFTER note_url');
      await ensureColumn('author_name', 'VARCHAR(255) DEFAULT NULL AFTER title');
      await ensureColumn('avatar_url', 'VARCHAR(1024) DEFAULT NULL AFTER author_name');
    })();
  }
  return orderSnapshotColumnsReady;
};

const getCachedNoteBasic = async (db, sourceUrl) => {
  await ensureNoteBasicCacheTable(db);
  const [[row]] = await db.execute(
    `
      SELECT source_url, note_id, resolved_note_url, title, author_id, author_name, avatar_url
      FROM note_basic_cache
      WHERE source_url = ?
      LIMIT 1
    `,
    [sourceUrl],
  );

  if (!row) {
    return null;
  }

  return {
    author_id: row.author_id || '',
    author_name: row.author_name || '',
    avatar_url: row.avatar_url || '',
    cache_hit: true,
    note_id: row.note_id,
    note_url: row.resolved_note_url || row.source_url,
    title: row.title || '',
  };
};

// 保存笔记基本信息到缓存
const saveCachedNoteBasic = async (db, sourceUrl, noteBasic, rawPayload) => {
  await ensureNoteBasicCacheTable(db);
  await db.execute(
    `
      INSERT INTO note_basic_cache
        (source_url, note_id, resolved_note_url, title, author_id, author_name, avatar_url, raw_payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE
        note_id = VALUES(note_id),
        resolved_note_url = VALUES(resolved_note_url),
        title = VALUES(title),
        author_id = VALUES(author_id),
        author_name = VALUES(author_name),
        avatar_url = VALUES(avatar_url),
        raw_payload = VALUES(raw_payload)
    `,
    [
      sourceUrl,
      noteBasic.note_id,
      noteBasic.note_url,
      noteBasic.title || null,
      noteBasic.author_id || null,
      noteBasic.author_name || null,
      noteBasic.avatar_url || null,
      JSON.stringify(rawPayload || {}),
    ],
  );
};

const ensureProblemLinkRecordTable = async (db) => {
  if (!problemLinkRecordTableReady) {
    problemLinkRecordTableReady = (async () => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS batch_problem_link_records (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          check_batch_no VARCHAR(48) DEFAULT NULL,
          user_id BIGINT UNSIGNED NOT NULL,
          line_no INT UNSIGNED NOT NULL DEFAULT 0,
          raw_content VARCHAR(2048) NOT NULL,
          note_url VARCHAR(1024) DEFAULT NULL,
          resolved_note_url VARCHAR(1024) DEFAULT NULL,
          note_id VARCHAR(64) DEFAULT NULL,
          target_type VARCHAR(32) NOT NULL DEFAULT 'view',
          ordered_quantity BIGINT UNSIGNED NOT NULL DEFAULT 0,
          payable_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
          title VARCHAR(512) DEFAULT NULL,
          author_name VARCHAR(255) DEFAULT NULL,
          avatar_url VARCHAR(1024) DEFAULT NULL,
          errors JSON DEFAULT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_batch_problem_link_user_created_at (user_id, created_at),
          KEY idx_batch_problem_link_batch_no (check_batch_no),
          KEY idx_batch_problem_link_note_id (note_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      const ensureColumn = async (columnName, definition) => {
        const [columns] = await db.execute(
          `
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'batch_problem_link_records'
              AND COLUMN_NAME = ?
          `,
          [columnName],
        );
        if (columns.length === 0) {
          await db.execute(
            `ALTER TABLE batch_problem_link_records ADD COLUMN ${columnName} ${definition}`,
          );
        }
      };

      await ensureColumn('check_batch_no', 'VARCHAR(48) DEFAULT NULL');
      await ensureColumn('resolved_note_url', 'VARCHAR(1024) DEFAULT NULL');
      await ensureColumn('ordered_quantity', 'BIGINT UNSIGNED NOT NULL DEFAULT 0');
      await ensureColumn('payable_amount', 'DECIMAL(18,4) NOT NULL DEFAULT 0');
      await ensureColumn('title', 'VARCHAR(512) DEFAULT NULL');
      await ensureColumn('author_name', 'VARCHAR(255) DEFAULT NULL');
      await ensureColumn('avatar_url', 'VARCHAR(1024) DEFAULT NULL');
    })();
  }

  await problemLinkRecordTableReady;
};

const ensureBatchLinkCheckRecordTable = async (db) => {
  if (!batchLinkCheckRecordTableReady) {
    batchLinkCheckRecordTableReady = db.execute(`
      CREATE TABLE IF NOT EXISTS batch_link_check_records (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        check_batch_no VARCHAR(48) NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        line_no INT UNSIGNED NOT NULL DEFAULT 0,
        raw_content VARCHAR(2048) NOT NULL,
        note_url VARCHAR(1024) DEFAULT NULL,
        resolved_note_url VARCHAR(1024) DEFAULT NULL,
        note_id VARCHAR(64) DEFAULT NULL,
        target_type VARCHAR(32) NOT NULL DEFAULT 'view',
        ordered_quantity INT UNSIGNED NOT NULL DEFAULT 0,
        payable_amount DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
        valid TINYINT(1) NOT NULL DEFAULT 0,
        title VARCHAR(255) DEFAULT NULL,
        author_name VARCHAR(128) DEFAULT NULL,
        avatar_url VARCHAR(1024) DEFAULT NULL,
        errors JSON DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_batch_link_check_batch_no (check_batch_no),
        KEY idx_batch_link_check_user_created_at (user_id, created_at),
        KEY idx_batch_link_check_valid (valid),
        KEY idx_batch_link_check_note_id (note_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  await batchLinkCheckRecordTableReady;
};

const createCheckBatchNo = () =>
  `CHECK-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

const saveBatchLinkCheckRecords = async (db, userId, checkBatchNo, targetType, items) => {
  await ensureBatchLinkCheckRecordTable(db);
  if (!items.length) {
    return;
  }

  const now = new Date();
  await Promise.all(
    items.map((item) =>
      db.execute(
        `
          INSERT INTO batch_link_check_records
            (
              check_batch_no, user_id, line_no, raw_content, note_url, resolved_note_url,
              note_id, target_type, ordered_quantity, payable_amount, valid, title,
              author_name, avatar_url, errors, created_at
            )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?)
        `,
        [
          checkBatchNo,
          userId,
          item.line_no,
          item.raw,
          item.note_url || null,
          item.resolved_note_url || null,
          item.note_id || null,
          targetType,
          item.ordered_quantity || 0,
          item.payable_amount || 0,
          item.valid ? 1 : 0,
          item.title || null,
          item.author_name || null,
          item.avatar_url || null,
          JSON.stringify(item.errors || []),
          now,
        ],
      ),
    ),
  );
};

const serializeBatchLinkCheckRecord = (row) => ({
  author_name: row.author_name || row.cache_author_name || '',
  avatar_url: row.avatar_url || row.cache_avatar_url || '',
  check_batch_no: row.check_batch_no,
  created_at: row.created_at,
  errors: typeof row.errors === 'string' ? JSON.parse(row.errors || '[]') : row.errors || [],
  id: Number(row.id),
  line_no: Number(row.line_no) || 0,
  note_id: row.note_id || '',
  note_url: row.note_url || '',
  ordered_quantity: Number(row.ordered_quantity) || 0,
  payable_amount: round4(row.payable_amount),
  raw: row.raw_content || '',
  resolved_note_url: row.resolved_note_url || '',
  target_type: normalizeTargetType(row.target_type),
  title: row.title || row.cache_title || '',
  valid: Boolean(row.valid),
});

const listBatchLinkCheckRecords = async (userId, { limit = 100 } = {}) => {
  const db = getPool();
  await ensureBatchLinkCheckRecordTable(db);

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const [rows] = await db.execute(
    `
      SELECT *
      FROM batch_link_check_records
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ${safeLimit}
    `,
    [userId],
  );

  return rows.map(serializeBatchLinkCheckRecord);
};

const serializeBatchOrderRecord = (row, orders = []) => ({
  batch_id: row.batch_id,
  batch_no: row.batch_no,
  created_at: row.created_at,
  estimated_amount: round4(row.estimated_amount),
  failed_count: Number(row.failed_count) || 0,
  finished_at: row.finished_at,
  id: Number(row.id),
  orders,
  processing_count: Number(row.processing_count) || 0,
  raw_content: row.raw_content || '',
  retryable_count: Number(row.retryable_count) || 0,
  status: row.status || 'pending',
  submitted_at: row.submitted_at,
  succeeded_count: Number(row.succeeded_count) || 0,
  target_count: Number(row.total_count) || 0,
  total_count: Number(row.total_count) || 0,
});

const serializeBatchOrderItem = (row) => ({
  actual_paid_amount: round4(row.actual_paid_amount),
  author_name: row.author_name || '',
  avatar_url: row.avatar_url || '',
  batch_item_id: Number(row.batch_item_id) || 0,
  completed_quantity: Number(row.completed_quantity) || 0,
  created_at: row.created_at,
  external_status: row.external_status || '',
  external_task_id: row.external_task_id || '',
  id: Number(row.id),
  note_id: row.note_id || '',
  note_url: row.note_url || '',
  order_no: row.order_no,
  order_status: row.order_status || 'running',
  ordered_quantity: Number(row.ordered_quantity) || 0,
  payable_amount: round4(row.payable_amount),
  reason_message: row.reason_message || '',
  refund_amount: round4(row.refund_amount),
  record_status: row.record_status || '',
  source_note_url: row.source_note_url || row.note_url || '',
  target_type: normalizeTargetType(row.target_type),
  title: row.title || '',
  updated_at: row.updated_at,
});

const buildRawUrlMap = (rawContent) => {
  const map = new Map();
  String(rawContent || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      const [noteUrl = ''] = line.split(/\s+/);
      map.set(index + 1, noteUrl);
    });
  return map;
};

const syncRunningOrdersFromXhs = async (db, userId, batchIds = []) => {
  const batchFilter = batchIds.length > 0
    ? `AND batch_id IN (${batchIds.map(() => '?').join(',')})`
    : '';
  const [orders] = await db.execute(
    `
      SELECT id, batch_id, external_status, external_task_id, last_verified_at,
        ordered_quantity, target_type
      FROM orders
      WHERE user_id = ?
        ${batchFilter}
        AND order_status = 'running'
        AND external_task_id IS NOT NULL
        AND external_task_id <> ''
        AND reason_message IS NULL
        AND EXISTS (
          SELECT 1
          FROM account_records ar
          WHERE ar.order_id = orders.id
            AND ar.record_type = 'order_charge'
            AND ar.status = 'success'
        )
    `,
    [userId, ...batchIds],
  );

  if (orders.length === 0) {
    return;
  }

  const now = new Date();
  const affectedBatchIds = new Set();

  for (const order of orders) {
    let statusResult = null;
    try {
      statusResult = await getXhsTaskClient().getTaskStatus(
        normalizeTargetType(order.target_type),
        String(order.external_task_id),
        {
          token: createCurrentUserToken(userId),
        },
      );
    } catch {
      continue;
    }

    const taskStatus = getXhsTaskStatus(statusResult?.body);
    if (![1, 2].includes(taskStatus)) {
      continue;
    }
    const totalCount = Math.max(getXhsTaskCount(statusResult?.body, 'total_count'), 0);
    const currentCount = Math.max(getXhsTaskCount(statusResult?.body, 'current_count'), 0);
    const fallbackTotal = Math.max(Number(order.ordered_quantity) || 0, 1);
    const progressTotal = totalCount > 0 ? totalCount : fallbackTotal;
    const completedQuantity =
      taskStatus === 2
        ? Number(order.ordered_quantity) || currentCount
        : Math.min(currentCount, Number(order.ordered_quantity) || currentCount);
    const progress =
      taskStatus === 2
        ? 1
        : Math.max(0, Math.min(round4(currentCount / progressTotal), 1));
    const verifiedAt = order.last_verified_at ? new Date(order.last_verified_at) : null;
    const canFinalize =
      taskStatus === 2 &&
      order.external_status === 'completed' &&
      verifiedAt &&
      now.getTime() - verifiedAt.getTime() >= 5 * 60 * 1000;
    const nextOrderStatus = canFinalize ? 'completed' : 'running';
    const nextExternalStatus = taskStatus === 2 ? 'completed' : 'running';
    const nextVerifiedAt =
      taskStatus === 2 && !verifiedAt
        ? now
        : verifiedAt || now;

    await db.execute(
      `
        UPDATE orders
        SET order_status = ?,
            completed_quantity = ?,
            external_status = ?,
            external_progress = ?,
            external_completed_quantity = ?,
            last_verified_at = ?,
            updated_at = ?
        WHERE id = ?
          AND user_id = ?
          AND order_status = 'running'
      `,
      [
        nextOrderStatus,
        completedQuantity,
        nextExternalStatus,
        progress,
        completedQuantity,
        nextVerifiedAt,
        now,
        order.id,
        userId,
      ],
    );
    affectedBatchIds.add(order.batch_id);
  }

  if (affectedBatchIds.size === 0) {
    return;
  }

  const refreshedBatchIds = [...affectedBatchIds];
  const placeholders = refreshedBatchIds.map(() => '?').join(',');

  const [statsRows] = await db.execute(
    `
      SELECT
        batch_id,
        COUNT(1) AS total_count,
        COALESCE(SUM(CASE WHEN order_status = 'running' THEN 1 ELSE 0 END), 0) AS processing_count,
        COALESCE(SUM(CASE WHEN order_status = 'completed' THEN 1 ELSE 0 END), 0) AS succeeded_count,
        COALESCE(SUM(CASE WHEN order_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
        COALESCE(SUM(CASE WHEN order_status IN ('failed', 'manual_review', 'repair_review') THEN 1 ELSE 0 END), 0) AS retryable_count
      FROM orders
      WHERE batch_id IN (${placeholders})
        AND user_id = ?
      GROUP BY batch_id
    `,
    [...refreshedBatchIds, userId],
  );

  for (const stats of statsRows) {
    const totalCount = Number(stats.total_count) || 0;
    const processingCount = Number(stats.processing_count) || 0;
    const succeededCount = Number(stats.succeeded_count) || 0;
    const failedCount = Number(stats.failed_count) || 0;
    const retryableCount = Number(stats.retryable_count) || 0;
    const nextStatus =
      totalCount > 0 && succeededCount === totalCount
        ? 'completed'
        : failedCount > 0 && processingCount === 0
          ? 'failed'
          : 'processing';

    await db.execute(
      `
        UPDATE order_batches
        SET status = ?,
            processing_count = ?,
            succeeded_count = ?,
            failed_count = ?,
            retryable_count = ?,
            finished_at = CASE WHEN ? IN ('completed', 'failed') THEN COALESCE(finished_at, ?) ELSE finished_at END,
            updated_at = ?
        WHERE id = ?
          AND user_id = ?
      `,
      [
        nextStatus,
        processingCount,
        succeededCount,
        failedCount,
        retryableCount,
        nextStatus,
        now,
        now,
        stats.batch_id,
        userId,
      ],
    );
  }
};

const listBatchOrderRecords = async (userId, query = {}) => {
  const { limit = 30, page, page_size: pageSize } = query;
  const db = getPool();
  await ensureOrderSnapshotColumns(db);
  await refundFailedChargedOrders(db, userId);
  const skipStatusSync =
    query.skip_status_sync === '1' ||
    query.skip_status_sync === 1 ||
    query.skip_status_sync === true ||
    query.skip_status_sync === 'true';
  const paginationRequested = page !== undefined || pageSize !== undefined;
  const safePage = Math.max(Number(page) || 1, 1);
  const safeLimit = Math.min(Math.max(Number(pageSize || limit) || 10, 1), 100);
  const offset = (safePage - 1) * safeLimit;
  const [[countRow]] = await db.execute(
    `
      SELECT COUNT(*) AS total
      FROM order_batches
      WHERE user_id = ?
    `,
    [userId],
  );
  let [batches] = await db.execute(
    `
      SELECT *
      FROM order_batches
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    [userId],
  );

  if (batches.length === 0) {
    if (!paginationRequested) {
      return [];
    }
    return {
      items: [],
      page: safePage,
      page_size: safeLimit,
      total: Number(countRow.total) || 0,
    };
  }

  const batchIds = batches.map((batch) => batch.id);
  if (!skipStatusSync) {
    await syncRunningOrdersFromXhs(db, userId, batchIds);
  }
  await refreshBatchStats(db, userId, batchIds);
  [batches] = await db.execute(
    `
      SELECT *
      FROM order_batches
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    [userId],
  );
  const placeholders = batchIds.map(() => '?').join(',');
  const [orders] = await db.execute(
    `
      SELECT *
      FROM (
        SELECT
          o.*,
          ar.actual_paid_amount,
          ar.payable_amount,
          ar.refund_amount,
          ar.status AS record_status,
          nbc.title AS cache_title,
          nbc.author_name AS cache_author_name,
          nbc.avatar_url AS cache_avatar_url
        FROM orders o
        LEFT JOIN account_records ar ON ar.order_id = o.id AND ar.record_type = 'order_charge'
        LEFT JOIN note_basic_cache nbc ON nbc.note_id = o.note_id
        WHERE o.batch_id IN (${placeholders})
      ) order_rows
      ORDER BY batch_id DESC, batch_item_id ASC, id ASC
    `,
    batchIds,
  );
  const rawUrlMaps = new Map(
    batches.map((batch) => [batch.id, buildRawUrlMap(batch.raw_content)]),
  );
  const orderMap = new Map();
  for (const order of orders) {
    const group = orderMap.get(order.batch_id) ?? [];
    const rawUrlMap = rawUrlMaps.get(order.batch_id);
    order.source_note_url = rawUrlMap?.get(Number(order.batch_item_id)) || order.note_url;
    group.push(serializeBatchOrderItem(order));
    orderMap.set(order.batch_id, group);
  }

  const items = batches.map((batch) => serializeBatchOrderRecord(batch, orderMap.get(batch.id) ?? []));

  if (!paginationRequested) {
    return items;
  }

  return {
    items,
    page: safePage,
    page_size: safeLimit,
    total: Number(countRow.total) || 0,
  };
};

const serializeConsumptionRecord = (row) => ({
  actual_paid_amount: round4(row.actual_paid_amount),
  after_available_amount: round4(row.after_available_amount),
  before_available_amount: round4(row.before_available_amount),
  completed_quantity: Number(row.completed_quantity) || 0,
  created_at: row.created_at,
  discount_amount: round4(row.discount_amount),
  discount_rate: round4(row.discount_rate),
  discounted_unit_price: round4(row.discounted_unit_price),
  direction: row.direction || '',
  display_name: row.display_name || row.username || '',
  id: Number(row.id),
  net_amount: round4(row.net_amount),
  order_id: Number(row.order_id) || 0,
  order_items: Array.isArray(row.order_items) ? row.order_items : [],
  order_no: row.order_no || '',
  order_status: row.order_status || '',
  ordered_quantity: Number(row.ordered_quantity) || 0,
  original_total_amount: round4(row.original_total_amount),
  original_unit_price: round4(row.original_unit_price),
  payable_amount: round4(row.payable_amount),
  reason_code: row.reason_code || '',
  reason_message: row.reason_message || '',
  record_no: row.record_no || '',
  record_type: row.record_type || '',
  refund_amount: round4(row.refund_amount),
  refund_requested_at: row.refund_requested_at || null,
  refunded_quantity: Number(row.refunded_quantity) || 0,
  remark: row.remark || '',
  status: row.status || '',
  user_id: Number(row.user_id),
  username: row.username || '',
});

const listConsumptionRecords = async (userId, query = {}) => {
  const db = getPool();
  const safePage = Math.max(Number(query.page) || 1, 1);
  const safeLimit = Math.min(Math.max(Number(query.page_size) || 10, 1), 100);
  const offset = (safePage - 1) * safeLimit;
  const keyword = String(query.keyword || '').trim();
  const recordType = String(query.record_type || '').trim();
  const direction = String(query.direction || '').trim();
  const status = String(query.status || '').trim();
  const viewAll = await canViewAllAccountRecords(db, userId);

  const where = [];
  const params = [];
  if (!viewAll) {
    where.push('ar.user_id = ?');
    params.push(userId);
  }
  if (recordType) {
    where.push('ar.record_type = ?');
    params.push(recordType);
  }
  if (direction) {
    where.push('ar.direction = ?');
    params.push(direction);
  }
  if (status) {
    where.push('ar.status = ?');
    params.push(status);
  }
  if (keyword) {
    where.push(`
      (
        ar.record_no LIKE ?
        OR ar.order_no LIKE ?
        OR ob.batch_no LIKE ?
        OR ar.reason_message LIKE ?
        OR ar.remark LIKE ?
        OR u.username LIKE ?
        OR u.real_name LIKE ?
        OR u.nickname LIKE ?
      )
    `);
    const keywordLike = `%${keyword}%`;
    params.push(
      keywordLike,
      keywordLike,
      keywordLike,
      keywordLike,
      keywordLike,
      keywordLike,
      keywordLike,
      keywordLike,
    );
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const fromSql = `
    FROM account_records ar
    LEFT JOIN orders o ON o.id = ar.order_id
    LEFT JOIN order_batches ob ON ob.id = o.batch_id
    LEFT JOIN users u ON u.id = ar.user_id
    ${whereSql}
  `;

  const [[summaryRow]] = await db.execute(
    `
      SELECT
        COALESCE(SUM(CASE WHEN ar.direction = 'debit' THEN ar.actual_paid_amount ELSE 0 END), 0) AS expense_amount,
        COALESCE(SUM(CASE WHEN ar.direction = 'credit' THEN ar.actual_paid_amount ELSE 0 END), 0) AS income_amount,
        COALESCE(SUM(ar.refund_amount), 0) AS refund_amount,
        COALESCE(SUM(ar.net_amount), 0) AS net_amount
      ${fromSql}
    `,
    params,
  );

  const [rows] = await db.execute(
    `
      SELECT
        ar.*,
        ob.batch_no,
        o.batch_id,
        o.id AS order_id,
        o.order_status,
        o.refund_requested_at,
        o.refund_amount_total,
        o.refunded_quantity AS order_refunded_quantity,
        u.username,
        COALESCE(NULLIF(u.real_name, ''), NULLIF(u.nickname, ''), u.username) AS display_name
      ${fromSql}
      ORDER BY ar.id DESC
    `,
    params,
  );
  const groupedRows = [];
  const batchChargeGroups = new Map();
  for (const row of rows) {
    if (row.record_type !== 'order_charge' || !row.batch_id) {
      groupedRows.push(row);
      continue;
    }

    const key = `order-charge-${row.batch_id}`;
    const group = batchChargeGroups.get(key);
    if (!group) {
      const nextGroup = {
        ...row,
        _rows: [row],
      };
      batchChargeGroups.set(key, nextGroup);
      groupedRows.push(nextGroup);
      continue;
    }

    group._rows.push(row);
    group.id = Math.max(Number(group.id) || 0, Number(row.id) || 0);
    group.created_at =
      new Date(row.created_at).getTime() > new Date(group.created_at).getTime()
        ? row.created_at
        : group.created_at;
  }

  const items = groupedRows
    .map((row) => {
      if (!row._rows) {
        return row;
      }

      const sortedRows = [...row._rows].sort((a, b) => Number(a.id) - Number(b.id));
      const firstRow = sortedRows[0];
      const lastRow = sortedRows.at(-1);
      return {
        ...lastRow,
        actual_paid_amount: sortedRows.reduce(
          (total, item) => total + (Number(item.actual_paid_amount) || 0),
          0,
        ),
        after_available_amount: lastRow.after_available_amount,
        before_available_amount: firstRow.before_available_amount,
        completed_quantity: sortedRows.reduce(
          (total, item) => total + (Number(item.completed_quantity) || 0),
          0,
        ),
        created_at: lastRow.created_at,
        discount_amount: sortedRows.reduce(
          (total, item) => total + (Number(item.discount_amount) || 0),
          0,
        ),
        id: Number(row.id),
        net_amount: sortedRows.reduce((total, item) => total + (Number(item.net_amount) || 0), 0),
        order_id: 0,
        order_items: sortedRows.map((item) => ({
          actual_paid_amount: round4(item.actual_paid_amount),
          order_id: Number(item.order_id),
          order_no: item.order_no,
          order_status: item.order_status || 'running',
          ordered_quantity: Number(item.ordered_quantity) || 0,
          refund_amount: round4(item.refund_amount_total ?? item.refund_amount),
          refund_requested_at: item.refund_requested_at || null,
          refunded_quantity: Number(item.order_refunded_quantity ?? item.refunded_quantity) || 0,
        })),
        order_no: row.batch_no || lastRow.order_no,
        order_status: sortedRows.some((item) =>
          ['refund_requested', 'refund_calculating'].includes(item.order_status),
        )
          ? 'refund_requested'
          : lastRow.order_status,
        ordered_quantity: sortedRows.reduce(
          (total, item) => total + (Number(item.ordered_quantity) || 0),
          0,
        ),
        original_total_amount: sortedRows.reduce(
          (total, item) => total + (Number(item.original_total_amount) || 0),
          0,
        ),
        payable_amount: sortedRows.reduce(
          (total, item) => total + (Number(item.payable_amount) || 0),
          0,
        ),
        reason_message: `批量下单扣费（${sortedRows.length}条）`,
        record_no: row.batch_no || lastRow.record_no,
        refund_amount: sortedRows.reduce(
          (total, item) => total + (Number(item.refund_amount) || 0),
          0,
        ),
        refunded_quantity: sortedRows.reduce(
          (total, item) => total + (Number(item.refunded_quantity) || 0),
          0,
        ),
      };
    })
    .sort((a, b) => Number(b.id) - Number(a.id));

  const pagedItems = items.slice(offset, offset + safeLimit);

  return {
    items: pagedItems.map(serializeConsumptionRecord),
    page: safePage,
    page_size: safeLimit,
    summary: {
      expense_amount: round4(summaryRow.expense_amount),
      income_amount: round4(summaryRow.income_amount),
      net_amount: round4(summaryRow.net_amount),
      refund_amount: round4(summaryRow.refund_amount),
    },
    total: items.length,
  };
};

const requestOrderRefund = async (userId, orderId) => {
  const db = getPool();
  const targetOrderId = Number(orderId);
  if (!targetOrderId) {
    const error = new Error('Invalid order id');
    error.statusCode = 400;
    throw error;
  }

  const viewAll = await canViewAllAccountRecords(db, userId);
  const [[order]] = await db.execute(
    `
      SELECT id, user_id, order_no, order_status, external_task_id, target_type
      FROM orders
      WHERE id = ?
      LIMIT 1
    `,
    [targetOrderId],
  );

  if (!order || (!viewAll && Number(order.user_id) !== Number(userId))) {
    const error = new Error('Order not found');
    error.statusCode = 404;
    throw error;
  }

  if (['refund_requested', 'refund_calculating'].includes(order.order_status)) {
    return {
      order_id: targetOrderId,
      order_no: order.order_no,
      order_status: order.order_status,
    };
  }

  if (order.order_status === 'failed') {
    const error = new Error('Current order status cannot request refund');
    error.statusCode = 400;
    throw error;
  }

  if (order.external_task_id) {
    await getXhsTaskClient().updateTaskStatus(
      normalizeTargetType(order.target_type),
      {
        id: Number(order.external_task_id) || order.external_task_id,
        reason: `goods_order=${order.order_no} refund requested`,
        status: 3,
      },
      { token: createCurrentUserToken(userId) },
    );
  }

  const now = new Date();
  await db.execute(
    `
      UPDATE orders
      SET order_status = 'refund_requested',
          refund_requested_at = ?,
          stop_requested_at = ?,
          refund_calc_after_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    [now, now, new Date(now.getTime() + 24 * 60 * 60 * 1000), now, targetOrderId],
  );

  return {
    order_id: targetOrderId,
    order_no: order.order_no,
    order_status: 'refund_requested',
  };
};

const reviewOrderRefund = async (actorUserId, orderId, { approved, reason = '' } = {}) => {
  const db = getPool();
  const isAdmin = await canViewAllAccountRecords(db, actorUserId);
  if (!isAdmin) {
    const error = new Error('Forbidden');
    error.statusCode = 403;
    throw error;
  }

  const targetOrderId = Number(orderId);
  if (!targetOrderId) {
    const error = new Error('Invalid order id');
    error.statusCode = 400;
    throw error;
  }

  const connection = await db.getConnection();
  const now = new Date();
  try {
    await connection.beginTransaction();

    const [[order]] = await connection.execute(
      `
        SELECT *
        FROM orders
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [targetOrderId],
    );

    if (!order) {
      const error = new Error('Order not found');
      error.statusCode = 404;
      throw error;
    }

    if (!['refund_requested', 'refund_calculating', 'stopping'].includes(order.order_status)) {
      const error = new Error('Order is not waiting for refund review');
      error.statusCode = 400;
      throw error;
    }

    if (!approved) {
      await connection.execute(
        `
          UPDATE orders
          SET order_status = 'refund_rejected',
              reason_message = ?,
              updated_at = ?
          WHERE id = ?
        `,
        [reason || '退款审核拒绝', now, targetOrderId],
      );
      await connection.commit();
      return {
        order_id: targetOrderId,
        order_no: order.order_no,
        order_status: 'refund_rejected',
        refunded_amount: 0,
      };
    }

    const [[chargeRecord]] = await connection.execute(
      `
        SELECT *
        FROM account_records
        WHERE order_id = ? AND record_type = 'order_charge' AND status = 'success'
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
      `,
      [targetOrderId],
    );

    if (!chargeRecord) {
      const error = new Error('Charge record not found');
      error.statusCode = 404;
      throw error;
    }

    const paidAmount = Number(chargeRecord.actual_paid_amount) || 0;
    const refundedAmount = Number(order.refund_amount_total) || 0;
    const orderedQuantity = Math.max(Number(order.ordered_quantity) || 0, 0);
    let completedQuantity = Math.max(
      Number(order.external_completed_quantity) || 0,
      Number(order.completed_quantity) || 0,
    );

    if (order.external_task_id) {
      try {
        const statusResult = await getXhsTaskClient().getTaskStatus(
          normalizeTargetType(order.target_type),
          String(order.external_task_id),
          {
            token: createCurrentUserToken(order.user_id),
          },
        );
        const taskStatus = getXhsTaskStatus(statusResult?.body);
        const upstreamCurrentCount = getXhsTaskCount(statusResult?.body, 'current_count');
        if (taskStatus === 2) {
          completedQuantity = orderedQuantity;
        } else if (taskStatus === 1) {
          completedQuantity = Math.max(completedQuantity, upstreamCurrentCount);
        }
      } catch {
        // Keep locally synced progress if the upstream check is unavailable during review.
      }
    }

    completedQuantity = Math.min(Math.max(completedQuantity, 0), orderedQuantity);
    const refundableQuantity = Math.max(orderedQuantity - completedQuantity, 0);
    const grossRefundAmount =
      orderedQuantity > 0 ? round4((paidAmount * refundableQuantity) / orderedQuantity) : 0;
    const refundAmount = round4(Math.max(grossRefundAmount - refundedAmount, 0));
    if (refundAmount <= 0) {
      const error = new Error('No refundable amount');
      error.statusCode = 400;
      throw error;
    }

    const [[balance]] = await connection.execute(
      `
        SELECT available_amount
        FROM balance_accounts
        WHERE user_id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [order.user_id],
    );
    const beforeBalance = round4(balance?.available_amount);
    const afterBalance = round4(beforeBalance + refundAmount);
    const recordNo = `REFUND-${Date.now()}-${String(targetOrderId).padStart(3, '0')}`;

    await connection.execute(
      `
        INSERT INTO account_records
          (
            record_no, user_id, record_type, direction, order_id, order_no,
            related_record_id, status, ordered_quantity, completed_quantity, refunded_quantity,
            original_unit_price, original_total_amount, discount_rate, discounted_unit_price,
            discount_amount, payable_amount, actual_paid_amount, refund_amount, net_amount,
            before_available_amount, after_available_amount, reason_message, remark,
            created_at, updated_at
          )
        VALUES (?, ?, 'refund', 'credit', ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        recordNo,
        order.user_id,
        order.id,
        order.order_no,
        chargeRecord.id,
        order.ordered_quantity,
        completedQuantity,
        refundableQuantity,
        chargeRecord.discounted_unit_price,
        refundAmount,
        chargeRecord.discount_rate,
        chargeRecord.discounted_unit_price,
        0,
        refundAmount,
        refundAmount,
        refundAmount,
        beforeBalance,
        afterBalance,
        '退款审核通过',
        reason || '',
        now,
        now,
      ],
    );

    await connection.execute(
      `
        UPDATE orders
        SET order_status = 'refund_approved',
            completed_quantity = ${completedQuantity},
            external_completed_quantity = ${completedQuantity},
            external_progress = CASE WHEN ordered_quantity > 0 THEN ${completedQuantity} / ordered_quantity ELSE external_progress END,
            refunded_quantity = refunded_quantity + ${refundableQuantity},
            refund_amount_total = refund_amount_total + ?,
            reason_message = ?,
            updated_at = ?
        WHERE id = ?
      `,
      [refundAmount, reason || '退款审核通过', now, targetOrderId],
    );
    await connection.execute(
      'UPDATE balance_accounts SET available_amount = ?, updated_at = ? WHERE user_id = ?',
      [afterBalance, now, order.user_id],
    );

    await connection.commit();
    return {
      order_id: targetOrderId,
      order_no: order.order_no,
      order_status: 'refund_approved',
      refunded_amount: refundAmount,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const serializeRefundRecord = (row) => ({
  actual_paid_amount: round4(row.actual_paid_amount),
  author_name: row.author_name || '',
  avatar_url: row.avatar_url || '',
  batch_no: row.batch_no || '',
  created_at: row.created_at,
  display_name: row.display_name || row.username || '',
  id: Number(row.id),
  note_id: row.note_id || '',
  note_url: row.note_url || '',
  order_id: Number(row.id),
  order_no: row.order_no || '',
  order_status: row.order_status || '',
  ordered_quantity: Number(row.ordered_quantity) || 0,
  reason_message: row.reason_message || '',
  after_available_amount:
    row.refund_after_available_amount === null || row.refund_after_available_amount === undefined
      ? null
      : round4(row.refund_after_available_amount),
  refund_amount_total: round4(row.refund_amount_total),
  refund_calc_after_at: row.refund_calc_after_at || null,
  refund_requested_at: row.refund_requested_at || null,
  refunded_quantity: Number(row.refunded_quantity) || 0,
  target_type: normalizeTargetType(row.target_type),
  title: row.title || '',
  updated_at: row.updated_at,
  user_id: Number(row.user_id),
  username: row.username || '',
});

const listRefundRecords = async (userId, query = {}) => {
  const db = getPool();
  const safePage = Math.max(Number(query.page) || 1, 1);
  const safeLimit = Math.min(Math.max(Number(query.page_size) || 10, 1), 100);
  const offset = (safePage - 1) * safeLimit;
  const keyword = String(query.keyword || '').trim();
  const status = String(query.status || '').trim();
  const viewAll = await canViewAllAccountRecords(db, userId);
  const where = [
    `(
      o.order_status IN ('refund_requested', 'refund_calculating', 'stopping', 'refund_approved', 'refund_rejected')
      OR o.refund_requested_at IS NOT NULL
      OR o.refunded_quantity > 0
      OR o.refund_amount_total > 0
    )`,
  ];
  const params = [];

  if (!viewAll) {
    where.push('o.user_id = ?');
    params.push(userId);
  }
  if (status) {
    where.push('o.order_status = ?');
    params.push(status);
  }
  if (keyword) {
    where.push(`
      (
        o.order_no LIKE ?
        OR ob.batch_no LIKE ?
        OR o.note_id LIKE ?
        OR o.note_url LIKE ?
        OR nbc.title LIKE ?
        OR nbc.author_name LIKE ?
        OR u.username LIKE ?
        OR u.real_name LIKE ?
        OR u.nickname LIKE ?
      )
    `);
    const keywordLike = `%${keyword}%`;
    params.push(
      keywordLike,
      keywordLike,
      keywordLike,
      keywordLike,
      keywordLike,
      keywordLike,
      keywordLike,
      keywordLike,
      keywordLike,
    );
  }

  const fromSql = `
    FROM orders o
    LEFT JOIN order_batches ob ON ob.id = o.batch_id
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN note_basic_cache nbc ON nbc.note_id = o.note_id
    LEFT JOIN account_records ar ON ar.order_id = o.id AND ar.record_type = 'order_charge'
    LEFT JOIN (
      SELECT order_id, MAX(id) AS refund_record_id
      FROM account_records
      WHERE record_type = 'refund'
      GROUP BY order_id
    ) latest_refund ON latest_refund.order_id = o.id
    LEFT JOIN account_records rr ON rr.id = latest_refund.refund_record_id
    WHERE ${where.join(' AND ')}
  `;

  const [[countRow]] = await db.execute(`SELECT COUNT(1) AS total ${fromSql}`, params);
  const [rows] = await db.execute(
    `
      SELECT
        o.*,
        ob.batch_no,
        u.username,
        COALESCE(NULLIF(u.real_name, ''), NULLIF(u.nickname, ''), u.username) AS display_name,
        nbc.title,
        nbc.author_name,
        nbc.avatar_url,
        ar.actual_paid_amount,
        rr.after_available_amount AS refund_after_available_amount
      ${fromSql}
      ORDER BY COALESCE(o.refund_requested_at, o.updated_at, o.created_at) DESC, o.id DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    params,
  );

  return {
    items: rows.map(serializeRefundRecord),
    page: safePage,
    page_size: safeLimit,
    total: Number(countRow.total) || 0,
  };
};

const serializeProblemLinkRecord = (row) => ({
  author_name: row.author_name || '',
  avatar_url: row.avatar_url || '',
  check_batch_no:
    row.check_batch_no ||
    `PROBLEM-${new Date(row.created_at || Date.now()).getTime()}`,
  created_at: row.created_at,
  errors: typeof row.errors === 'string' ? JSON.parse(row.errors || '[]') : row.errors || [],
  id: Number(row.id),
  line_no: Number(row.line_no) || 0,
  note_id: row.note_id || '',
  note_url: row.note_url || '',
  ordered_quantity: Number(row.ordered_quantity) || 0,
  payable_amount: round4(row.payable_amount),
  raw: row.raw_content || '',
  resolved_note_url: row.resolved_note_url || '',
  target_type: normalizeTargetType(row.target_type),
  title: row.title || '',
  valid: false,
});

const saveProblemLinkRecords = async (
  userId,
  { check_batch_no: checkBatchNoValue, records = [], target_type: targetTypeValue } = {},
) => {
  const db = getPool();
  await ensureProblemLinkRecordTable(db);

  const targetType = normalizeTargetType(targetTypeValue);
  const checkBatchNo = String(checkBatchNoValue || '').trim() || createCheckBatchNo();
  const safeRecords = records
    .map((record) => ({
      author_name: String(record.author_name || '').trim(),
      avatar_url: String(record.avatar_url || '').trim(),
      errors: Array.isArray(record.errors) ? record.errors.map(String).filter(Boolean) : [],
      line_no: Number(record.line_no) || 0,
      note_id: String(record.note_id || '').trim(),
      note_url: String(record.note_url || '').trim(),
      ordered_quantity: Number(record.ordered_quantity) || 0,
      payable_amount: Number(record.payable_amount) || 0,
      raw: String(record.raw || record.raw_content || '').trim(),
      resolved_note_url: String(record.resolved_note_url || '').trim(),
      title: String(record.title || '').trim(),
    }))
    .filter((record) => record.raw);

  if (safeRecords.length === 0) {
    return {
      saved_count: 0,
    };
  }

  const now = new Date();
  await Promise.all(
    safeRecords.map((record) =>
      db.execute(
        `
          INSERT INTO batch_problem_link_records
            (
              check_batch_no, user_id, line_no, raw_content, note_url, resolved_note_url,
              note_id, target_type, ordered_quantity, payable_amount, title, author_name,
              avatar_url, errors, created_at
            )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?)
        `,
        [
          checkBatchNo,
          userId,
          record.line_no,
          record.raw,
          record.note_url || null,
          record.resolved_note_url || null,
          record.note_id || null,
          targetType,
          record.ordered_quantity,
          record.payable_amount,
          record.title || null,
          record.author_name || null,
          record.avatar_url || null,
          JSON.stringify(record.errors),
          now,
        ],
      ),
    ),
  );

  return {
    check_batch_no: checkBatchNo,
    saved_count: safeRecords.length,
  };
};

const listProblemLinkRecords = async (userId, { limit = 100 } = {}) => {
  const db = getPool();
  await ensureProblemLinkRecordTable(db);

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const [rows] = await db.execute(
    `
      SELECT *
      FROM batch_problem_link_records
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ${safeLimit}
    `,
    [userId],
  );

  return rows.map(serializeProblemLinkRecord);
};

// 请求笔记基本信息
const requestNoteBasic = async (params) => {
  const apiUrl = new URL(NOTE_BASIC_API);
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      apiUrl.searchParams.set(key, value);
    }
  }

  const response = await fetch(apiUrl, {
    headers: {
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    return null;
  }

  return {
    noteBasic: normalizeNoteBasicResponse(
      payload,
      params.note_id || '',
      params.url || params.link || params.note_url || params.share_url || '',
    ),
    payload,
  };
};

const normalizeNoteIdResponse = (payload) => {
  const data = payload?.data ?? payload?.result ?? payload;
  if (!data || (payload?.code !== undefined && payload.code !== 0)) {
    return null;
  }

  const noteId = findFirstStringByKey(data, /^note_?id$|^id$/i);
  if (!/^[a-zA-Z0-9]{24}$/.test(noteId)) {
    return null;
  }

  return {
    note_id: noteId,
    note_url: findFirstStringByKey(data, /^url$|note_?url|share_?url/i) || '',
  };
};

const requestNoteId = async (sourceUrl) => {
  const apiUrl = new URL(NOTE_ID_API);
  apiUrl.searchParams.set('url', sourceUrl);

  const response = await fetch(apiUrl, {
    headers: {
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    return null;
  }

  return normalizeNoteIdResponse(await response.json());
};

const fetchNoteBasicBySourceUrl = async (db, sourceUrl) => {
  const cacheKey = String(sourceUrl || '').trim();
  const cachedNote = await getCachedNoteBasic(db, cacheKey);
  if (cachedNote) {
    return cachedNote;
  }

  const paramNames = ['url', 'link', 'note_url', 'share_url'];
  for (const paramName of paramNames) {
    try {
      const result = await requestNoteBasic({ [paramName]: sourceUrl });
      if (result?.noteBasic) {
        await saveCachedNoteBasic(db, cacheKey, result.noteBasic, result.payload);
        return {
          ...result.noteBasic,
          cache_hit: false,
        };
      }
    } catch {
      // Try the next accepted parameter name.
    }
  }

  return null;
};

// 根据笔记ID获取笔记基本信息
const fetchNoteBasicByNoteId = async (db, noteUrl, noteId, resolvedNoteUrl) => {
  const cacheKey = String(noteUrl || '').trim();
  const cachedNote = await getCachedNoteBasic(db, cacheKey);
  if (cachedNote) {
    return {
      ...cachedNote,
      cache_hit: true,
    };
  }

  try {
    const result = await requestNoteBasic({ note_id: noteId });
    if (result?.noteBasic) {
      const noteBasic = {
        ...result.noteBasic,
        note_url: resolvedNoteUrl || result.noteBasic.note_url || noteUrl,
      };
      await saveCachedNoteBasic(db, cacheKey, noteBasic, result.payload);
      return {
        ...noteBasic,
        cache_hit: false,
      };
    }
  } catch {
    // Fall through to null.
  }

  return null;
};

// 解析批量订单内容
const parseBatchContent = (content) => {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const seenNoteIds = new Set();

  return lines.map((line, index) => {
    const [noteUrl = '', quantityText = ''] = line.split(/\s+/);
    const orderedQuantity = Number(quantityText);
    const noteId = extractNoteId(noteUrl);
    const errors = [];

    if (!/^https?:\/\/\S+/i.test(noteUrl)) {
      errors.push('链接格式不正确');
    } else if (!noteId) {
      errors.push('未能从链接中解析笔记ID');
    }
    const duplicate = Boolean(noteId) && seenNoteIds.has(noteId);
    if (duplicate) {
      errors.push('链接重复');
    }
    if (!Number.isInteger(orderedQuantity) || orderedQuantity <= 0) {
      errors.push('数量必须是正整数');
    }
    if (noteId && !duplicate) {
      seenNoteIds.add(noteId);
    }

    return {
      avatar_url: '',
      duplicate,
      errors,
      line_no: index + 1,
      note_id: noteId,
      note_url: noteUrl,
      ordered_quantity: Number.isInteger(orderedQuantity) ? orderedQuantity : 0,
      raw: line,
      valid: errors.length === 0,
    };
  });
};

// 获取系统配置中的数值类型
const getNumericConfig = async (db, group, key, defaultValue) => {
  const [[row]] = await db.execute(
    `
      SELECT config_value
      FROM system_configs
      WHERE config_group = ? AND config_key = ? AND status = 'active'
      LIMIT 1
    `,
    [group, key],
  );

  if (!row) {
    return defaultValue;
  }

  try {
    const value = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value;
    const numberValue = Number(value?.value ?? value);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : defaultValue;
  } catch {
    return defaultValue;
  }
};

// 获取用户订单上下文
const getUserOrderContext = async (db, userId, targetType) => {
  const [[user]] = await db.execute(
    `
      SELECT id, discount_rate, impression_discount_rate, price_mode, impression_price_mode,
        fixed_unit_price, impression_fixed_unit_price
      FROM users
      WHERE id = ?
      LIMIT 1
    `,
    [userId],
  );

  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const [[balance]] = await db.execute(
    `
      SELECT available_amount
      FROM balance_accounts
      WHERE user_id = ?
      LIMIT 1
    `,
    [userId],
  );

  const configuredUnitPrice =
    targetType === 'impression'
      ? await getNumericConfig(db, 'pricing', 'impression_unit_price', 0.01)
      : await getNumericConfig(db, 'pricing', 'view_unit_price', 0.01);
  const mode =
    targetType === 'impression'
      ? user.impression_price_mode || 'discount'
      : user.price_mode || 'discount';
  const rawDiscountRate =
    targetType === 'impression' ? user.impression_discount_rate : user.discount_rate;
  const fixedUnitPrice =
    targetType === 'impression' ? user.impression_fixed_unit_price : user.fixed_unit_price;
  const userUnitPrice = Number(fixedUnitPrice) > 0 ? round4(fixedUnitPrice) : configuredUnitPrice;
  const unitPrice = mode === 'discount' ? configuredUnitPrice : userUnitPrice;
  const discountRate = mode === 'default' ? 1 : normalizeDiscountRate(rawDiscountRate);
  const discountedUnitPrice =
    mode === 'fixed'
      ? userUnitPrice
      : round4(unitPrice * discountRate);

  return {
    availableBalance: round4(balance?.available_amount),
    discountRate: unitPrice > 0 ? round4(discountedUnitPrice / unitPrice) : discountRate,
    discountedUnitPrice,
    unitPrice: round4(unitPrice),
  };
};

// 构建订单预览
const buildPreview = async (
  userId,
  { content, target_type: targetTypeValue },
  { persistCheckRecords = true } = {},
) => {
  const db = getPool();
  const targetType = normalizeTargetType(targetTypeValue);
  const context = await getUserOrderContext(db, userId, targetType);
  const parsedItems = parseBatchContent(content);
  const seenResolvedNoteIds = new Set();
  const runExternalCheck = createAsyncLimiter(getBatchCheckConcurrency());
  const items = await Promise.all(parsedItems.map(async (item) => {
    const errors = [...item.errors];
    let noteId = item.note_id;
    let resolvedNoteUrl = item.note_url;
    let noteBasic = null;

    if (item.valid) {
      if (isShortNoteLink(item.note_url)) {
        noteBasic = await getCachedNoteBasic(db, item.note_url);
        if (noteBasic) {
          noteId = noteBasic.note_id;
          resolvedNoteUrl = noteBasic.note_url || item.note_url;
        } else {
          const resolved = await runExternalCheck(() => requestNoteId(item.note_url));
          noteId = resolved?.note_id || '';
          resolvedNoteUrl = resolved?.note_url || item.note_url;
        }
      } else {
        noteBasic = await runExternalCheck(() => fetchNoteBasicBySourceUrl(db, item.note_url));
      }

      if (noteBasic) {
        noteId = noteBasic.note_id;
        resolvedNoteUrl = noteBasic.note_url || item.note_url;
      }

      if (!noteId) {
        errors.push(isShortNoteLink(item.note_url) ? '短链接未解析到有效笔记ID' : '未能从链接中解析笔记ID');
      } else if (seenResolvedNoteIds.has(noteId)) {
        errors.push('链接重复');
      } else {
        seenResolvedNoteIds.add(noteId);
        if (!noteBasic) {
          noteBasic = await runExternalCheck(() =>
            fetchNoteBasicByNoteId(db, item.note_url, noteId, resolvedNoteUrl),
          );
        }
        if (!noteBasic) {
          errors.push('笔记检测失败');
        }
      }
    }

    const originalAmount = context.unitPrice;
    const payableAmount = context.discountedUnitPrice;
    if (item.valid && !noteBasic) {
      // The note lookup error has already been appended above.
    }
    const valid = errors.length === 0;

    return {
      ...item,
      author_id: noteBasic?.author_id || '',
      author_name: noteBasic?.author_name || '',
      avatar_url: noteBasic?.avatar_url || '',
      cache_hit: Boolean(noteBasic?.cache_hit),
      duplicate: errors.includes('链接重复'),
      errors,
      note_id: noteBasic?.note_id || noteId,
      resolved_note_url: resolvedNoteUrl,
      title: noteBasic?.title || '',
      valid,
      discount_amount: valid ? round4(Math.max(originalAmount - payableAmount, 0)) : 0,
      payable_amount: valid ? round4(payableAmount) : 0,
    };
  }));

  const validItems = items.filter((item) => item.valid);
  const totalAmount = round4(validItems.reduce((sum, item) => sum + item.payable_amount, 0));
  const hasInvalid = items.some((item) => !item.valid);
  const warnings = [];

  if (items.length === 0) {
    warnings.push('请先输入批量下单内容');
  }
  if (hasInvalid) {
    warnings.push('存在格式错误的行，请修正后再提交');
  }
  if (totalAmount > context.availableBalance) {
    warnings.push('可用余额不足，请充值后再提交');
  }

  const checkBatchNo = createCheckBatchNo();
  if (persistCheckRecords) {
    await saveBatchLinkCheckRecords(db, userId, checkBatchNo, targetType, items);
  }

  return {
    available_balance: context.availableBalance,
    can_submit: items.length > 0 && !hasInvalid && totalAmount <= context.availableBalance,
    check_batch_no: checkBatchNo,
    discount_rate: context.discountRate,
    discounted_unit_price: context.discountedUnitPrice,
    invalid_count: items.length - validItems.length,
    items,
    target_type: targetType,
    total_amount: totalAmount,
    total_count: items.length,
    unit_price: context.unitPrice,
    valid_count: validItems.length,
    warnings,
  };
};

const createOrderChargeRecord = async (
  connection,
  { beforeBalance, item, now, orderId, orderNo, preview, recordNo, userId },
) => {
  const afterBalance = round4(beforeBalance - item.payable_amount);

  await connection.execute(
    `
      INSERT INTO account_records
        (
          record_no, user_id, record_type, direction, order_id, order_no,
          status, ordered_quantity, original_unit_price, original_total_amount,
          discount_rate, discounted_unit_price, discount_amount, payable_amount,
          actual_paid_amount, net_amount, before_available_amount, after_available_amount,
          reason_message, created_at, updated_at
        )
      VALUES (?, ?, 'order_charge', 'debit', ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      recordNo,
      userId,
      orderId,
      orderNo,
      item.ordered_quantity,
      preview.unit_price,
      preview.unit_price,
      preview.discount_rate,
      preview.discounted_unit_price,
      item.discount_amount,
      item.payable_amount,
      item.payable_amount,
      -item.payable_amount,
      beforeBalance,
      afterBalance,
      '批量下单扣费',
      now,
      now,
    ],
  );

  return afterBalance;
};

const createBatchNo = () =>
  `BATCH-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(1).toString('hex').toUpperCase()}`;

const refundFailedChargedOrders = async (db, userId) => {
  const connection = await db.getConnection();
  const now = new Date();

  try {
    await connection.beginTransaction();

    const [orders] = await connection.execute(
      `
        SELECT
          o.*,
          ar.id AS charge_record_id,
          ar.actual_paid_amount,
          ar.discount_rate,
          ar.discounted_unit_price
        FROM orders o
        INNER JOIN account_records ar
          ON ar.order_id = o.id
          AND ar.record_type = 'order_charge'
          AND ar.status = 'success'
        WHERE o.user_id = ?
          AND o.order_status = 'failed'
          AND NOT EXISTS (
            SELECT 1
            FROM account_records rr
            WHERE rr.order_id = o.id
              AND rr.record_type = 'refund'
              AND rr.status = 'success'
          )
        FOR UPDATE
      `,
      [userId],
    );

    if (orders.length === 0) {
      await connection.commit();
      return;
    }

    const [[balance]] = await connection.execute(
      `
        SELECT available_amount
        FROM balance_accounts
        WHERE user_id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [userId],
    );
    let beforeBalance = round4(balance?.available_amount);

    for (const order of orders) {
      const paidAmount = Number(order.actual_paid_amount) || 0;
      const refundedAmount = Number(order.refund_amount_total) || 0;
      const refundAmount = round4(Math.max(paidAmount - refundedAmount, 0));
      if (refundAmount <= 0) {
        continue;
      }

      const afterBalance = round4(beforeBalance + refundAmount);
      const recordNo = `REFUND-${Date.now()}-${String(order.id).padStart(3, '0')}`;
      await connection.execute(
        `
          INSERT INTO account_records
            (
              record_no, user_id, record_type, direction, order_id, order_no,
              related_record_id, status, ordered_quantity, completed_quantity, refunded_quantity,
              original_unit_price, original_total_amount, discount_rate, discounted_unit_price,
              discount_amount, payable_amount, actual_paid_amount, refund_amount, net_amount,
              before_available_amount, after_available_amount, reason_message, remark,
              created_at, updated_at
            )
          VALUES (?, ?, 'refund', 'credit', ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          recordNo,
          userId,
          order.id,
          order.order_no,
          order.charge_record_id,
          order.ordered_quantity,
          order.completed_quantity,
          order.ordered_quantity,
          order.discounted_unit_price,
          refundAmount,
          order.discount_rate,
          order.discounted_unit_price,
          0,
          refundAmount,
          refundAmount,
          refundAmount,
          beforeBalance,
          afterBalance,
          '订单失败自动退款',
          order.reason_message || '',
          now,
          now,
        ],
      );

      await connection.execute(
        `
          UPDATE orders
          SET refunded_quantity = ordered_quantity,
              refund_amount_total = refund_amount_total + ?,
              reason_message = COALESCE(reason_message, '订单失败自动退款'),
              updated_at = ?
          WHERE id = ?
        `,
        [refundAmount, now, order.id],
      );

      beforeBalance = afterBalance;
    }

    await connection.execute(
      'UPDATE balance_accounts SET available_amount = ?, updated_at = ? WHERE user_id = ?',
      [beforeBalance, now, userId],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const refreshBatchStats = async (db, userId, batchIds) => {
  const ids = [...new Set(batchIds.map(Number).filter(Boolean))];
  if (ids.length === 0) {
    return;
  }

  const placeholders = ids.map(() => '?').join(',');
  const [statsRows] = await db.execute(
    `
      SELECT
        batch_id,
        COUNT(1) AS total_count,
        COALESCE(SUM(CASE WHEN order_status = 'running' THEN 1 ELSE 0 END), 0) AS processing_count,
        COALESCE(SUM(CASE WHEN order_status = 'completed' THEN 1 ELSE 0 END), 0) AS succeeded_count,
        COALESCE(SUM(CASE WHEN order_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count
      FROM orders
      WHERE batch_id IN (${placeholders})
        AND user_id = ?
      GROUP BY batch_id
    `,
    [...ids, userId],
  );

  const now = new Date();
  for (const stats of statsRows) {
    const totalCount = Number(stats.total_count) || 0;
    const processingCount = Number(stats.processing_count) || 0;
    const succeededCount = Number(stats.succeeded_count) || 0;
    const failedCount = Number(stats.failed_count) || 0;
    const nextStatus =
      totalCount > 0 && succeededCount === totalCount
        ? 'completed'
        : processingCount > 0
          ? 'processing'
          : failedCount > 0
            ? 'failed'
            : 'pending';

    await db.execute(
      `
        UPDATE order_batches
        SET status = ?,
            processing_count = ?,
            succeeded_count = ?,
            failed_count = ?,
            retryable_count = 0,
            finished_at = CASE WHEN ? IN ('completed', 'failed') THEN COALESCE(finished_at, ?) ELSE finished_at END,
            updated_at = ?
        WHERE id = ?
          AND user_id = ?
      `,
      [
        nextStatus,
        processingCount,
        succeededCount,
        failedCount,
        nextStatus,
        now,
        now,
        stats.batch_id,
        userId,
      ],
    );
  }
};

// 提交批量订单
const submitBatch = async (userId, params) => {
  if (!params?.agree_policy) {
    const error = new Error('Please confirm the order policy');
    error.statusCode = 400;
    throw error;
  }

  const preview = await buildPreview(userId, params, { persistCheckRecords: false });
  if (!preview.can_submit) {
    const error = new Error('Batch content validation failed');
    error.statusCode = 400;
    error.details = preview;
    throw error;
  }

  const db = getPool();
  await ensureOrderSnapshotColumns(db);
  const connection = await db.getConnection();
  const now = new Date();
  const batchUuid = crypto.randomUUID();
  const batchNo = createBatchNo();

  try {
    await connection.beginTransaction();

    await connection.execute(
      `
        INSERT INTO order_batches
          (
            batch_id, batch_no, user_id, source_type, submit_mode, raw_content,
            estimated_amount, status, total_count, pending_count, processing_count,
            succeeded_count, failed_count, retryable_count, submitted_at, created_at, updated_at
          )
        VALUES (?, ?, ?, 'manual', 'batch', ?, ?, 'processing', ?, 0, ?, 0, 0, 0, ?, ?, ?)
      `,
      [
        batchUuid,
        batchNo,
        userId,
        params.content,
        preview.total_amount,
        preview.valid_count,
        preview.valid_count,
        now,
        now,
        now,
      ],
    );

    const [[batch]] = await connection.execute('SELECT id FROM order_batches WHERE batch_id = ?', [
      batchUuid,
    ]);

    let beforeBalance = preview.available_balance;
    let submittedCount = 0;
    let failedCount = 0;
    let chargedAmount = 0;
    const validPreviewItems = preview.items.filter((entry) => entry.valid);
    const orderRows = [];

    for (const [index, item] of validPreviewItems.entries()) {
      const orderNo = `ORDER-${Date.now()}-${String(index + 1).padStart(3, '0')}`;
      const recordNo = `REC-${Date.now()}-${String(index + 1).padStart(3, '0')}`;

      const [insertResult] = await connection.execute(
        `
          INSERT INTO orders
            (
              order_no, user_id, batch_id, batch_item_id, note_id, note_url, target_type,
              title, author_name, avatar_url,
              ordered_quantity, completed_quantity, order_status, external_task_id,
              external_status, external_progress, external_completed_quantity,
              last_verified_at, reason_message, created_at, updated_at
            )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          orderNo,
          userId,
          batch.id,
          item.line_no,
          item.note_id,
          item.note_url,
          preview.target_type,
          item.title || null,
          item.author_name || null,
          item.avatar_url || null,
          item.ordered_quantity,
          0,
          'running',
          null,
          null,
          0,
          0,
          null,
          null,
          now,
          now,
        ],
      );

      orderRows.push({
        id: insertResult.insertId,
        item,
        orderNo,
        recordNo,
      });
    }

    const taskResults = await Promise.all(
      orderRows.map(async (order) => {
        try {
          const xhsResult = await getXhsTaskClient().createTask(
            preview.target_type,
            createXhsTaskPayload({
              batchNo,
              item: order.item,
              orderNo: order.orderNo,
              source: `goods:${order.id}`,
              targetType: preview.target_type,
            }),
            { token: createCurrentUserToken(userId) },
          );
          const externalTaskId =
            xhsResult?.id === null || xhsResult?.id === undefined ? null : String(xhsResult.id);
          if (!externalTaskId) {
            throw new Error('XHS API response missing task id');
          }
          return {
            externalTaskId,
            orderId: order.id,
          };
        } catch (error) {
          return {
            error,
            orderId: order.id,
          };
        }
      }),
    );
    const taskResultByOrderId = new Map(taskResults.map((result) => [result.orderId, result]));

    for (const order of orderRows) {
      let orderStatus = 'running';
      const taskResult = taskResultByOrderId.get(order.id);
      const externalTaskId = taskResult?.externalTaskId || null;

      try {
        if (taskResult?.error) {
          throw taskResult.error;
        }
        if (!externalTaskId) {
          throw new Error('XHS API response missing task id');
        }
        await connection.execute(
          `
            UPDATE orders
            SET external_task_id = ?,
                external_status = 'accepted',
                reason_message = NULL,
                updated_at = ?
            WHERE id = ?
          `,
          [externalTaskId, now, order.id],
        );
      } catch (error) {
        orderStatus = 'failed';
        await connection.execute(
          `
            UPDATE orders
            SET order_status = 'failed',
                reason_message = ?,
                updated_at = ?
            WHERE id = ?
          `,
          [normalizeXhsErrorMessage(error), now, order.id],
        );
      }

      if (orderStatus === 'failed') {
        failedCount += 1;
        continue;
      }

      const afterBalance = round4(beforeBalance - order.item.payable_amount);
      await connection.execute(
        `
          INSERT INTO account_records
            (
              record_no, user_id, record_type, direction, order_id, order_no,
              status, ordered_quantity, original_unit_price, original_total_amount,
              discount_rate, discounted_unit_price, discount_amount, payable_amount,
              actual_paid_amount, net_amount, before_available_amount, after_available_amount,
              reason_message, created_at, updated_at
            )
          VALUES (?, ?, 'order_charge', 'debit', ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          order.recordNo,
          userId,
          order.id,
          order.orderNo,
          order.item.ordered_quantity,
          preview.unit_price,
          preview.unit_price,
          preview.discount_rate,
          preview.discounted_unit_price,
          order.item.discount_amount,
          order.item.payable_amount,
          order.item.payable_amount,
          -order.item.payable_amount,
          beforeBalance,
          afterBalance,
          '批量下单扣费',
          now,
          now,
        ],
      );

      beforeBalance = afterBalance;
      submittedCount += 1;
      chargedAmount = round4(chargedAmount + order.item.payable_amount);
    }

    await connection.execute(
      'UPDATE balance_accounts SET available_amount = ?, updated_at = ? WHERE user_id = ?',
      [beforeBalance, now, userId],
    );

    const batchStatus =
      submittedCount > 0
        ? 'processing'
        : 'failed';
    await connection.execute(
      `
        UPDATE order_batches
        SET status = ?,
            processing_count = ?,
            succeeded_count = ?,
            failed_count = ?,
            retryable_count = ?,
            finished_at = CASE WHEN ? = 'failed' THEN ? ELSE finished_at END,
            updated_at = ?
        WHERE id = ?
      `,
      [batchStatus, submittedCount, 0, failedCount, failedCount, batchStatus, now, now, batch.id],
    );

    await connection.commit();

    return {
      batch_id: batchUuid,
      batch_no: batchNo,
      failed_count: failedCount,
      submitted_count: submittedCount,
      total_amount: chargedAmount,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const retryBatch = async (userId, batchId) => {
  const error = new Error('Failed orders are refunded automatically and cannot be retried');
  error.statusCode = 400;
  throw error;

  const db = getPool();
  const connection = await db.getConnection();
  const targetBatchId = Number(batchId);
  const now = new Date();

  if (!targetBatchId) {
    const error = new Error('Invalid batch id');
    error.statusCode = 400;
    throw error;
  }

  try {
    await connection.beginTransaction();

    const [[batch]] = await connection.execute(
      'SELECT id, batch_no, user_id FROM order_batches WHERE id = ? AND user_id = ? FOR UPDATE',
      [targetBatchId, userId],
    );
    if (!batch) {
      const error = new Error('Batch not found');
      error.statusCode = 404;
      throw error;
    }

    const [ordersToRetry] = await connection.execute(
      `
        SELECT
          o.id, o.order_no, o.batch_item_id, o.note_id, o.note_url, o.target_type,
          o.ordered_quantity, o.external_task_id,
          COUNT(ar.id) AS charge_count
        FROM orders o
        LEFT JOIN account_records ar
          ON ar.order_id = o.id
          AND ar.record_type = 'order_charge'
          AND ar.status = 'success'
        WHERE o.batch_id = ?
          AND o.user_id = ?
          AND o.order_status IN ('failed', 'manual_review', 'repair_review')
        GROUP BY
          o.id, o.order_no, o.batch_item_id, o.note_id, o.note_url, o.target_type,
          o.ordered_quantity, o.external_task_id
        FOR UPDATE
      `,
      [targetBatchId, userId],
    );

    let retriedCount = 0;
    let beforeBalance = null;

    for (const order of ordersToRetry) {
      const targetType = normalizeTargetType(order.target_type);
      const hasCharge = Number(order.charge_count) > 0;
      let externalTaskId = order.external_task_id || null;

      if (!externalTaskId) {
        try {
          const xhsResult = await getXhsTaskClient().createTask(
            targetType,
            createXhsTaskPayload({
              batchNo: batch.batch_no,
              item: {
                line_no: order.batch_item_id,
                note_id: order.note_id,
                note_url: order.note_url,
                ordered_quantity: Number(order.ordered_quantity) || 0,
              },
              orderNo: order.order_no,
              targetType,
            }),
            { token: createCurrentUserToken(userId) },
          );
          externalTaskId =
          xhsResult?.id === null || xhsResult?.id === undefined ? null : String(xhsResult.id);
          if (!externalTaskId) {
            throw new Error('XHS API response missing task id');
          }
        } catch (error) {
          await connection.execute(
            'UPDATE orders SET reason_message = ?, updated_at = ? WHERE id = ?',
            [normalizeXhsErrorMessage(error), now, order.id],
          );
          continue;
        }
      }

      if (!hasCharge) {
        if (beforeBalance === null) {
          const [[balance]] = await connection.execute(
            'SELECT available_amount FROM balance_accounts WHERE user_id = ? FOR UPDATE',
            [userId],
          );
          beforeBalance = Number(balance?.available_amount) || 0;
        }

        const context = await getUserOrderContext(connection, userId, targetType);
        const orderedQuantity = Number(order.ordered_quantity) || 0;
        const payableAmount = round4(orderedQuantity * context.discountedUnitPrice);
        const item = {
          discount_amount: round4(orderedQuantity * context.unitPrice - payableAmount),
          ordered_quantity: orderedQuantity,
          payable_amount: payableAmount,
        };
        beforeBalance = await createOrderChargeRecord(connection, {
          beforeBalance,
          item,
          now,
          orderId: order.id,
          orderNo: order.order_no,
          preview: {
            discount_rate: context.discountRate,
            discounted_unit_price: context.discountedUnitPrice,
            unit_price: context.unitPrice,
          },
          recordNo: `REC-${Date.now()}-${String(order.id).padStart(3, '0')}`,
          userId,
        });
      }

      await connection.execute(
        `
          UPDATE orders
          SET order_status = 'running',
              external_task_id = ?,
              completed_quantity = 0,
              external_status = 'accepted',
              external_progress = 0,
              external_completed_quantity = 0,
              last_verified_at = NULL,
              reason_message = NULL,
              updated_at = ?
          WHERE id = ?
        `,
        [externalTaskId, now, order.id],
      );
      retriedCount += 1;
    }

    if (beforeBalance !== null) {
      await connection.execute(
        'UPDATE balance_accounts SET available_amount = ?, updated_at = ? WHERE user_id = ?',
        [beforeBalance, now, userId],
      );
    }

    const [[stats]] = await connection.execute(
      `
        SELECT
          COUNT(1) AS total_count,
          COALESCE(SUM(CASE WHEN order_status = 'running' THEN 1 ELSE 0 END), 0) AS processing_count,
          COALESCE(SUM(CASE WHEN order_status = 'completed' THEN 1 ELSE 0 END), 0) AS succeeded_count,
          COALESCE(SUM(CASE WHEN order_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
          COALESCE(SUM(CASE WHEN order_status IN ('failed', 'manual_review', 'repair_review') THEN 1 ELSE 0 END), 0) AS retryable_count
        FROM orders
        WHERE batch_id = ?
          AND user_id = ?
      `,
      [targetBatchId, userId],
    );

    const totalCount = Number(stats.total_count) || 0;
    const processingCount = Number(stats.processing_count) || 0;
    const succeededCount = Number(stats.succeeded_count) || 0;
    const failedCount = Number(stats.failed_count) || 0;
    const retryableCount = Number(stats.retryable_count) || 0;
    const nextStatus =
      totalCount > 0 && succeededCount === totalCount
        ? 'completed'
        : failedCount > 0 && processingCount === 0
          ? 'failed'
          : 'processing';

    await connection.execute(
      `
        UPDATE order_batches
        SET status = ?,
            processing_count = ?,
            succeeded_count = ?,
            failed_count = ?,
            retryable_count = ?,
            updated_at = ?
        WHERE id = ?
      `,
      [
        nextStatus,
        processingCount,
        succeededCount,
        failedCount,
        retryableCount,
        now,
        targetBatchId,
      ],
    );

    await connection.commit();

    return {
      batch_id: targetBatchId,
      retried_count: retriedCount,
      status: nextStatus,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

module.exports = {
  buildPreview,
  listBatchOrderRecords,
  listBatchLinkCheckRecords,
  listConsumptionRecords,
  listProblemLinkRecords,
  listRefundRecords,
  requestOrderRefund,
  reviewOrderRefund,
  retryBatch,
  saveProblemLinkRecords,
  submitBatch,
  _private: {
    ensureBatchLinkCheckRecordTable,
    ensureNoteBasicCacheTable,
    ensureProblemLinkRecordTable,
    setXhsTaskClient,
  },
};
