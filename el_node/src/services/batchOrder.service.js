const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { getPool } = require('../config/database');

const execFileAsync = promisify(execFile);
const TARGET_TYPES = new Set(['view', 'impression', 'like']);
const ACTIVE_NOTE_ORDER_STATUSES = [
  'running',
  'repair_review',
  'refund_requested',
  'refund_calculating',
  'stopping',
  'refund_rejected',
];
const TARGET_TYPE_LABELS = {
  impression: '曝光',
  like: '点赞',
  view: '阅读',
};
const TINYDATA_PREVIEW_API =
  process.env.TINYDATA_PREVIEW_API || 'http://185.213.63.243:9101/api/v1/order-batches/preview'; // 预览订单
const TINYDATA_PREVIEW_JOB_API =
  process.env.TINYDATA_PREVIEW_JOB_API ||
  new URL('../preview-jobs/', TINYDATA_PREVIEW_API.endsWith('/')
    ? TINYDATA_PREVIEW_API
    : `${TINYDATA_PREVIEW_API}/`).toString();
const TINYDATA_PREVIEW_CURL_BIN =
  process.env.TINYDATA_PREVIEW_CURL_BIN || '';
const TINYDATA_PREVIEW_PROXY =
  process.env.TINYDATA_PREVIEW_PROXY || '';
const XHS_API_ENDPOINTS = {
  impression: '/api/v2/impression',
  like: '/api/v2/note_likes',
  view: '/api/v2/note_views',
};
let noteBasicCacheTableReady;
let problemLinkRecordTableReady;
let batchLinkCheckRecordTableReady;
let orderSnapshotColumnsReady;
let replenishmentRecordTableReady;
let xhsTaskClientOverride = null;

// 金额和单价四舍五入保留4位小数
const round4 = (value) => Math.round((Number(value) || 0) * 10_000) / 10_000;

const ADMIN_ROLES = new Set(['super', 'admin']);

// 获取用户的角色代码列表
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

// 检查用户是否有权限查看所有账户记录
const canViewAllAccountRecords = async (db, userId) => {
  const roleCodes = await getUserRoleCodes(db, userId);
  return roleCodes.some((roleCode) => ADMIN_ROLES.has(roleCode));
};

// 验证当前用户是否有管理员权限
const assertAdmin = async (db, userId) => {
  const isAdmin = await canViewAllAccountRecords(db, userId);
  if (!isAdmin) {
    const error = new Error('Admin permission required');
    error.statusCode = 403;
    throw error;
  }
};

// 规范化目标类型为 view、impression 或 like
const normalizeTargetType = (value) => {
  const targetType = String(value || 'view').trim().toLowerCase();
  return TARGET_TYPES.has(targetType) ? targetType : 'view';
};

// 将目标类型转换为显示标签（阅读/曝光/点赞）
const getTargetTypeLabel = (targetType) => TARGET_TYPE_LABELS[targetType] || '当前业务';

// 规范化折扣率，无效时默认为1
const normalizeDiscountRate = (value) => {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? round4(rate) : 1;
};

// 读取并限制批量预览的并发数上限
const getBatchCheckConcurrency = () => {
  const concurrency = Number(process.env.BATCH_CHECK_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    return 1000;
  }

  return concurrency;
};

// 注入小红书任务客户端（主要用于测试）
const setXhsTaskClient = (client) => {
  xhsTaskClientOverride = client || null;
};

// 小红书API配置
// 读取上游小红书API的基础URL、令牌和超时配置
const getXhsApiConfig = () => ({
  baseUrl: process.env.XHS_API_BASE_URL || 'http://185.213.63.243:9101',
  timeoutMs: Number(process.env.XHS_API_TIMEOUT_MS) || 60_000,
});

// 创建默认的上游小红书任务客户端
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

  // 创建小红书任务（如广告、评论、点赞等）
  // 支持自定义令牌和超时配置
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
      console.log(`POST ${endpoint}`, JSON.stringify(payload, null, 2));
      const response = await fetch(url, {
        body: JSON.stringify(payload),
        headers,
        method: 'POST',
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      console.log(`RESPONSE ${endpoint}`, JSON.stringify(body, null, 2));
      if (!response.ok || body?.success === false || body?.code !== 0) {
        throw new Error(body?.message || `XHS API request failed with HTTP ${response.status}`);
      }

      const taskId = normalizeXhsTaskId(body?.data?.id);
      if (!taskId) {
        throw new Error('XHS API response missing task id (numeric)');
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

// 返回当前使用的上游小红书任务客户端
const getXhsTaskClient = () => {
  const defaultClient = createDefaultXhsTaskClient();
  return xhsTaskClientOverride ? { ...defaultClient, ...xhsTaskClientOverride } : defaultClient;
};

// 构建任务调用使用的上游认证令牌
const createCurrentUserToken = () =>  process.env.XHS_API_TOKEN || 'xhs-api-123456789';

// 从上游状态响应中提取数据对象
const getXhsStatusData = (body) => body?.data ?? body ?? {};

// 从上游响应中读取任务状态
const getXhsTaskStatus = (body) => {
  const data = getXhsStatusData(body);
  return Number(data.status ?? body?.status ?? 0) || 0;
};

// 从上游响应中读取计数字段
const getXhsTaskCount = (body, key) => {
  const data = getXhsStatusData(body);
  return Number(data[key] ?? body?.[key] ?? 0) || 0;
};

// 计算发送给上游创建任务的 total_count（点赞类型需加上当前点赞数）
const getXhsCreateTotalCount = (item, targetType) => {
  const orderedQuantity = Math.max(Number(item?.ordered_quantity) || 0, 0);
  if (targetType !== 'like') {
    return orderedQuantity;
  }
  const currentLikeCount = Math.max(Number(item?.like_count) || 0, 0);
  return orderedQuantity + currentLikeCount;
};

// 构建上游任务创建的请求体
const createXhsTaskPayload = ({ batchNo, item, orderNo, source, targetType }) => ({
  author_id: item.author_id || '',
  note_id: item.note_id,
  priority: 0,
  reason: `goodsAdmin:order=${orderNo};session=${batchNo}`,
  source: source || '',
  status: 1,
  total_count: getXhsCreateTotalCount(item, targetType),
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

// 规范化上游任务ID（仅保留纯数字ID）
const normalizeXhsTaskId = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const taskId = String(value).trim();
  return /^\d+$/.test(taskId) ? taskId : null;
};

// 调用上游API停止订单对应的任务
const stopXhsTask = async ({ reason = '', taskId, targetType, userId }) => {
  const externalTaskId = normalizeXhsTaskId(taskId);
  if (!externalTaskId) {
    const error = new Error('Invalid XHS task id');
    error.statusCode = 400;
    throw error;
  }

  return getXhsTaskClient().updateTaskStatus(
    normalizeTargetType(targetType),
    {
      id: Number(externalTaskId),
      reason,
      status: 3,
    },
    { token: createCurrentUserToken(userId) },
  );
};

// 将上游或网络错误转换为用户可读的错误信息
const normalizeXhsErrorMessage = (error) => {
  const causeMessage = error?.cause?.message || error?.cause?.code || '';
  const message = [error?.message || error || 'unknown error', causeMessage]
    .filter(Boolean)
    .join(': ');
  return `XHS task create failed: ${String(message).slice(0, 220)}`;
};

// 创建异步并发限制器（控制同时执行的异步任务数量）
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

// 从URL中提取小红书笔记ID
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

// 检查笔记链接是否为 xhslink.com 短链接
const isShortNoteLink = (noteUrl) => {
  try {
    const url = new URL(noteUrl);
    return /(^|\.)xhslink\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
};

// 本地解析短链接：通过 HTTP 重定向获取完整的小红书URL，提取笔记ID
const resolveShortLinkLocally = async (shortUrl) => {
  try {
    const response = await fetch(shortUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    const location = response.headers.get('location') || '';
    if (!location) {
      return null;
    }
    const noteId = extractNoteId(location);
    if (!noteId) {
      return null;
    }
    const resolvedUrl = noteId
      ? `https://www.xiaohongshu.com/explore/${noteId}`
      : location;
    return { note_id: noteId, note_url: resolvedUrl };
  } catch {
    return null;
  }
};

// 笔记解析服务地址
const NOTE_API_BASE = 'http://192.168.31.189:9110/api/v1/note';

// 通过链接获取笔记ID
const fetchNoteIdFromApi = async (url) => {
  try {
    const response = await fetch(`${NOTE_API_BASE}/id?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    if (body?.code === 0 && body?.data?.note_id) {
      return body.data.note_id;
    }
    return '';
  } catch {
    return '';
  }
};

// 通过笔记ID获取笔记详情（标题、作者、头像）
const fetchNoteBasicFromApi = async (noteId) => {
  try {
    const response = await fetch(
      `${NOTE_API_BASE}/basic?note_id=${encodeURIComponent(noteId)}&proxy_line=line_1086`,
      { signal: AbortSignal.timeout(10000) },
    );
    const body = await response.json();
    if (body?.code === 0 && body?.data?.base_info) {
      const info = body.data.base_info;
      return {
        title: info.title || '',
        author_id: info.user?.id || '',
        author_name: info.user?.name || '',
        avatar_url: info.user?.image || '',
      };
    }
    return null;
  } catch {
    return null;
  }
};

// 本地预览解析：通过笔记ID接口解析所有链接类型
const resolvePreviewLocally = async (content) => {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const limiter = createAsyncLimiter(getBatchCheckConcurrency());

  const items = await Promise.all(
    lines.map(async (raw, index) => {
      const parts = raw.split(/\s+/);
      const noteUrl = parts[0] || '';
      const orderedQuantity = Number(parts[1]);
      const errors = [];
      const isLink = /^https?:\/\/\S+/i.test(noteUrl);

      if (!isLink) {
        return {
          author_id: '',
          author_name: '',
          avatar_url: '',
          duplicate: false,
          errors: ['Invalid link format'],
          line_no: index + 1,
          note_id: '',
          note_url: noteUrl,
          ordered_quantity: 0,
          raw,
          resolved_note_url: '',
          title: '',
          valid: false,
        };
      }

      // 先尝试直接从URL提取（非短链接）
      let noteId = isShortNoteLink(noteUrl) ? '' : extractNoteId(noteUrl);
      // 提取不到时调用笔记ID接口（支持短链接和所有URL格式）
      if (!noteId) {
        noteId = await limiter(() => fetchNoteIdFromApi(noteUrl));
      }
      // 第一次没拿到笔记ID，自动重试一次
      if (!noteId) {
        noteId = await limiter(() => fetchNoteIdFromApi(noteUrl));
      }
      const resolvedNoteUrl = noteId
        ? `https://www.xiaohongshu.com/explore/${noteId}`
        : noteUrl;

      if (!noteId) {
        errors.push('未解析到笔记ID');
      }
      if (!Number.isInteger(orderedQuantity) || orderedQuantity <= 0) {
        errors.push('数量必须是正整数');
      }

      // 获取笔记详情（标题、作者、头像）
      let noteDetail = noteId ? await limiter(() => fetchNoteBasicFromApi(noteId)) : null;

      // 爬虫接口拿不到博主ID时，用 Tinydata 预览接口补充获取
      if (noteId && (!noteDetail || !noteDetail.author_id)) {
        const resolved = await limiter(() => resolveNoteWithPreview(noteUrl));
        if (resolved?.noteBasic) {
          noteDetail = {
            title: resolved.noteBasic.title || noteDetail?.title || '',
            author_id: resolved.noteBasic.author_id || noteDetail?.author_id || '',
            author_name: resolved.noteBasic.author_name || noteDetail?.author_name || '',
            avatar_url: resolved.noteBasic.avatar_url || noteDetail?.avatar_url || '',
          };
        }
      }

      // Tinydata 也没拿到，自动重试一次 fetchNoteBasicFromApi
      if (noteId && (!noteDetail || !noteDetail.author_id)) {
        const retryDetail = await limiter(() => fetchNoteBasicFromApi(noteId));
        if (retryDetail && (retryDetail.author_id || retryDetail.title)) {
          noteDetail = {
            title: retryDetail.title || noteDetail?.title || '',
            author_id: retryDetail.author_id || noteDetail?.author_id || '',
            author_name: retryDetail.author_name || noteDetail?.author_name || '',
            avatar_url: retryDetail.avatar_url || noteDetail?.avatar_url || '',
          };
        }
      }

      if (noteId && !noteDetail) {
        errors.push('无法获取笔记详情，请检查链接是否有效');
      }
      if (noteId && noteDetail && !noteDetail.author_id) {
        errors.push('未获取到博主ID');
      }

      return {
        author_id: noteDetail?.author_id || '',
        author_name: noteDetail?.author_name || '',
        avatar_url: noteDetail?.avatar_url || '',
        duplicate: false,
        errors,
        line_no: index + 1,
        note_id: noteId,
        note_url: resolvedNoteUrl,
        ordered_quantity:
          Number.isInteger(orderedQuantity) && orderedQuantity > 0
            ? orderedQuantity
            : 0,
        raw,
        resolved_note_url: resolvedNoteUrl,
        title: noteDetail?.title || '',
        valid: errors.length === 0,
      };
    }),
  );

  return items;
};

// 规范媒体URL中的转义斜杠字符
const normalizeMediaUrl = (value) =>
  String(value || '').replaceAll('\\u002F', '/').replaceAll('\\/', '/');

// 递归查找对象中第一个匹配的字符串字段
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

// 递归查找对象中第一个匹配的数值字段
const findFirstNumberByKey = (value, keyPattern) => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      const numberValue = Number(entry);
      if (Number.isFinite(numberValue)) {
        return numberValue;
      }
    }

    if (entry && typeof entry === 'object') {
      const childValue = findFirstNumberByKey(entry, keyPattern);
      if (childValue !== null) {
        return childValue;
      }
    }
  }

  return null;
};

// 规范化笔记基本信息响应，提取缓存所需字段
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

// 确保笔记基本信息缓存表及其字段存在（不存在则自动创建）
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

// 确保订单快照和补单相关字段存在（不存在则自动添加）
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
      await ensureColumn('author_id', 'VARCHAR(64) DEFAULT NULL AFTER title');
      await ensureColumn('author_name', 'VARCHAR(255) DEFAULT NULL AFTER author_id');
      await ensureColumn('avatar_url', 'VARCHAR(1024) DEFAULT NULL AFTER author_name');
      await ensureColumn('like_count', 'BIGINT UNSIGNED DEFAULT NULL AFTER avatar_url');
      await ensureColumn('snapshot_current_read_count', 'INT UNSIGNED DEFAULT NULL AFTER reason_message');
      await ensureColumn('snapshot_verified_read_count', 'INT UNSIGNED DEFAULT NULL AFTER snapshot_current_read_count');
      await ensureColumn('snapshot_current_read_payload', 'LONGTEXT DEFAULT NULL AFTER snapshot_verified_read_count');
      await ensureColumn('snapshot_verified_read_payload', 'LONGTEXT DEFAULT NULL AFTER snapshot_current_read_payload');
      await ensureColumn('snapshot_current_like_payload', 'LONGTEXT DEFAULT NULL AFTER snapshot_verified_read_payload');
      await ensureColumn('snapshot_verified_like_count', 'INT UNSIGNED DEFAULT NULL AFTER snapshot_current_like_payload');
      await ensureColumn('snapshot_verified_like_payload', 'LONGTEXT DEFAULT NULL AFTER snapshot_verified_like_count');
      await ensureColumn('repair_count', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER refund_amount_total');
    })();
  }
  return orderSnapshotColumnsReady;
};

// 根据源URL从缓存中读取笔记基本信息
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

// 保存或更新笔记基本信息到缓存表
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

// 确保问题链接记录表存在（不存在则自动创建）
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

// 确保批量链接校验记录表存在（不存在则自动创建）
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

// 确保补单请求记录表存在（不存在则自动创建）
const ensureReplenishmentRecordTable = async (db) => {
  if (!replenishmentRecordTableReady) {
    replenishmentRecordTableReady = (async () => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS order_replenishment_records (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          replenishment_no VARCHAR(48) NOT NULL,
          order_id BIGINT UNSIGNED NOT NULL,
          order_no VARCHAR(40) NOT NULL,
          batch_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
          user_id BIGINT UNSIGNED NOT NULL,
          target_type VARCHAR(32) NOT NULL DEFAULT 'view',
          note_id VARCHAR(64) DEFAULT NULL,
          note_url VARCHAR(1024) DEFAULT NULL,
          original_external_task_id VARCHAR(128) DEFAULT NULL,
          replenishment_external_task_id VARCHAR(128) DEFAULT NULL,
          ordered_quantity INT UNSIGNED NOT NULL DEFAULT 0,
          actual_quantity INT UNSIGNED NOT NULL DEFAULT 0,
          shortage_quantity INT UNSIGNED NOT NULL DEFAULT 0,
          snapshot_before_count INT UNSIGNED DEFAULT NULL,
          snapshot_after_count INT UNSIGNED DEFAULT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'created',
          reason_message VARCHAR(255) DEFAULT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uk_order_replenishment_records_no (replenishment_no),
          KEY idx_order_replenishment_records_order_id (order_id),
          KEY idx_order_replenishment_records_user_created_at (user_id, created_at),
          KEY idx_order_replenishment_records_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const ensureColumn = async (columnName, definition) => {
        const [columns] = await db.execute(
          `
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'order_replenishment_records'
              AND COLUMN_NAME = ?
          `,
          [columnName],
        );
        if (columns.length === 0) {
          await db.execute(`ALTER TABLE order_replenishment_records ADD COLUMN ${columnName} ${definition}`);
        }
      };

      await ensureColumn('requested_at', 'DATETIME DEFAULT NULL AFTER reason_message');
      await ensureColumn('reviewed_at', 'DATETIME DEFAULT NULL AFTER requested_at');
      await ensureColumn('reviewed_by', 'INT UNSIGNED DEFAULT NULL AFTER reviewed_at');
      await ensureColumn('result_json', 'LONGTEXT DEFAULT NULL AFTER reviewed_by');
    })();
  }

  await replenishmentRecordTableReady;
};

// 生成批量预览校验编号
const createCheckBatchNo = () =>
  `CHECK-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

// 保存批量预览的链接校验记录到数据库
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

// 序列化批量链接校验记录供API返回
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

// 查询用户最近的批量链接校验记录
const listBatchLinkCheckRecords = async (userId, { limit = 100 } = {}) => {
  const db = getPool();
  await ensureBatchLinkCheckRecordTable(db);
  const viewAll = await canViewAllAccountRecords(db, userId);

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const userFilter = viewAll ? '' : 'WHERE user_id = ?';
  const userParams = viewAll ? [] : [userId];
  const [rows] = await db.execute(
    `
      SELECT *
      FROM batch_link_check_records
      ${userFilter}
      ORDER BY id DESC
      LIMIT ${safeLimit}
    `,
    userParams,
  );

  return rows.map(serializeBatchLinkCheckRecord);
};

// 序列化批量订单记录及其包含的子订单
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

// 序列化单条订单记录
const serializeBatchOrderItem = (row) => ({
  actual_paid_amount: round4(row.actual_paid_amount),
  author_id: row.author_id || '',
  author_name: row.author_name || '',
  avatar_url: row.avatar_url || '',
  batch_item_id: Number(row.batch_item_id) || 0,
  completed_quantity: Number(row.completed_quantity) || 0,
  created_at: row.created_at,
  external_completed_quantity: Number(row.external_completed_quantity) || 0,
  external_progress: Number(row.external_progress) || 0,
  external_status: row.external_status || '',
  external_task_id: row.external_task_id || '',
  id: Number(row.id),
  like_count: row.like_count === null || row.like_count === undefined ? null : Number(row.like_count),
  note_id: row.note_id || '',
  note_url: row.note_url || '',
  order_no: row.order_no,
  order_status: row.order_status || 'running',
  ordered_quantity: Number(row.ordered_quantity) || 0,
  payable_amount: round4(row.payable_amount),
  reason_message: row.reason_message || '',
  refund_amount: round4(row.refund_amount),
  repair_count: Number(row.repair_count) || 0,
  record_status: row.record_status || '',
  source_note_url: row.source_note_url || row.note_url || '',
  snapshot_current_read_count:
    row.snapshot_current_read_count === null || row.snapshot_current_read_count === undefined
      ? null
      : Number(row.snapshot_current_read_count),
  snapshot_verified_read_count:
    row.snapshot_verified_read_count === null || row.snapshot_verified_read_count === undefined
      ? null
      : Number(row.snapshot_verified_read_count),
  snapshot_verified_like_count:
    row.snapshot_verified_like_count === null || row.snapshot_verified_like_count === undefined
      ? null
      : Number(row.snapshot_verified_like_count),
  target_type: normalizeTargetType(row.target_type),
  title: row.title || '',
  updated_at: row.updated_at,
});

// 序列化批量搜索中匹配到的订单记录
const serializeBatchSearchOrderItem = (row) => ({
  ...serializeBatchOrderItem(row),
  batch_no: row.batch_no || '',
  batch_uuid: row.batch_uuid || '',
  matched_input: row.matched_input || '',
  user_id: Number(row.user_id) || 0,
  username: row.username || '',
});

// 从提交内容构建行号到原始URL的映射
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

// 从上游小红书任务状态同步运行中的订单进度
const syncRunningOrdersFromXhs = async (db, userId, batchIds = []) => {
  await ensureNoteBasicCacheTable(db);
  const batchFilter = batchIds.length > 0
    ? `AND o.batch_id IN (${batchIds.map(() => '?').join(',')})`
    : '';
  const [orders] = await db.execute(
    `
      SELECT o.id, o.batch_id, ob.batch_no, o.external_status, o.external_task_id,
        o.last_verified_at, o.ordered_quantity, o.target_type, o.order_no, o.note_id,
        o.note_url, o.repair_count, o.like_count, o.snapshot_current_read_count, o.snapshot_verified_read_count,
        o.snapshot_verified_like_count,
        nbc.author_id
      FROM orders o
      INNER JOIN order_batches ob ON ob.id = o.batch_id
      LEFT JOIN note_basic_cache nbc ON nbc.note_id = o.note_id
      WHERE o.user_id = ?
        ${batchFilter}
        AND o.order_status = 'running'
        AND o.external_task_id IS NOT NULL
        AND o.external_task_id <> ''
        AND o.reason_message IS NULL
        AND EXISTS (
          SELECT 1
          FROM account_records ar
          WHERE ar.order_id = o.id
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

  const runStatusSync = createAsyncLimiter(getBatchCheckConcurrency());
  await Promise.all(orders.map((order) => runStatusSync(async () => {
    let statusResult = null;
    try {
      const externalTaskId = normalizeXhsTaskId(order.external_task_id);
      if (!externalTaskId) {
        await db.execute(
          `
            UPDATE orders
            SET reason_message = ?,
                updated_at = ?
            WHERE id = ?
              AND user_id = ?
          `,
          [`Invalid XHS task id: ${order.external_task_id}`, now, order.id, userId],
        );
        affectedBatchIds.add(order.batch_id);
        return;
      }

      statusResult = await getXhsTaskClient().getTaskStatus(
        normalizeTargetType(order.target_type),
        externalTaskId,
        {
          token: createCurrentUserToken(userId),
        },
      );
    } catch {
      return;
    }

    if (statusResult?.ok === false || statusResult?.body?.success === false || statusResult?.body?.code === -1) {
      await db.execute(
        `
          UPDATE orders
          SET order_status = 'failed',
              external_status = 'failed',
              external_progress = 0,
              external_completed_quantity = 0,
              completed_quantity = 0,
              reason_message = ?,
              updated_at = ?
          WHERE id = ?
            AND user_id = ?
            AND order_status = 'running'
        `,
        [
          statusResult?.body?.message || `XHS task status request failed with HTTP ${statusResult?.status || 'unknown'}`,
          now,
          order.id,
          userId,
        ],
      );
      affectedBatchIds.add(order.batch_id);
      return;
    }

    const taskStatus = getXhsTaskStatus(statusResult?.body);
    if (![1, 2].includes(taskStatus)) {
      return;
    }
    const totalCount = Math.max(getXhsTaskCount(statusResult?.body, 'total_count'), 0);
    const currentCount = Math.max(getXhsTaskCount(statusResult?.body, 'current_count'), 0);
    const taskFinished = taskStatus === 2;
    const countReached = totalCount > 0 && currentCount >= totalCount;
    const fallbackTotal = Math.max(Number(order.ordered_quantity) || 0, 1);
    const progressTotal = totalCount > 0 ? totalCount : fallbackTotal;
    const orderedQuantity = Number(order.ordered_quantity) || 0;
    const repairedViewBase =
      normalizeTargetType(order.target_type) === 'view' &&
      Number(order.repair_count || 0) > 0 &&
      Number.isFinite(Number(order.snapshot_current_read_count)) &&
      Number.isFinite(Number(order.snapshot_verified_read_count))
        ? Math.max(
            Number(order.snapshot_verified_read_count) - Number(order.snapshot_current_read_count),
            0,
          )
        : 0;
    const supplementalCount = taskFinished || countReached ? totalCount || currentCount : currentCount;
    let completedQuantity = repairedViewBase > 0
      ? Math.min(repairedViewBase + supplementalCount, orderedQuantity || repairedViewBase + supplementalCount)
      : taskFinished || countReached
        ? Math.min(currentCount || orderedQuantity, orderedQuantity)
        : Math.min(
            Math.round(orderedQuantity * Math.max(0, Math.min(currentCount / progressTotal, 1))),
            orderedQuantity || currentCount,
          );
    const progress = orderedQuantity > 0
      ? Math.max(0, Math.min(round4(completedQuantity / orderedQuantity), 1))
      : taskFinished || countReached
        ? 1
        : Math.max(0, Math.min(round4(currentCount / progressTotal), 1));
    const nextExternalStatus = taskFinished ? 'completed' : 'running';
    const verifiedAt = order.last_verified_at ? new Date(order.last_verified_at) : null;
    const canFinalize =
      taskStatus === 2 &&
      order.external_status === 'completed' &&
      verifiedAt &&
      now.getTime() - verifiedAt.getTime() >= 5 * 60 * 1000;
    if (canFinalize && ['like', 'view'].includes(normalizeTargetType(order.target_type))) {
      try {
        const replenishResult = await replenishOrderIfNeeded(db, userId, order, {
          dispatch: false,
          now,
        });
        if (replenishResult.needs_replenish) {
          affectedBatchIds.add(order.batch_id);
          return;
        }
        if (Number.isFinite(replenishResult?.achieved_quantity)) {
          completedQuantity = Math.min(replenishResult.achieved_quantity, orderedQuantity || completedQuantity);
        }
      } catch (error) {
        await db.execute(
          `
            UPDATE orders
            SET reason_message = ?,
                updated_at = ?
            WHERE id = ?
              AND user_id = ?
          `,
          [normalizeXhsErrorMessage(error), now, order.id, userId],
        );
        affectedBatchIds.add(order.batch_id);
        return;
      }
    }
    const nextOrderStatus = canFinalize ? 'completed' : 'running';
    const nextVerifiedAt =
      taskFinished
        ? (order.external_status === 'completed' ? verifiedAt || now : now)
        : null;

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
  })));

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
        COALESCE(SUM(CASE WHEN order_status IN ('running', 'repair_review') THEN 1 ELSE 0 END), 0) AS processing_count,
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

// 获取批量订单记录列表，并刷新运行中订单的状态
const listBatchOrderRecords = async (userId, query = {}) => {
  const { limit = 30, page, page_size: pageSize } = query;
  const db = getPool();
  await ensureOrderSnapshotColumns(db);
  await ensureNoteBasicCacheTable(db);
  await refundFailedChargedOrders(db, userId);
  const viewAll = await canViewAllAccountRecords(db, userId);
  const skipStatusSync =
    query.skip_status_sync === '1' ||
    query.skip_status_sync === 1 ||
    query.skip_status_sync === true ||
    query.skip_status_sync === 'true';
  const paginationRequested = page !== undefined || pageSize !== undefined;
  const safePage = Math.max(Number(page) || 1, 1);
  const safeLimit = Math.min(Math.max(Number(pageSize || limit) || 10, 1), 100);
  const offset = (safePage - 1) * safeLimit;
  const userFilter = viewAll ? '' : 'WHERE user_id = ?';
  const userParams = viewAll ? [] : [userId];
  const [[countRow]] = await db.execute(
    `
      SELECT COUNT(*) AS total
      FROM order_batches
      ${userFilter}
    `,
    userParams,
  );
  let [batches] = await db.execute(
    `
      SELECT *
      FROM order_batches
      ${userFilter}
      ORDER BY id DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    userParams,
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
    if (viewAll) {
      const ownerIds = [...new Set(batches.map((b) => b.user_id))];
      for (const ownerId of ownerIds) {
        const ownerBatchIds = batches.filter((b) => Number(b.user_id) === Number(ownerId)).map((b) => b.id);
        await syncRunningOrdersFromXhs(db, ownerId, ownerBatchIds);
        await refundFailedChargedOrders(db, ownerId);
      }
    } else {
      await syncRunningOrdersFromXhs(db, userId, batchIds);
      await refundFailedChargedOrders(db, userId);
    }
  }
  if (viewAll) {
    const ownerIds = [...new Set(batches.map((b) => b.user_id))];
    for (const ownerId of ownerIds) {
      const ownerBatchIds = batches.filter((b) => Number(b.user_id) === Number(ownerId)).map((b) => b.id);
      await refreshBatchStats(db, ownerId, ownerBatchIds);
    }
  } else {
    await refreshBatchStats(db, userId, batchIds);
  }
  [batches] = await db.execute(
    `
      SELECT *
      FROM order_batches
      ${userFilter}
      ORDER BY id DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
    userParams,
  );

  // 查询每个批次的订单状态汇总，用于前端显示批次状态标签
  const batchIdPlaceholders = batchIds.map(() => '?').join(',');
  const [orderStatusRows] = await db.execute(
    `SELECT batch_id, order_status, COUNT(1) AS cnt
     FROM orders
     WHERE batch_id IN (${batchIdPlaceholders})
     GROUP BY batch_id, order_status`,
    batchIds,
  );
  const batchOrderStatusMap = {};
  for (const row of orderStatusRows) {
    if (!batchOrderStatusMap[row.batch_id]) batchOrderStatusMap[row.batch_id] = {};
    batchOrderStatusMap[row.batch_id][row.order_status] = Number(row.cnt) || 0;
  }

  const items = batches.map((batch) => ({
    ...serializeBatchOrderRecord(batch, []),
    order_status_summary: batchOrderStatusMap[batch.id] || {},
  }));

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

const getBatchOrders = async (userId, batchId) => {
  const db = getPool();
  await ensureOrderSnapshotColumns(db);
  await ensureNoteBasicCacheTable(db);
  const viewAll = await canViewAllAccountRecords(db, userId);

  const [[batch]] = await db.execute(
    'SELECT * FROM order_batches WHERE id = ? LIMIT 1',
    [batchId],
  );
  if (!batch || (!viewAll && Number(batch.user_id) !== Number(userId))) {
    const error = new Error('Batch not found');
    error.statusCode = 404;
    throw error;
  }

  const [orders] = await db.execute(
    `
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
      LEFT JOIN (
        SELECT
          order_id,
          SUM(actual_paid_amount) AS actual_paid_amount,
          SUM(payable_amount) AS payable_amount,
          SUM(refund_amount) AS refund_amount,
          MAX(status) AS status
        FROM account_records
        WHERE record_type = 'order_charge'
        GROUP BY order_id
      ) ar ON ar.order_id = o.id
      LEFT JOIN (
        SELECT
          note_id,
          MAX(title) AS title,
          MAX(author_name) AS author_name,
          MAX(avatar_url) AS avatar_url
        FROM note_basic_cache
        GROUP BY note_id
      ) nbc ON nbc.note_id = o.note_id
      WHERE o.batch_id = ?
      ORDER BY o.batch_item_id ASC, o.id ASC
    `,
    [batchId],
  );

  const rawUrlMap = buildRawUrlMap(batch.raw_content);
  return orders.map((order) => {
    order.source_note_url = rawUrlMap?.get(Number(order.batch_item_id)) || order.note_url;
    return serializeBatchOrderItem(order);
  });
};

// 通过批量输入的链接搜索匹配的订单
const searchBatchOrdersByLinks = async (userId, params = {}) => {
  const db = getPool();
  await ensureOrderSnapshotColumns(db);
  await ensureNoteBasicCacheTable(db);
  const parsedLinks = parseBatchSearchLinks(params.content);
  const validLinks = parsedLinks.filter((item) => item.valid);
  if (validLinks.length === 0) {
    return {
      invalid_count: parsedLinks.length,
      items: [],
      links: parsedLinks,
      matched_count: 0,
      total_count: parsedLinks.length,
    };
  }

  const viewAll = await canViewAllAccountRecords(db, userId);
  const urls = [...new Set(validLinks.map((item) => item.note_url).filter(Boolean))];
  const linkWhere = [];
  const filters = [];
  const queryParams = [];

  if (urls.length > 0) {
    linkWhere.push(`o.note_url IN (${urls.map(() => '?').join(',')})`);
    queryParams.push(...urls);
    for (const url of urls) {
      linkWhere.push('ob.raw_content LIKE ?');
      queryParams.push(`%${url}%`);
    }
  }

  const startDate = String(params.start_date || '').trim();
  const endDate = String(params.end_date || '').trim();
  if (startDate) {
    filters.push('o.created_at >= ?');
    queryParams.push(/^\d{4}-\d{2}-\d{2}$/.test(startDate) ? `${startDate} 00:00:00` : startDate);
  }
  if (endDate) {
    filters.push('o.created_at <= ?');
    queryParams.push(/^\d{4}-\d{2}-\d{2}$/.test(endDate) ? `${endDate} 23:59:59` : endDate);
  }
  if (!viewAll) {
    filters.push('o.user_id = ?');
    queryParams.push(userId);
  }
  const filterSql = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';

  const [rows] = await db.execute(
    `
      SELECT
        o.*,
        ob.batch_no,
        ob.batch_id AS batch_uuid,
        ob.raw_content,
        ar.actual_paid_amount,
        ar.payable_amount,
        ar.refund_amount,
        ar.status AS record_status,
        u.username,
        nbc.title AS cache_title,
        nbc.author_name AS cache_author_name,
        nbc.avatar_url AS cache_avatar_url
      FROM orders o
      INNER JOIN order_batches ob ON ob.id = o.batch_id
      LEFT JOIN (
        SELECT
          order_id,
          SUM(actual_paid_amount) AS actual_paid_amount,
          SUM(payable_amount) AS payable_amount,
          SUM(refund_amount) AS refund_amount,
          MAX(status) AS status
        FROM account_records
        WHERE record_type = 'order_charge'
        GROUP BY order_id
      ) ar ON ar.order_id = o.id
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN note_basic_cache nbc ON nbc.note_id = o.note_id
      WHERE (${linkWhere.join(' OR ')})
        ${filterSql}
      ORDER BY o.id DESC
      LIMIT 500
    `,
    queryParams,
  );

  const resultRows = rows.flatMap((row) => {
    const rawUrlMap = buildRawUrlMap(row.raw_content);
    const sourceUrl = rawUrlMap.get(Number(row.batch_item_id)) || row.note_url;
    const matchedLink =
      validLinks.find((item) => item.note_url === row.note_url || item.note_url === sourceUrl) ||
      null;
    if (!matchedLink) {
      return [];
    }
    return [serializeBatchSearchOrderItem({
      ...row,
      author_name: row.author_name || row.cache_author_name,
      avatar_url: row.avatar_url || row.cache_avatar_url,
      matched_input: matchedLink?.raw || '',
      source_note_url: sourceUrl,
      title: row.title || row.cache_title,
    })];
  });

  return {
    invalid_count: parsedLinks.filter((item) => !item.valid).length,
    items: resultRows,
    links: parsedLinks,
    matched_count: resultRows.length,
    total_count: parsedLinks.length,
  };
};

// 序列化账户消费记录
const serializeConsumptionRecord = (row) => ({
  actual_paid_amount: round4(row.actual_paid_amount),
  after_available_amount: round4(row.after_available_amount),
  batch_id: Number(row.batch_id) || 0,
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

// 获取账户消费记录列表及汇总统计（支出/收入/退款/净额）
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
        o.external_status,
        o.repair_count,
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
  const batchGroups = new Map();
  for (const row of rows) {
    // order_charge 和 refund 都按 batch_id 合并
    const canGroup = (row.record_type === 'order_charge' || row.record_type === 'refund') && row.batch_id;
    if (!canGroup) {
      groupedRows.push(row);
      continue;
    }

    const key = `${row.record_type}-${row.batch_id}`;
    const group = batchGroups.get(key);
    if (!group) {
      const nextGroup = {
        ...row,
        _rows: [row],
      };
      batchGroups.set(key, nextGroup);
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
      const uniqueOrders = [...new Map(sortedRows.map((r) => [Number(r.order_id), r])).values()];
      const firstRow = sortedRows[0];
      const lastRow = sortedRows.at(-1);
      return {
        ...lastRow,
        _isGrouped: true,
        actual_paid_amount: sortedRows.reduce(
          (total, item) => total + (Number(item.actual_paid_amount) || 0),
          0,
        ),
        after_available_amount: lastRow.after_available_amount,
        before_available_amount: firstRow.before_available_amount,
        completed_quantity: uniqueOrders.reduce(
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
        order_items: (() => {
          const byOrder = new Map();
          for (const item of sortedRows) {
            const oid = Number(item.order_id);
            const existing = byOrder.get(oid);
            if (!existing) {
              byOrder.set(oid, {
                actual_paid_amount: Number(item.actual_paid_amount) || 0,
                order_id: oid,
                order_no: item.order_no,
                order_status: item.order_status || 'running',
                external_status: item.external_status || '',
                ordered_quantity: Number(item.ordered_quantity) || 0,
                repair_count: Number(item.repair_count) || 0,
                refund_amount: Number(item.refund_amount_total ?? item.refund_amount) || 0,
                refund_requested_at: item.refund_requested_at || null,
                refunded_quantity: Number(item.order_refunded_quantity ?? item.refunded_quantity) || 0,
              });
            } else {
              existing.actual_paid_amount += Number(item.actual_paid_amount) || 0;
              existing.refund_amount += Number(item.refund_amount_total ?? item.refund_amount) || 0;
            }
          }
          return [...byOrder.values()].map((e) => ({
            ...e,
            actual_paid_amount: round4(e.actual_paid_amount),
            refund_amount: round4(e.refund_amount),
          }));
        })(),
        order_no: row.batch_no || lastRow.order_no,
        order_status: sortedRows.some((item) =>
          ['refund_requested', 'refund_calculating'].includes(item.order_status),
        )
          ? 'refund_requested'
          : lastRow.order_status,
        ordered_quantity: uniqueOrders.reduce(
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
        reason_message: row.record_type === 'refund'
          ? `批量退款（${uniqueOrders.length}条）`
          : `批量下单扣费（${uniqueOrders.length}条）`,
        record_no: row.batch_no || lastRow.record_no,
        refund_amount: sortedRows.reduce(
          (total, item) => total + (Number(item.refund_amount) || 0),
          0,
        ),
        refunded_quantity: uniqueOrders.reduce(
          (total, item) => total + (Number(item.refunded_quantity) || 0),
          0,
        ),
      };
    })
    .sort((a, b) => Number(b.id) - Number(a.id));

  // 链式修正：每行的 before = 下一行的 after，保证余额变化连续
  // 分组行额外重算 after = before + net_amount，避免夹杂操作导致金额与余额对不上
  for (let i = items.length - 2; i >= 0; i--) {
    const nextRow = items[i + 1];
    items[i].before_available_amount = nextRow.after_available_amount;
    if (items[i]._isGrouped) {
      items[i].after_available_amount = round4(
        Number(items[i].before_available_amount) + (Number(items[i].net_amount) || 0),
      );
    }
  }

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

// 用户发起单条订单的退款请求
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

  await cancelPendingReplenishments(db, targetOrderId);

  const externalTaskId = normalizeXhsTaskId(order.external_task_id);
  if (externalTaskId) {
    await getXhsTaskClient().updateTaskStatus(
      normalizeTargetType(order.target_type),
      {
        id: Number(externalTaskId),
        reason: `goodsAdmin:order=${order.order_no} refund requested`,
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

// 批量退款：对指定批次中所有可退款订单发起退款请求
const requestBatchRefund = async (userId, batchId) => {
  const db = getPool();
  const targetBatchId = Number(batchId);
  if (!targetBatchId) {
    const error = new Error('Invalid batch id');
    error.statusCode = 400;
    throw error;
  }

  const viewAll = await canViewAllAccountRecords(db, userId);
  const [[batch]] = await db.execute(
    'SELECT id, batch_no, user_id FROM order_batches WHERE id = ? LIMIT 1',
    [targetBatchId],
  );
  if (!batch || (!viewAll && Number(batch.user_id) !== Number(userId))) {
    const error = new Error('Batch not found');
    error.statusCode = 404;
    throw error;
  }

  const blockedStatuses = ['failed', 'refund_approved', 'refund_calculating', 'refund_rejected', 'refund_requested', 'stopping'];
  const [orders] = await db.execute(
    `SELECT id, user_id, order_no, order_status, external_task_id, target_type
     FROM orders
     WHERE batch_id = ?
     ORDER BY batch_item_id ASC, id ASC`,
    [targetBatchId],
  );

  const eligible = orders.filter((o) => !blockedStatuses.includes(o.order_status));
  if (eligible.length === 0) {
    const error = new Error('该批次没有可退款的订单');
    error.statusCode = 400;
    throw error;
  }

  const now = new Date();
  const refundCalcAfter = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const results = [];

  {
    const settled = await Promise.allSettled(
      eligible.map(async (order) => {
        await cancelPendingReplenishments(db, order.id);

        const externalTaskId = normalizeXhsTaskId(order.external_task_id);
        if (externalTaskId) {
          await getXhsTaskClient().updateTaskStatus(
            normalizeTargetType(order.target_type),
            {
              id: Number(externalTaskId),
              reason: `goodsAdmin:order=${order.order_no} batch refund requested`,
              status: 3,
            },
            { token: createCurrentUserToken(order.user_id) },
          );
        }

        await db.execute(
          `UPDATE orders
           SET order_status = 'refund_requested',
               refund_requested_at = ?,
               stop_requested_at = ?,
               refund_calc_after_at = ?,
               updated_at = ?
           WHERE id = ?`,
          [now, now, refundCalcAfter, now, order.id],
        );

        return { order_id: order.id, order_no: order.order_no, status: 'success' };
      }),
    );
    for (let j = 0; j < settled.length; j++) {
      if (settled[j].status === 'fulfilled') {
        results.push(settled[j].value);
      } else {
        results.push({ order_id: eligible[j].id, order_no: eligible[j].order_no, status: 'failed', message: settled[j].reason?.message || 'unknown error' });
      }
    }
  }

  return {
    batch_id: targetBatchId,
    batch_no: batch.batch_no,
    total_count: orders.length,
    eligible_count: eligible.length,
    success_count: results.filter((r) => r.status === 'success').length,
    failed_count: results.filter((r) => r.status === 'failed').length,
    results,
  };
};

// 审核退款请求，更新订单状态和账户余额
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

  await ensureReplenishmentRecordTable(db);
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
      let nextStatus = 'running';
      let nextReason = reason || '退款审核拒绝，继续处理';
      let completedQuantityAfterReject = null;
      let replenishmentRequest = null;

      if (['like', 'view'].includes(normalizeTargetType(order.target_type))) {
        try {
          const checkResult = await replenishOrderIfNeeded(connection, order.user_id, order, {
            dispatch: false,
            now,
          });
          if (checkResult?.needs_replenish) {
            nextStatus = 'repair_review';
            nextReason = `退款被拒绝后复查未完成，需补单 ${checkResult.replenish_quantity}`;
            const [[checkedOrder]] = await connection.execute(
              'SELECT * FROM orders WHERE id = ? LIMIT 1',
              [targetOrderId],
            );
            replenishmentRequest = await createPendingReplenishmentForOrder(
              connection,
              {
                ...order,
                ...checkedOrder,
                completed_quantity: checkResult.achieved_quantity,
                external_completed_quantity: checkResult.achieved_quantity,
                reason_message: nextReason,
              },
              nextReason,
              now,
            );
          } else if (
            checkResult?.checked &&
            Number(checkResult.replenish_quantity) === 0 &&
            Number.isFinite(Number(checkResult.achieved_quantity))
          ) {
            nextStatus = 'completed';
            const orderedQuantity = Math.max(Number(order.ordered_quantity) || 0, 0);
            completedQuantityAfterReject = Math.min(
              Math.max(Number(checkResult.achieved_quantity) || 0, 0),
              orderedQuantity,
            );
          }
        } catch (error) {
          nextReason = `${nextReason}; 补单复查失败: ${normalizeXhsErrorMessage(error)}`;
        }
      }

      if (nextStatus === 'completed') {
        await connection.execute(
          `
            UPDATE orders
            SET order_status = 'completed',
                external_status = 'completed',
                external_progress = 1,
                external_completed_quantity = ?,
                completed_quantity = ?,
                reason_message = ?,
                updated_at = ?
            WHERE id = ?
          `,
          [
            completedQuantityAfterReject,
            completedQuantityAfterReject,
            nextReason,
            now,
            targetOrderId,
          ],
        );
      } else if (nextStatus === 'running') {
        await connection.execute(
          `
            UPDATE orders
            SET order_status = 'running',
                reason_message = ?,
                updated_at = ?
            WHERE id = ?
          `,
          [nextReason, now, targetOrderId],
        );
      } else {
        await connection.execute(
          `
            UPDATE orders
            SET reason_message = ?,
                updated_at = ?
            WHERE id = ?
          `,
          [nextReason, now, targetOrderId],
        );
      }
      await connection.commit();
      return {
        order_id: targetOrderId,
        order_no: order.order_no,
        order_status: nextStatus,
        replenishment_request_id: replenishmentRequest?.id || null,
        refunded_amount: 0,
      };
    }

    const [chargeRecords] = await connection.execute(
      `
        SELECT *
        FROM account_records
        WHERE order_id = ? AND record_type = 'order_charge' AND status = 'success'
        ORDER BY id ASC
        FOR UPDATE
      `,
      [targetOrderId],
    );

    if (!chargeRecords.length) {
      const error = new Error('Charge record not found');
      error.statusCode = 404;
      throw error;
    }

    const chargeRecord = chargeRecords[0];
    const paidAmount = chargeRecords.reduce(
      (sum, cr) => sum + (Number(cr.actual_paid_amount) || 0), 0,
    );
    const refundedAmount = Number(order.refund_amount_total) || 0;
    const orderedQuantity = Math.max(Number(order.ordered_quantity) || 0, 0);
    let completedQuantity = Math.max(
      Number(order.external_completed_quantity) || 0,
      Number(order.completed_quantity) || 0,
    );
    const targetType = normalizeTargetType(order.target_type);
    const isMeasurableOrder = ['like', 'view'].includes(targetType);
    let actualChecked = false;

    if (isMeasurableOrder) {
      try {
        const actualResult = await replenishOrderIfNeeded(connection, order.user_id, order, {
          dispatch: false,
          now,
        });
        if (Number.isFinite(Number(actualResult?.achieved_quantity))) {
          completedQuantity = Math.min(Number(actualResult.achieved_quantity), orderedQuantity);
          actualChecked = true;
        }
      } catch {
        // Keep locally synced progress if the actual count check is unavailable during review.
      }
    }

    const externalTaskId = normalizeXhsTaskId(order.external_task_id);
    if (externalTaskId) {
      try {
        const statusResult = await getXhsTaskClient().getTaskStatus(
          targetType,
          externalTaskId,
          {
            token: createCurrentUserToken(order.user_id),
          },
        );
        const taskStatus = getXhsTaskStatus(statusResult?.body);
        const upstreamCurrentCount = getXhsTaskCount(statusResult?.body, 'current_count');
        if (taskStatus === 2 && !actualChecked) {
          completedQuantity = Math.min(upstreamCurrentCount || orderedQuantity, orderedQuantity);
        } else if (taskStatus === 1 && !actualChecked) {
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
      const noRefundReason = 'No refundable amount';
      await connection.execute(
        `
          UPDATE orders
          SET order_status = 'refund_rejected',
              completed_quantity = ?,
              external_completed_quantity = ?,
              reason_message = ?,
              updated_at = ?
          WHERE id = ?
        `,
        [
          completedQuantity,
          completedQuantity,
          noRefundReason,
          now,
          targetOrderId,
        ],
      );
      await connection.commit();
      return {
        order_id: targetOrderId,
        order_no: order.order_no,
        order_status: 'refund_rejected',
        refunded_amount: 0,
        reason_message: noRefundReason,
      };
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
    await cancelPendingReplenishments(connection, targetOrderId);
    await connection.execute(
      'UPDATE balance_accounts SET available_amount = ?, updated_at = ? WHERE user_id = ?',
      [afterBalance, now, order.user_id],
    );

    await connection.commit();

    // 退款通过后停止上游任务
    if (normalizeXhsTaskId(order.external_task_id)) {
      try {
        await stopXhsTask({
          reason: '退款审核通过',
          taskId: order.external_task_id,
          targetType: order.target_type,
          userId: order.user_id,
        });
      } catch {
        // 停止失败不影响退款结果
      }
    }

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

const batchApproveRefunds = async (actorUserId, { batch_no, order_ids } = {}) => {
  const db = getPool();
  const isAdmin = await canViewAllAccountRecords(db, actorUserId);
  if (!isAdmin) {
    const error = new Error('无权操作');
    error.statusCode = 403;
    throw error;
  }

  const conditions = [
    "o.order_status IN ('refund_requested', 'refund_calculating', 'stopping')",
  ];
  const params = [];
  let needJoin = false;

  if (batch_no) {
    needJoin = true;
    conditions.push('ob.batch_no = ?');
    params.push(batch_no);
  } else if (Array.isArray(order_ids) && order_ids.length > 0) {
    const ids = order_ids.map(Number).filter(Boolean);
    if (ids.length === 0) {
      const error = new Error('无有效的订单ID');
      error.statusCode = 400;
      throw error;
    }
    conditions.push(`o.id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  } else {
    const error = new Error('请提供 batch_no 或 order_ids');
    error.statusCode = 400;
    throw error;
  }

  const joinSql = needJoin ? 'INNER JOIN order_batches ob ON ob.id = o.batch_id' : '';

  // 单事务批量处理，避免逐条锁行
  const connection = await db.getConnection();
  const now = new Date();
  try {
    await connection.beginTransaction();

    // 1. 一次性锁定所有待退款订单
    const [orders] = await connection.execute(
      `SELECT o.* FROM orders o ${joinSql} WHERE ${conditions.join(' AND ')} ORDER BY o.id ASC FOR UPDATE`,
      params,
    );

    if (orders.length === 0) {
      await connection.commit();
      return { total: 0, succeeded: 0, failed: 0, results: [] };
    }

    // 2. 一次性查出所有扣费记录
    const orderIds = orders.map((o) => o.id);
    const [chargeRecords] = await connection.execute(
      `SELECT * FROM account_records
       WHERE order_id IN (${orderIds.map(() => '?').join(',')})
         AND record_type = 'order_charge' AND status = 'success'
       ORDER BY order_id ASC, id ASC
       FOR UPDATE`,
      orderIds,
    );
    const chargeByOrder = new Map();
    for (const cr of chargeRecords) {
      const existing = chargeByOrder.get(cr.order_id);
      if (!existing) {
        chargeByOrder.set(cr.order_id, {
          ...cr,
          total_paid_amount: Number(cr.actual_paid_amount) || 0,
        });
      } else {
        existing.total_paid_amount = round4(
          existing.total_paid_amount + (Number(cr.actual_paid_amount) || 0),
        );
      }
    }

    // 3. 按 user_id 分组锁定余额
    const userIds = [...new Set(orders.map((o) => Number(o.user_id)))];
    const [balanceRows] = await connection.execute(
      `SELECT * FROM balance_accounts WHERE user_id IN (${userIds.map(() => '?').join(',')}) FOR UPDATE`,
      userIds,
    );
    const balanceMap = new Map();
    for (const b of balanceRows) {
      balanceMap.set(Number(b.user_id), round4(b.available_amount));
    }

    // 4. 并发查询上游真实完成量（事务外，避免长锁）
    const upstreamProgress = new Map();
    const progressResults = await Promise.allSettled(
      orders.map(async (order) => {
        const orderedQty = Math.max(Number(order.ordered_quantity) || 0, 0);
        let best = Math.max(
          Number(order.external_completed_quantity) || 0,
          Number(order.completed_quantity) || 0,
          0,
        );

        const taskId = normalizeXhsTaskId(order.external_task_id);
        if (taskId) {
          try {
            const statusResult = await getXhsTaskClient().getTaskStatus(
              normalizeTargetType(order.target_type),
              taskId,
              { token: createCurrentUserToken(order.user_id) },
            );
            const upstreamCount = getXhsTaskCount(statusResult?.body, 'current_count');
            if (Number.isFinite(upstreamCount) && upstreamCount > 0) {
              best = Math.max(best, upstreamCount);
            }
          } catch {
            // 查不到就用本地数据
          }
        }
        return { orderId: order.id, completedQuantity: Math.min(best, orderedQty) };
      }),
    );
    for (const r of progressResults) {
      if (r.status === 'fulfilled') {
        upstreamProgress.set(r.value.orderId, r.value.completedQuantity);
      }
    }

    // 5. 逐条计算退款金额并收集结果
    const results = [];
    let succeeded = 0;
    let failed = 0;
    const refundInserts = [];
    const orderUpdates = [];
    const userRefundTotals = new Map();

    for (const order of orders) {
      const charge = chargeByOrder.get(order.id);
      if (!charge) {
        results.push({ order_id: order.id, order_no: order.order_no, success: false, error: '扣费记录未找到' });
        failed++;
        continue;
      }

      const paidAmount = Number(charge.total_paid_amount) || 0;
      const refundedAmount = Number(order.refund_amount_total) || 0;
      const orderedQuantity = Math.max(Number(order.ordered_quantity) || 0, 0);
      const completedQuantity = upstreamProgress.get(order.id) ?? Math.min(
        Math.max(Number(order.external_completed_quantity) || 0, Number(order.completed_quantity) || 0, 0),
        orderedQuantity,
      );
      const refundableQuantity = Math.max(orderedQuantity - completedQuantity, 0);
      const grossRefundAmount = orderedQuantity > 0 ? round4((paidAmount * refundableQuantity) / orderedQuantity) : 0;
      const refundAmount = round4(Math.max(grossRefundAmount - refundedAmount, 0));

      if (refundAmount <= 0) {
        orderUpdates.push({
          id: order.id,
          status: 'refund_rejected',
          completedQuantity,
          refundableQuantity: 0,
          refundAmount: 0,
          reason: 'No refundable amount',
        });
        results.push({ order_id: order.id, order_no: order.order_no, success: true, refunded_amount: 0, order_status: 'refund_rejected' });
        succeeded++;
        continue;
      }

      const userId = Number(order.user_id);
      const prevTotal = userRefundTotals.get(userId) || 0;
      userRefundTotals.set(userId, round4(prevTotal + refundAmount));

      const beforeBalance = round4((balanceMap.get(userId) || 0) + prevTotal);
      const afterBalance = round4(beforeBalance + refundAmount);
      const recordNo = `REFUND-${Date.now()}-${String(order.id).padStart(3, '0')}`;

      refundInserts.push([
        recordNo, userId, order.id, order.order_no, charge.id,
        order.ordered_quantity, completedQuantity, refundableQuantity,
        charge.discounted_unit_price, refundAmount, charge.discount_rate,
        charge.discounted_unit_price, refundAmount, refundAmount, refundAmount,
        beforeBalance, afterBalance, now, now,
      ]);

      orderUpdates.push({
        id: order.id,
        status: 'refund_approved',
        completedQuantity,
        refundableQuantity,
        refundAmount,
        reason: '批量退款审核通过',
      });

      results.push({ order_id: order.id, order_no: order.order_no, success: true, refunded_amount: refundAmount, order_status: 'refund_approved' });
      succeeded++;
    }

    // 5. 批量插入退款流水
    for (const values of refundInserts) {
      await connection.execute(
        `INSERT INTO account_records
          (record_no, user_id, record_type, direction, order_id, order_no,
           related_record_id, status, ordered_quantity, completed_quantity, refunded_quantity,
           original_unit_price, original_total_amount, discount_rate, discounted_unit_price,
           discount_amount, payable_amount, actual_paid_amount, refund_amount, net_amount,
           before_available_amount, after_available_amount, reason_message, remark, created_at, updated_at)
         VALUES (?, ?, 'refund', 'credit', ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, '退款审核通过', '', ?, ?)`,
        values,
      );
    }

    // 6. 批量更新订单状态
    for (const upd of orderUpdates) {
      await connection.execute(
        `UPDATE orders
         SET order_status = ?,
             completed_quantity = ?,
             external_completed_quantity = ?,
             refunded_quantity = refunded_quantity + ?,
             refund_amount_total = refund_amount_total + ?,
             reason_message = ?,
             updated_at = ?
         WHERE id = ?`,
        [upd.status, upd.completedQuantity, upd.completedQuantity, upd.refundableQuantity, upd.refundAmount, upd.reason, now, upd.id],
      );
    }

    // 7. 取消待补单请求
    for (const oid of orderIds) {
      await cancelPendingReplenishments(connection, oid);
    }

    // 8. 一次性更新每个用户余额
    for (const [userId, totalRefund] of userRefundTotals) {
      await connection.execute(
        'UPDATE balance_accounts SET available_amount = available_amount + ?, updated_at = ? WHERE user_id = ?',
        [totalRefund, now, userId],
      );
    }

    await connection.commit();

    // 9. 退款通过后全量并发停止上游任务，失败的重试一次
    const approvedSet = new Set(orderUpdates.filter((u) => u.status === 'refund_approved').map((u) => u.id));
    const ordersToStop = orders.filter((o) => normalizeXhsTaskId(o.external_task_id) && approvedSet.has(o.id));
    const firstResults = await Promise.allSettled(
      ordersToStop.map((o) =>
        stopXhsTask({
          reason: '批量退款审核通过',
          taskId: o.external_task_id,
          targetType: o.target_type,
          userId: o.user_id,
        }),
      ),
    );
    const retryOrders = ordersToStop.filter((_, i) => firstResults[i].status === 'rejected');
    let failedOrders = [];
    if (retryOrders.length > 0) {
      const retryResults = await Promise.allSettled(
        retryOrders.map((o) =>
          stopXhsTask({
            reason: '批量退款审核通过(重试)',
            taskId: o.external_task_id,
            targetType: o.target_type,
            userId: o.user_id,
          }),
        ),
      );
      failedOrders = retryOrders.filter((_, i) => retryResults[i].status === 'rejected');
    }

    // 10. 二次失败的撤回退款
    if (failedOrders.length > 0) {
      const updMap = new Map(orderUpdates.map((u) => [u.id, u]));

      const rollConn = await db.getConnection();
      try {
        await rollConn.beginTransaction();
        const rollbackUserTotals = new Map();

        for (const order of failedOrders) {
          const upd = updMap.get(order.id);
          if (!upd || upd.refundAmount <= 0) continue;

          const refundAmount = upd.refundAmount;

          const userId = Number(order.user_id);
          const prev = rollbackUserTotals.get(userId) || 0;
          rollbackUserTotals.set(userId, round4(prev + refundAmount));

          await rollConn.execute(
            `UPDATE orders
             SET order_status = 'refund_rejected',
                 refund_amount_total = GREATEST(refund_amount_total - ?, 0),
                 reason_message = '退款拒绝：上游停止失败',
                 updated_at = ?
             WHERE id = ?`,
            [refundAmount, now, order.id],
          );

          // Mark the refund record as reversed
          await rollConn.execute(
            `UPDATE account_records
             SET status = 'reversed', remark = '上游停止失败，退款撤回'
             WHERE order_id = ? AND record_type = 'refund' AND status = 'success'
             ORDER BY id DESC LIMIT 1`,
            [order.id],
          );

          // Update results
          const resultEntry = results.find((r) => r.order_id === order.id);
          if (resultEntry) {
            resultEntry.success = false;
            resultEntry.order_status = 'refund_rejected';
            resultEntry.error = '上游停止失败';
            succeeded--;
            failed++;
          }
        }

        // Deduct refund amounts back from balances
        for (const [userId, totalRollback] of rollbackUserTotals) {
          await rollConn.execute(
            'UPDATE balance_accounts SET available_amount = available_amount - ?, updated_at = ? WHERE user_id = ?',
            [totalRollback, now, userId],
          );
        }

        await rollConn.commit();
      } catch {
        await rollConn.rollback();
      } finally {
        rollConn.release();
      }
    }

    return { total: orders.length, succeeded, failed, results };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

// 序列化退款记录
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

// 获取退款记录列表及汇总统计
const listRefundRecords = async (userId, query = {}) => {
  const db = getPool();
  await ensureNoteBasicCacheTable(db);
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
    LEFT JOIN (
      SELECT
        note_id,
        MAX(title) AS title,
        MAX(author_name) AS author_name,
        MAX(avatar_url) AS avatar_url
      FROM note_basic_cache
      GROUP BY note_id
    ) nbc ON nbc.note_id = o.note_id
    LEFT JOIN (
      SELECT
        order_id,
        SUM(actual_paid_amount) AS actual_paid_amount,
        SUM(payable_amount) AS payable_amount,
        SUM(refund_amount) AS refund_amount,
        MAX(status) AS status
      FROM account_records
      WHERE record_type = 'order_charge'
      GROUP BY order_id
    ) ar ON ar.order_id = o.id
    LEFT JOIN (
      SELECT order_id, MAX(id) AS refund_record_id
      FROM account_records
      WHERE record_type = 'refund'
      GROUP BY order_id
    ) latest_refund ON latest_refund.order_id = o.id
    LEFT JOIN account_records rr ON rr.id = latest_refund.refund_record_id
    WHERE ${where.join(' AND ')}
  `;

  const [[countRow]] = await db.execute(`SELECT COUNT(DISTINCT o.id) AS total ${fromSql}`, params);
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

// 序列化问题链接记录
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

// 保存已确认的问题链接记录到数据库
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

// 查询用户最近的问题链接记录
const listProblemLinkRecords = async (userId, { limit = 100 } = {}) => {
  const db = getPool();
  await ensureProblemLinkRecordTable(db);
  const viewAll = await canViewAllAccountRecords(db, userId);

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const userFilter = viewAll ? '' : 'WHERE user_id = ?';
  const userParams = viewAll ? [] : [userId];
  const [rows] = await db.execute(
    `
      SELECT *
      FROM batch_problem_link_records
      ${userFilter}
      ORDER BY id DESC
      LIMIT ${safeLimit}
    `,
    userParams,
  );

  return rows.map(serializeProblemLinkRecord);
};

// 从预览数据构建本地笔记基本信息对象
const createPreviewNoteBasic = (item = {}, fallbackUrl = '') => {
  const noteId = String(item.note_id || '').trim();
  if (!noteId) {
    return null;
  }
  const noteUrl =
    String(item.resolved_note_url || item.note_url || item.normalized_url || item.raw_url || '').trim() ||
    (noteId.length >= 8 ? `https://www.xiaohongshu.com/explore/${noteId}` : fallbackUrl);

  return {
    author_id: String(item.author_id || item.user_id || '').trim(),
    author_name: String(item.author_name || item.user_name || item.nickname || '').trim(),
    avatar_url: normalizeMediaUrl(item.avatar_url || item.avatar || item.image || ''),
    note_id: noteId,
    note_url: noteUrl || fallbackUrl,
    title: String(item.title || item.note_title || item.desc || '').trim(),
  };
};

// 兼容旧版的笔记基本信息解析器（通过本地预览管道解析）
const requestNoteBasic = async (params = {}) => {
  const noteId = String(params.note_id || '').trim();
  const sourceUrl = String(params.url || params.link || params.note_url || params.share_url || '').trim();
  if (noteId) {
    return {
      noteBasic: createPreviewNoteBasic({ note_id: noteId, note_url: sourceUrl }, sourceUrl),
      payload: null,
    };
  }
  if (!sourceUrl) {
    return null;
  }

  const resolved = await resolveNoteWithPreview(sourceUrl);
  return resolved
    ? {
        noteBasic: resolved.noteBasic,
        payload: resolved.payload,
      }
    : null;
};

// 从响应对象中提取点赞数
const normalizeNoteLikeCountResponse = (payload) => {
  const data = payload?.data ?? payload?.result ?? payload;
  const likeCount = findFirstNumberByKey(
    data,
    /^(like|likes|liked|like_count|likes_count|likes_num|liked_count|likedCount|likeCount|note_likes|digg_count|diggCount)$/i,
  );
  return likeCount === null ? null : Math.max(Math.floor(likeCount), 0);
};

// 从响应对象中提取实时阅读数
const normalizeNoteRealtimeViewCountResponse = (payload) => {
  const data = payload?.data ?? payload?.result ?? payload;
  const viewCount = findFirstNumberByKey(
    data,
    /^(view|views|view_num|viewNum|views_num|view_count|viewCount|read_count|readCount|browse_count|browseCount|play_count|playCount)$/i,
  );
  return viewCount === null ? null : Math.max(Math.floor(viewCount), 0);
};

// 兼容旧版的点赞数查询入口（外部API已禁用，始终返回null）
const fetchNoteRealtimeData = async (noteId) => {
  if (!noteId) return null;
  try {
    const response = await fetch(
      `${NOTE_API_BASE}/realtime?note_id=${encodeURIComponent(noteId)}&proxy_line=line_1086`,
      { signal: AbortSignal.timeout(10000) },
    );
    const body = await response.json();
    if (body?.code === 0 && body?.data?.realTime) {
      return { realTime: body.data.realTime, raw: body.data };
    }
    return null;
  } catch {
    return null;
  }
};

const requestNoteLikeCount = async ({ note_id: noteId } = {}) => {
  if (!noteId) return { like_count: null, payload: null };
  try {
    const response = await fetch(
      `${NOTE_API_BASE}/likes?note_id=${encodeURIComponent(noteId)}&proxy_line=line_1086`,
      { signal: AbortSignal.timeout(10000) },
    );
    const body = await response.json();
    if (body?.code === 0 && body?.data) {
      const likesNum = Number(body.data.likes_num);
      return {
        like_count: Number.isFinite(likesNum) ? likesNum : null,
        payload: body.data,
      };
    }
    return { like_count: null, payload: null };
  } catch {
    return { like_count: null, payload: null };
  }
};

const requestNoteRealtimeViewCount = async ({ note_id: noteId } = {}) => {
  const data = await fetchNoteRealtimeData(noteId);
  if (!data) return { view_count: null, payload: null };
  const viewNum = Number(data.realTime.viewNum);
  return {
    view_count: Number.isFinite(viewNum) ? viewNum : null,
    payload: data.raw,
  };
};

// 规范化旧版笔记ID响应格式
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

// 从URL或本地预览管道解析笔记ID
const requestNoteId = async (sourceUrl) => {
  const parsedNoteId = extractNoteId(sourceUrl);
  if (parsedNoteId && !isShortNoteLink(sourceUrl)) {
    return {
      note_id: parsedNoteId,
      note_url: sourceUrl,
    };
  }

  const resolved = await resolveNoteWithPreview(sourceUrl);
  return resolved
    ? {
        note_id: resolved.note_id,
        note_url: resolved.note_url,
      }
    : null;
};

// 根据URL获取本地可用的笔记指标数据（基本信息、点赞数、阅读数）
const fetchNoteMetricsByUrl = async (sourceUrl) => {
  const rawUrl = String(sourceUrl || '').trim();
  if (!rawUrl) {
    const error = new Error('Note url is required');
    error.statusCode = 400;
    throw error;
  }
  if (!/^https?:\/\/\S+/i.test(rawUrl)) {
    const error = new Error('Invalid note url');
    error.statusCode = 400;
    throw error;
  }

  const resolved = await resolveNoteWithPreview(rawUrl);
  const noteId = resolved?.note_id || extractNoteId(rawUrl) || '';

  return {
    input_url: rawUrl,
    note_id: noteId,
    note_url: resolved?.note_url || rawUrl,
    basic: resolved?.noteBasic || createPreviewNoteBasic({ note_id: noteId, note_url: rawUrl }, rawUrl),
    like_count: null,
    realtime_view_count: null,
    payloads: {
      basic: resolved?.payload || null,
      id: resolved || null,
      likes: null,
      realtime: null,
    },
    realtime_source: 'local_preview',
  };
};

// 根据源URL加载或解析笔记基本信息（优先读缓存）
const fetchNoteBasicBySourceUrl = async (db, sourceUrl) => {
  const cacheKey = String(sourceUrl || '').trim();
  const cachedNote = await getCachedNoteBasic(db, cacheKey);

  // 有缓存且有博主ID和头像，直接返回
  if (
    cachedNote &&
    String(cachedNote.author_id || '').trim() &&
    String(cachedNote.avatar_url || '').trim()
  ) {
    return cachedNote;
  }

  // 无缓存或缓存中博主ID为空，重新获取
  try {
    const resolved = await resolveNoteWithPreview(sourceUrl);
    if (resolved?.noteBasic) {
      // 如果重新获取到了博主ID，或者是全新数据，更新缓存
      if (String(resolved.noteBasic.author_id || '').trim() || !cachedNote) {
        await saveCachedNoteBasic(db, cacheKey, resolved.noteBasic, resolved.payload);
      }
      return {
        ...resolved.noteBasic,
        cache_hit: false,
      };
    }
  } catch {
    // The caller will decide how to surface validation errors.
  }

  // 重新获取失败但有旧缓存，返回旧缓存（author_id 仍为空）
  if (cachedNote) {
    return cachedNote;
  }

  return null;
};

// 根据笔记ID获取或构建笔记基本信息（优先读缓存）
const fetchNoteBasicByNoteId = async (db, noteUrl, noteId, resolvedNoteUrl) => {
  const cacheKey = String(noteUrl || '').trim();
  const cachedNote = await getCachedNoteBasic(db, cacheKey);

  // 有缓存且有博主ID和头像，直接返回
  if (
    cachedNote &&
    String(cachedNote.author_id || '').trim() &&
    String(cachedNote.avatar_url || '').trim()
  ) {
    return {
      ...cachedNote,
      cache_hit: true,
    };
  }

  // 无缓存或缓存中博主ID/头像为空，先调外部API获取笔记详情
  if (noteId) {
    try {
      const apiDetail = await fetchNoteBasicFromApi(noteId);
      if (apiDetail && (apiDetail.author_id || apiDetail.avatar_url)) {
        const noteBasic = {
          author_id: apiDetail.author_id || cachedNote?.author_id || '',
          author_name: apiDetail.author_name || cachedNote?.author_name || '',
          avatar_url: apiDetail.avatar_url || cachedNote?.avatar_url || '',
          note_id: noteId,
          note_url: resolvedNoteUrl || noteUrl,
          title: apiDetail.title || cachedNote?.title || '',
        };
        await saveCachedNoteBasic(db, cacheKey, noteBasic, null);
        return { ...noteBasic, cache_hit: false };
      }
    } catch {
      // API 失败，继续走 fallback
    }
  }

  // API 也拿不到，用 createPreviewNoteBasic 构建
  const noteBasic = createPreviewNoteBasic(
    {
      note_id: noteId,
      note_url: resolvedNoteUrl || noteUrl,
    },
    noteUrl,
  );
  if (noteBasic) {
    if (String(noteBasic.author_id || '').trim() || !cachedNote) {
      await saveCachedNoteBasic(db, cacheKey, noteBasic, null);
    }
    return {
      ...noteBasic,
      cache_hit: false,
    };
  }

  // 构建失败但有旧缓存，返回旧缓存
  if (cachedNote) {
    return {
      ...cachedNote,
      cache_hit: true,
    };
  }

  return null;
};

// 解析批量订单的原始文本内容为结构化行数据
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
      errors.push('Invalid link format');
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

// 读取可选的 Tinydata 预览API令牌
const getTinydataPreviewToken = () => {
  const rawToken = String(process.env.TINYDATA_PREVIEW_TOKEN || '').trim();
  return rawToken.replace(/^Bearer\s+/i, '');
};

// 构建可选的预览API Authorization 认证请求头
const getTinydataPreviewAuthHeader = () => {
  const token = getTinydataPreviewToken();
  return token ? `Bearer ${token}` : '';
};

// 将预览API认证头合并到请求头对象中
const withTinydataPreviewAuthHeader = (headers = {}) => {
  const authHeader = getTinydataPreviewAuthHeader();
  return authHeader
    ? { ...headers, Authorization: authHeader }
    : headers;
};

// 将本地目标类型映射为预览API的目标类型（like 映射为 view）
const getTinydataPreviewTargetType = (targetType) => {
  const normalizedTargetType = normalizeTargetType(targetType);
  return normalizedTargetType === 'like' ? 'view' : normalizedTargetType;
};

// 规范化批量输入内容，还原转义的换行符和制表符
const normalizeBatchInputContent = (content) =>
  String(content || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');

// 分割预览内容为行数组，并标记每行是否为有效链接
const getPreviewLines = (content) =>
  normalizeBatchInputContent(content)
    .split(/\r?\n/)
    .map((line, index) => ({
      is_link: /^https?:\/\/\S+/i.test(line.trim().split(/\s+/)[0] || ''),
      line_no: index + 1,
      raw: line.trim(),
    }))
    .filter((line) => line.raw);

// 检查是否可以使用 PowerShell 作为回退方案（仅 Windows）
const canUsePowerShellFallback = () => process.platform === 'win32';

// 从命令行标准输出解析JSON数据
const parseJsonCommandOutput = (stdout) => {
  const text = String(stdout || '').trim();
  if (!text) {
    const error = new Error('Tinydata preview fallback returned empty response');
    error.statusCode = 502;
    throw error;
  }
  return JSON.parse(text);
};

// 返回 curl 命令候选列表，用于服务端回退请求
const getTinydataCurlCandidates = () => [
  TINYDATA_PREVIEW_CURL_BIN,
  'curl-impersonate-chrome',
  'curl_chrome116',
  'curl',
].filter((command, index, list) => command && list.indexOf(command) === index);

// 构建预览请求的基础 curl 命令参数
const buildTinydataCurlBaseArgs = () => {
  const args = [
    '-sS',
    '--http1.1',
    '-m',
    String(Math.ceil((Number(process.env.TINYDATA_PREVIEW_TIMEOUT_MS) || 30_000) / 1000)),
    '-H',
    'Accept: application/json',
    '-A',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  ];
  if (TINYDATA_PREVIEW_PROXY) {
    args.push('-x', TINYDATA_PREVIEW_PROXY);
  }
  return args;
};

// 依次尝试 curl 候选命令，返回第一个有效的JSON响应
const execTinydataCurl = async (args) => {
  let lastError;
  for (const command of getTinydataCurlCandidates()) {
    try {
      const { stdout } = await execFileAsync(command, args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: Number(process.env.TINYDATA_PREVIEW_TIMEOUT_MS) || 30_000,
        windowsHide: true,
      });
      return parseJsonCommandOutput(stdout);
    } catch (error) {
      lastError = error;
      if (error?.code === 'ENOENT') {
        continue;
      }
    }
  }
  const stderr = String(lastError?.stderr || '').trim();
  const detail = stderr || lastError?.message || 'unknown curl error';
  const error = new Error(`Tinydata preview curl fallback failed: ${detail}`);
  error.statusCode = 502;
  error.cause = lastError;
  throw error;
};

// 通过 curl 回退方式调用预览API
const requestTinydataPreviewWithCurl = async ({ content, targetType }) => {
  const requestBody = JSON.stringify({
    content: normalizeBatchInputContent(content),
    target_type: getTinydataPreviewTargetType(targetType),
  });
  return execTinydataCurl([
    ...buildTinydataCurlBaseArgs(),
      '-X',
      'POST',
      TINYDATA_PREVIEW_API,
      '-H',
      'Content-Type: application/json',
      '--data-raw',
      requestBody,
  ]);
};

// 通过 curl 回退方式轮询预览异步任务状态
const requestTinydataPreviewJobWithCurl = async (jobId) => {
  const jobUrl = new URL(String(jobId), TINYDATA_PREVIEW_JOB_API).toString();
  return execTinydataCurl([
    ...buildTinydataCurlBaseArgs(),
      '-X',
      'GET',
      jobUrl,
  ]);
};

// 通过 PowerShell 回退方式调用预览API
const requestTinydataPreviewWithPowershell = async ({ content, targetType }) => {
  const requestBody = JSON.stringify({
    content: normalizeBatchInputContent(content),
    target_type: getTinydataPreviewTargetType(targetType),
  });
  const script = [
    '$headers = @{}',
    'if ($env:TINYDATA_AUTH_HEADER) { $headers.Authorization = $env:TINYDATA_AUTH_HEADER }',
    '$response = Invoke-RestMethod -Uri $env:TINYDATA_PREVIEW_URL -Method Post -ContentType "application/json" -Headers $headers -Body $env:TINYDATA_REQUEST_BODY',
    '$response | ConvertTo-Json -Depth 20 -Compress',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env: {
        ...process.env,
        TINYDATA_AUTH_HEADER: getTinydataPreviewAuthHeader(),
        TINYDATA_PREVIEW_URL: TINYDATA_PREVIEW_API,
        TINYDATA_REQUEST_BODY: requestBody,
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: Number(process.env.TINYDATA_PREVIEW_TIMEOUT_MS) || 30_000,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
};

// 通过 PowerShell 回退方式轮询预览异步任务状态
const requestTinydataPreviewJobWithPowershell = async (jobId) => {
  const script = [
    '$headers = @{}',
    'if ($env:TINYDATA_AUTH_HEADER) { $headers.Authorization = $env:TINYDATA_AUTH_HEADER }',
    '$response = Invoke-RestMethod -Uri ($env:TINYDATA_PREVIEW_JOB_URL + $env:TINYDATA_PREVIEW_JOB_ID) -Method Get -Headers $headers',
    '$response | ConvertTo-Json -Depth 20 -Compress',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env: {
        ...process.env,
        TINYDATA_AUTH_HEADER: getTinydataPreviewAuthHeader(),
        TINYDATA_PREVIEW_JOB_ID: String(jobId || ''),
        TINYDATA_PREVIEW_JOB_URL: TINYDATA_PREVIEW_JOB_API,
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: Number(process.env.TINYDATA_PREVIEW_TIMEOUT_MS) || 30_000,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
};

// 延迟辅助函数，用于轮询循环中的等待
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 获取单个预览异步任务的结果（含连接重置时的回退逻辑）
const requestTinydataPreviewJob = async (jobId) => {
  const jobUrl = new URL(String(jobId), TINYDATA_PREVIEW_JOB_API).toString();
  try {
    const response = await fetch(jobUrl, {
      headers: withTinydataPreviewAuthHeader(),
      method: 'GET',
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.code !== 'OK') {
      const error = new Error(body?.message || `Tinydata preview job failed with HTTP ${response.status}`);
      error.statusCode = response.ok ? 400 : response.status;
      error.details = body;
      throw error;
    }
    return body;
  } catch (error) {
    if (error?.cause?.code === 'ECONNRESET' || error?.message === 'fetch failed') {
      try {
        if (canUsePowerShellFallback()) {
          return await requestTinydataPreviewJobWithPowershell(jobId);
        }
        return await requestTinydataPreviewJobWithCurl(jobId);
      } catch (fallbackError) {
        fallbackError.message = `Tinydata preview job fetch failed, fallback failed: ${fallbackError.message}`;
        throw fallbackError;
      }
    }
    throw error;
  }
};

// 轮询预览异步任务，直到完成或超时
const resolveTinydataPreviewAsyncJob = async (body) => {
  const jobId = body?.data?.job_id;
  if (!body?.data?.async || !jobId) {
    return body;
  }

  const timeoutMs = Number(process.env.TINYDATA_PREVIEW_ASYNC_TIMEOUT_MS) || 60_000;
  const intervalMs = Number(process.env.TINYDATA_PREVIEW_ASYNC_INTERVAL_MS) || 1000;
  const deadline = Date.now() + timeoutMs;
  let latestBody = body;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    latestBody = await requestTinydataPreviewJob(jobId);
    const status = String(latestBody?.data?.status || '').toLowerCase();
    if (status === 'succeeded' || Array.isArray(latestBody?.data?.items)) {
      return latestBody;
    }
    if (status === 'failed') {
      const error = new Error(latestBody?.message || 'Tinydata preview async job failed');
      error.statusCode = 400;
      error.details = latestBody;
      throw error;
    }
  }

  const error = new Error('Tinydata preview async job timeout');
  error.statusCode = 504;
  error.details = latestBody;
  throw error;
};

// 调用 Tinydata 预览API（支持异步任务和连接失败时的回退）
const requestTinydataPreview = async ({ content, targetType }) => {
  const previewLines = getPreviewLines(content);
  const linkLines = previewLines.filter((line) => line.is_link);
  const invalidLines = previewLines.filter((line) => !line.is_link);
  console.log('[Tinydata Preview] input', JSON.stringify({
    invalid_lines: invalidLines.length,
    line_count: previewLines.length,
    link_lines: linkLines.length,
    target_type: getTinydataPreviewTargetType(targetType),
  }));
  if (linkLines.length === 0) {
    return { invalid_lines: invalidLines, items: [], source_lines: [] };
  }
  const previewContent = linkLines.map((line) => line.raw).join('\n');
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.TINYDATA_PREVIEW_TIMEOUT_MS) || 30_000,
  );

  try {
    const response = await fetch(TINYDATA_PREVIEW_API, {
      body: JSON.stringify({
        content: previewContent,
        target_type: getTinydataPreviewTargetType(targetType),
      }),
      headers: {
        ...withTinydataPreviewAuthHeader({ 'Content-Type': 'application/json' }),
      },
      method: 'POST',
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.code !== 'OK') {
      const error = new Error(body?.message || `Tinydata preview failed with HTTP ${response.status}`);
      error.statusCode = response.ok ? 400 : response.status;
      error.details = body;
      throw error;
    }
    console.log('[Tinydata Preview] response', JSON.stringify({
      code: body?.code,
      item_count: Array.isArray(body?.data?.items) ? body.data.items.length : 0,
      message: body?.message,
    }));
    const resolvedBody = await resolveTinydataPreviewAsyncJob(body);
    console.log('[Tinydata Preview] response', JSON.stringify({
      async: Boolean(resolvedBody?.data?.async),
      code: resolvedBody?.code,
      item_count: Array.isArray(resolvedBody?.data?.items) ? resolvedBody.data.items.length : 0,
      job_id: resolvedBody?.data?.job_id || body?.data?.job_id,
      message: resolvedBody?.message,
      status: resolvedBody?.data?.status,
    }));
    return { ...(resolvedBody?.data || {}), invalid_lines: invalidLines, source_lines: linkLines };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Tinydata preview request timeout');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    if (error?.cause?.code === 'ECONNRESET' || error?.message === 'fetch failed') {
      let body;
      try {
        body = canUsePowerShellFallback()
          ? await requestTinydataPreviewWithPowershell({ content: previewContent, targetType })
          : await requestTinydataPreviewWithCurl({ content: previewContent, targetType });
      } catch (fallbackError) {
        fallbackError.message = `Tinydata preview fetch failed, fallback failed: ${fallbackError.message}`;
        throw fallbackError;
      }
      if (body?.code !== 'OK') {
        const previewError = new Error(body?.message || 'Tinydata preview failed');
        previewError.statusCode = 400;
        previewError.details = body;
        throw previewError;
      }
      console.log('[Tinydata Preview] response', JSON.stringify({
        code: body?.code,
        item_count: Array.isArray(body?.data?.items) ? body.data.items.length : 0,
        message: body?.message,
      }));
      const resolvedBody = await resolveTinydataPreviewAsyncJob(body);
      console.log('[Tinydata Preview] response', JSON.stringify({
        async: Boolean(resolvedBody?.data?.async),
        code: resolvedBody?.code,
        item_count: Array.isArray(resolvedBody?.data?.items) ? resolvedBody.data.items.length : 0,
        job_id: resolvedBody?.data?.job_id || body?.data?.job_id,
        message: resolvedBody?.message,
        status: resolvedBody?.data?.status,
      }));
      return { ...(resolvedBody?.data || {}), invalid_lines: invalidLines, source_lines: linkLines };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

// 将预览API返回的行数据规范化为内部统一格式
const normalizeTinydataPreviewItems = (previewData) => {
  const items = Array.isArray(previewData?.items) ? previewData.items : [];
  const invalidItems = (Array.isArray(previewData?.invalid_lines) ? previewData.invalid_lines : [])
    .map((line) => ({
      avatar_url: '',
      duplicate: false,
      errors: ['Invalid link format'],
      line_no: Number(line.line_no) || 0,
      note_id: '',
      note_url: String(line.raw || '').split(/\s+/)[0] || '',
      ordered_quantity: 0,
      raw: String(line.raw || ''),
      resolved_note_url: '',
      valid: false,
    }));
  const sourceLines = Array.isArray(previewData?.source_lines) ? previewData.source_lines : [];
  const tinydataItems = items.map((item, index) => {
    const sourceLine = sourceLines[index] || {};
    const raw = String(sourceLine.raw || item.raw_line || item.raw || '').trim();
    const noteId = String(item.note_id || '').trim();
    const noteUrl = noteId
      ? `https://www.xiaohongshu.com/explore/${noteId}`
      : String(item.normalized_url || item.raw_url || item.note_url || '').trim();
    const orderedQuantity = Number(item.target_quantity ?? item.ordered_quantity ?? item.quantity);
    const errors = [];
    if (item.message) {
      errors.push(String(item.message));
    }
    if (!item.valid && errors.length === 0) {
      errors.push('Tinydata preview validation failed');
    }
    if (item.valid && !noteId) {
      errors.push('Tinydata preview response missing note_id');
    }

    return {
      author_id: String(item.author_id || item.user_id || '').trim(),
      author_name: String(item.author_name || item.user_name || item.nickname || '').trim(),
      avatar_url: normalizeMediaUrl(item.avatar_url || item.avatar || item.image || ''),
      duplicate: false,
      errors,
      line_no: Number(sourceLine.line_no || item.line_no) || index + 1,
      note_id: noteId,
      note_url: noteUrl,
      ordered_quantity: Number.isInteger(orderedQuantity) && orderedQuantity > 0 ? orderedQuantity : 0,
      raw,
      resolved_note_url: noteUrl,
      title: String(item.title || item.note_title || item.desc || '').trim(),
      valid: Boolean(item.valid) && errors.length === 0,
    };
  });
  return [...invalidItems, ...tinydataItems].sort((left, right) => left.line_no - right.line_no);
};

// 通过预览管道解析单个笔记URL（短链接需调用预览API）
const resolveNoteWithPreview = async (sourceUrl) => {
  const rawUrl = String(sourceUrl || '').trim();
  if (!rawUrl || !/^https?:\/\/\S+/i.test(rawUrl)) {
    return null;
  }

  const directNoteId = extractNoteId(rawUrl);
  if (directNoteId && !isShortNoteLink(rawUrl)) {
    const noteBasic = createPreviewNoteBasic(
      {
        note_id: directNoteId,
        note_url: rawUrl,
      },
      rawUrl,
    );
    return {
      item: null,
      noteBasic,
      note_id: directNoteId,
      note_url: rawUrl,
      payload: null,
    };
  }

  let payload;
  let item;
  let noteBasic;
  try {
    payload = await requestTinydataPreview({
      content: `${rawUrl} 1`,
      targetType: 'view',
    });
    [item] = normalizeTinydataPreviewItems(payload).filter((entry) => entry.note_url === rawUrl || entry.raw);
    noteBasic = createPreviewNoteBasic(item, rawUrl);
  } catch {
    // Tinydata 预览失败，继续尝试本地解析
  }

  if (noteBasic) {
    return {
      item,
      noteBasic,
      note_id: noteBasic.note_id,
      note_url: noteBasic.note_url || rawUrl,
      payload,
    };
  }

  // Tinydata 无法解析时，本地通过 HTTP 重定向解析短链接
  if (isShortNoteLink(rawUrl)) {
    const localResolved = await resolveShortLinkLocally(rawUrl);
    if (localResolved?.note_id) {
      const localNoteBasic = createPreviewNoteBasic(
        { note_id: localResolved.note_id, note_url: localResolved.note_url },
        rawUrl,
      );
      return {
        item: null,
        noteBasic: localNoteBasic,
        note_id: localResolved.note_id,
        note_url: localResolved.note_url,
        payload: null,
      };
    }
  }

  return null;
};

// 解析批量搜索输入的链接并检测重复
const parseBatchSearchLinks = (content) => {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const seenKeys = new Set();

  return lines.map((line, index) => {
    const [noteUrl = ''] = line.split(/\s+/);
    const noteId = extractNoteId(noteUrl);
    const errors = [];

    if (!/^https?:\/\/\S+/i.test(noteUrl)) {
      errors.push('Invalid link format');
    }

    const key = noteId || noteUrl;
    const duplicate = Boolean(key) && seenKeys.has(key);
    if (duplicate) {
      errors.push('链接重复');
    }
    if (key && !duplicate) {
      seenKeys.add(key);
    }

    return {
      duplicate,
      errors,
      line_no: index + 1,
      note_id: noteId,
      note_url: noteUrl,
      raw: line,
      valid: errors.length === 0,
    };
  });
};

// 从系统配置表读取数值配置项（不存在时使用默认值）
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

// 获取用户订单上下文（余额、折扣率、单价等定价信息）
const getUserOrderContext = async (db, userId, targetType) => {
  const [[user]] = await db.execute(
    `
      SELECT id, discount_rate, impression_discount_rate, price_mode, impression_price_mode,
        fixed_unit_price, impression_fixed_unit_price,
        quantity_price_base, quantity_price_amount,
        impression_quantity_price_base, impression_quantity_price_amount,
        like_discount_rate, like_price_mode, like_fixed_unit_price,
        like_quantity_price_base, like_quantity_price_amount,
        order_view_enabled, order_like_enabled, order_impression_enabled
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

  const typeEnabledMap = {
    impression: user.order_impression_enabled !== 0,
    like: user.order_like_enabled !== 0,
    view: user.order_view_enabled !== 0,
  };
  if (typeEnabledMap[targetType] === false) {
    const error = new Error(`${getTargetTypeLabel(targetType)}下单功能已被管理员禁用`);
    error.statusCode = 403;
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
      : targetType === 'like'
        ? user.like_price_mode || user.price_mode || 'discount'
      : user.price_mode || 'discount';
  const rawDiscountRate =
    targetType === 'impression'
      ? user.impression_discount_rate
      : targetType === 'like'
        ? user.like_discount_rate ?? user.discount_rate
      : user.discount_rate;
  const fixedUnitPrice =
    targetType === 'impression'
      ? user.impression_fixed_unit_price
      : targetType === 'like'
        ? user.like_fixed_unit_price ?? user.fixed_unit_price
      : user.fixed_unit_price;
  const quantityPriceBase =
    targetType === 'impression'
      ? user.impression_quantity_price_base
      : targetType === 'like'
        ? user.like_quantity_price_base ?? user.quantity_price_base
      : user.quantity_price_base;
  const quantityPriceAmount =
    targetType === 'impression'
      ? user.impression_quantity_price_amount
      : targetType === 'like'
        ? user.like_quantity_price_amount ?? user.quantity_price_amount
      : user.quantity_price_amount;
  const userUnitPrice = Number(fixedUnitPrice) > 0 ? round4(fixedUnitPrice) : configuredUnitPrice;
  const packageAmount = Number(quantityPriceAmount) > 0 ? round4(quantityPriceAmount) : userUnitPrice;
  const packageBaseQuantity = Number(quantityPriceBase) > 0 ? Number(quantityPriceBase) : 1;
  const unitPrice = mode === 'default' || mode === 'discount'
    ? userUnitPrice
    : packageAmount;
  const discountRate = mode === 'default' ? 1 : normalizeDiscountRate(rawDiscountRate);
  const discountedUnitPrice =
    mode === 'fixed'
      ? userUnitPrice
      : mode === 'quantity'
        ? packageAmount
      : round4(unitPrice * discountRate);

  return {
    availableBalance: round4(balance?.available_amount),
    discountRate: unitPrice > 0 ? round4(discountedUnitPrice / unitPrice) : discountRate,
    discountedUnitPrice,
    priceBaseQuantity: mode === 'quantity' ? packageBaseQuantity : 1,
    priceMode: mode,
    unitPrice: round4(unitPrice),
  };
};

// 计算订单的原价、折扣金额和应付金额
const calculateOrderAmounts = (context, orderedQuantity) => {
  const quantity = Number(orderedQuantity) || 0;
  if (context.priceMode === 'quantity') {
    const baseQuantity = Math.max(Number(context.priceBaseQuantity) || 1, 1);
    const originalAmount = round4((quantity / baseQuantity) * context.unitPrice);
    const payableAmount = round4((quantity / baseQuantity) * context.discountedUnitPrice);
    return {
      discountAmount: round4(Math.max(originalAmount - payableAmount, 0)),
      originalAmount,
      payableAmount,
    };
  }

  const originalAmount = round4(context.unitPrice * quantity);
  const payableAmount = round4(context.discountedUnitPrice * quantity);
  return {
    discountAmount: round4(Math.max(originalAmount - payableAmount, 0)),
    originalAmount,
    payableAmount,
  };
};

// 查找当前活跃的同目标同笔记订单（用于冲突检测，防止重复下单）
const findActiveNoteOrderConflicts = async (db, targetType, noteIds) => {
  const uniqueNoteIds = [...new Set(noteIds.filter(Boolean))];
  if (uniqueNoteIds.length === 0) {
    return new Map();
  }

  const notePlaceholders = uniqueNoteIds.map(() => '?').join(',');
  const statusPlaceholders = ACTIVE_NOTE_ORDER_STATUSES.map(() => '?').join(',');
  const [rows] = await db.execute(
    `
      SELECT id, order_no, note_id, order_status
      FROM orders
      WHERE target_type = ?
        AND note_id IN (${notePlaceholders})
        AND order_status IN (${statusPlaceholders})
      ORDER BY id ASC
    `,
    [targetType, ...uniqueNoteIds, ...ACTIVE_NOTE_ORDER_STATUSES],
  );

  const conflicts = new Map();
  for (const row of rows) {
    if (!conflicts.has(row.note_id)) {
      conflicts.set(row.note_id, {
        id: Number(row.id),
        order_no: row.order_no,
        order_status: row.order_status,
      });
    }
  }
  return conflicts;
};

// 构建批量订单预览（含链接验证、定价计算和冲突检测）
const buildPreview = async (
  userId,
  { content, target_type: targetTypeValue },
  { persistCheckRecords = true } = {},
) => {
  const db = getPool();
  const targetType = normalizeTargetType(targetTypeValue);
  const context = await getUserOrderContext(db, userId, targetType);
  const minOrderQuantity = await getNumericConfig(db, 'order', 'min_order_quantity', 10);
  const previewItems = await resolvePreviewLocally(content);
  const seenResolvedNoteIds = new Set();
  const runExternalCheck = createAsyncLimiter(getBatchCheckConcurrency());
  const items = await Promise.all(previewItems.map(async (item) => {
    const errors = [...item.errors];
    let noteId = item.note_id;
    let resolvedNoteUrl = item.note_url;
    let noteBasic = null;

    if (item.ordered_quantity > 0 && item.ordered_quantity < minOrderQuantity) {
      errors.push(`单条下单量最低为 ${minOrderQuantity}`);
    }

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
        // Tinydata 无法解析时，本地通过 HTTP 重定向解析短链接
        if (!noteId) {
          const localResolved = await runExternalCheck(() => resolveShortLinkLocally(item.note_url));
          if (localResolved?.note_id) {
            noteId = localResolved.note_id;
            resolvedNoteUrl = localResolved.note_url;
          }
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
          errors.push('Note validation failed');
        }
      }
    }

    // Tinydata 未解析出笔记ID时，本地尝试解析（普通链接 + 短链接）
    if (!noteId) {
      const extracted = isShortNoteLink(item.note_url) ? '' : extractNoteId(item.note_url);
      if (extracted) {
        noteId = extracted;
        resolvedNoteUrl = `https://www.xiaohongshu.com/explore/${extracted}`;
      } else if (isShortNoteLink(item.note_url)) {
        const localResolved = await runExternalCheck(() => resolveShortLinkLocally(item.note_url));
        if (localResolved?.note_id) {
          noteId = localResolved.note_id;
          resolvedNoteUrl = localResolved.note_url;
        }
      }
      if (noteId) {
        errors.length = 0;
        if (seenResolvedNoteIds.has(noteId)) {
          errors.push('链接重复');
        } else {
          seenResolvedNoteIds.add(noteId);
          noteBasic = await runExternalCheck(() =>
            fetchNoteBasicByNoteId(db, item.note_url, noteId, resolvedNoteUrl),
          );
          if (!noteBasic) {
            errors.push('Note validation failed');
          }
        }
      }
    }

    const authorId = noteBasic?.author_id || item.author_id || '';
    if (errors.length === 0 && !authorId) {
      errors.push('未获取到博主ID');
    }

    const { discountAmount, originalAmount, payableAmount } = calculateOrderAmounts(
      context,
      item.ordered_quantity,
    );
    let likeCount = null;
    if (item.valid && !noteBasic) {
      // The note lookup error has already been appended above.
    }
    const valid = errors.length === 0;
    if (valid && targetType === 'like') {
      const likeCountResult = await runExternalCheck(() =>
        requestNoteLikeCount({
          note_id: noteBasic?.note_id || noteId,
        }),
      );
      likeCount = likeCountResult.like_count;
    }

    return {
      ...item,
      author_id: noteBasic?.author_id || item.author_id || '',
      author_name: noteBasic?.author_name || item.author_name || '',
      avatar_url: noteBasic?.avatar_url || item.avatar_url || '',
      cache_hit: Boolean(noteBasic?.cache_hit),
      duplicate: errors.includes('链接重复'),
      errors,
      like_count: likeCount,
      note_id: noteBasic?.note_id || noteId,
      resolved_note_url: resolvedNoteUrl,
      title: noteBasic?.title || item.title || '',
      valid,
      discount_amount: valid ? discountAmount : 0,
      original_amount: valid ? round4(originalAmount) : 0,
      payable_amount: valid ? round4(payableAmount) : 0,
    };
  }));

  const activeConflicts = await findActiveNoteOrderConflicts(
    db,
    targetType,
    items.filter((item) => item.valid).map((item) => item.note_id),
  );
  for (const item of items) {
    const conflict = item.valid ? activeConflicts.get(item.note_id) : null;
    if (conflict) {
      item.valid = false;
      item.payable_amount = 0;
      item.discount_amount = 0;
      item.errors = [
        ...item.errors,
        `该笔记已有${getTargetTypeLabel(targetType)}任务正在进行中，不允许重复下单（订单编号: ${conflict.order_no}）`,
      ];
    }
  }

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
    warnings.push('可用余额不足');
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
    price_base_quantity: context.priceBaseQuantity,
    price_mode: context.priceMode,
    target_type: targetType,
    total_amount: totalAmount,
    total_count: items.length,
    unit_price: context.unitPrice,
    valid_count: validItems.length,
    warnings,
  };
};

// 创建订单扣费的账户借记记录
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
      item.original_amount ?? preview.unit_price,
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

// 生成已提交订单的批次编号
const createBatchNo = () =>
  `BATCH-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(1).toString('hex').toUpperCase()}`;

// 自动退款已扣费但失败的订单（将金额退回用户余额）
const refundFailedChargedOrders = async (db, userId) => {
  const connection = await db.getConnection();
  const now = new Date();

  try {
    await connection.beginTransaction();

    const [orders] = await connection.execute(
      `
        SELECT
          o.*,
          MIN(ar.id) AS charge_record_id,
          SUM(ar.actual_paid_amount) AS total_paid_amount,
          MIN(ar.discount_rate) AS discount_rate,
          MIN(ar.discounted_unit_price) AS discounted_unit_price
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
        GROUP BY o.id
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
      const paidAmount = Number(order.total_paid_amount) || 0;
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
          'Order failed automatic refund',
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
              reason_message = COALESCE(reason_message, 'Order failed automatic refund'),
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

// 刷新批次的统计数据和最终状态
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
        COALESCE(SUM(CASE WHEN order_status IN ('running', 'repair_review') THEN 1 ELSE 0 END), 0) AS processing_count,
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

// 提交订单前收集基准快照数据（阅读数/点赞数）
const collectSubmitSnapshots = async (targetType, items) => {
  if (!['like', 'view'].includes(targetType)) {
    return new Map();
  }

  const snapshotEntries = await Promise.all(
    items.map(async (item) => {
      const result = targetType === 'like'
        ? await requestNoteLikeCount({ note_id: item.note_id })
        : await requestNoteRealtimeViewCount({ note_id: item.note_id });
      return [
        item.line_no,
        {
          payload: result.payload ? JSON.stringify(result.payload).slice(0, 8000) : null,
          like_count: result.like_count,
          view_count: result.view_count,
        },
      ];
    }),
  );
  return new Map(snapshotEntries);
};

// 将订单转换为补单提交项
const buildReplenishItem = (order, quantity) => ({
  author_id: order.author_id || '',
  note_id: order.note_id,
  ordered_quantity: quantity,
});

// 标记订单为需要补单状态（repair_review）并自动创建补单请求
const markOrderNeedsReplenish = async (
  db,
  userId,
  order,
  {
    achievedQuantity,
    latest,
    payloadColumn,
    payloadText,
    progress,
    replenishQuantity,
    verifiedColumn,
    now,
  },
) => {
  const reasonMsg = `need replenish ${replenishQuantity}`;
  await db.execute(
    `
      UPDATE orders
      SET order_status = 'repair_review',
          external_status = 'completed',
          external_progress = ?,
          external_completed_quantity = ?,
          completed_quantity = ?,
          ${verifiedColumn} = ?,
          ${payloadColumn} = ?,
          reason_message = ?,
          updated_at = ?
      WHERE id = ?
        AND user_id = ?
    `,
    [
      progress,
      achievedQuantity,
      achievedQuantity,
      latest,
      payloadText,
      reasonMsg,
      now,
      order.id,
      userId,
    ],
  );

  try {
    await createPendingReplenishmentForOrder(
      db,
      {
        ...order,
        user_id: userId,
        completed_quantity: achievedQuantity,
        external_completed_quantity: achievedQuantity,
        reason_message: reasonMsg,
      },
      reasonMsg,
      now,
    );
  } catch {
    // 补单记录创建失败不影响订单状态标记
  }

  return {
    achieved_quantity: achievedQuantity,
    checked: true,
    latest_count: latest,
    needs_replenish: true,
    replenished: false,
    replenish_quantity: replenishQuantity,
  };
};

// 检查阅读/曝光类订单是否需要补单，并执行补单
const replenishViewOrderIfNeeded = async (db, userId, order, options = {}) => {
  const now = options.now || new Date();
  const shouldDispatch = options.dispatch !== false;
  const targetType = normalizeTargetType(order.target_type);
  if (targetType !== 'view') {
    return { checked: false, reason: 'unsupported_target_type', replenished: false };
  }

  if (
    order.snapshot_current_read_count === null ||
    order.snapshot_current_read_count === undefined ||
    order.snapshot_current_read_count === ''
  ) {
    await db.execute(
      `UPDATE orders SET reason_message = CONCAT(COALESCE(reason_message, ''), '[警告]缺少基准快照，无法验证实际完成量'), updated_at = ? WHERE id = ? AND user_id = ?`,
      [now, order.id, userId],
    );
    return { checked: true, reason: 'missing_snapshot', replenished: false };
  }
  const baseline = Number(order.snapshot_current_read_count);
  if (!Number.isFinite(baseline)) {
    await db.execute(
      `UPDATE orders SET reason_message = CONCAT(COALESCE(reason_message, ''), '[警告]基准快照无效，无法验证实际完成量'), updated_at = ? WHERE id = ? AND user_id = ?`,
      [now, order.id, userId],
    );
    return { checked: true, reason: 'missing_snapshot', replenished: false };
  }

  const realtime = await requestNoteRealtimeViewCount({ note_id: order.note_id });
  const latest = realtime.view_count;
  const payloadText = realtime.payload ? JSON.stringify(realtime.payload).slice(0, 8000) : null;
  if (!Number.isFinite(Number(latest))) {
    const verifiedAt = order.last_verified_at ? new Date(order.last_verified_at) : null;
    const staleSince = verifiedAt ? now.getTime() - verifiedAt.getTime() : 0;
    if (staleSince > 60 * 60 * 1000) {
      await db.execute(
        `UPDATE orders SET reason_message = CONCAT(COALESCE(reason_message, ''), '[警告]超过1小时无法获取实时阅读量，跳过验证'), updated_at = ? WHERE id = ? AND user_id = ?`,
        [now, order.id, userId],
      );
      return { checked: true, reason: 'missing_realtime_count_timeout', replenished: false };
    }
    return { checked: false, reason: 'missing_realtime_count', needs_replenish: true, replenished: false };
  }

  const orderedQuantity = Math.max(Number(order.ordered_quantity) || 0, 0);
  const achievedQuantity = Math.max(Number(latest) - baseline, 0);
  const replenishQuantity = Math.max(orderedQuantity - achievedQuantity, 0);
  const progress = orderedQuantity > 0
    ? Math.max(0, Math.min(round4(achievedQuantity / orderedQuantity), 1))
    : 0;

  if (replenishQuantity <= 0) {
    await db.execute(
      `
        UPDATE orders
        SET order_status = 'completed',
            completed_quantity = ?,
            snapshot_verified_read_count = ?,
            snapshot_verified_read_payload = ?,
            reason_message = NULL,
            updated_at = ?
        WHERE id = ?
          AND user_id = ?
      `,
      [achievedQuantity, latest, payloadText, now, order.id, userId],
    );
    return {
      achieved_quantity: achievedQuantity,
      checked: true,
      latest_count: latest,
      replenished: false,
      replenish_quantity: 0,
    };
  }

  if (!shouldDispatch) {
    return markOrderNeedsReplenish(db, userId, order, {
      achievedQuantity,
      latest,
      now,
      payloadColumn: 'snapshot_verified_read_payload',
      payloadText,
      progress,
      replenishQuantity,
      verifiedColumn: 'snapshot_verified_read_count',
    });
  }

  const nextRepairCount = Number(order.repair_count || 0) + 1;
  const xhsResult = await getXhsTaskClient().createTask(
    targetType,
    createXhsTaskPayload({
      batchNo: order.batch_no || `BATCH-${order.batch_id}`,
      item: buildReplenishItem(order, replenishQuantity),
      orderNo: order.order_no,
      source: `goodsAdmin:repair:${order.id}:${nextRepairCount}`,
      targetType,
    }),
    { token: createCurrentUserToken(userId) },
  );
  const externalTaskId = normalizeXhsTaskId(xhsResult?.id);
  if (!externalTaskId) {
    throw new Error('XHS API response missing task id (numeric)');
  }

  await db.execute(
    `
      UPDATE orders
      SET order_status = 'running',
          external_task_id = ?,
          external_status = 'accepted',
          external_progress = ?,
          external_completed_quantity = ?,
          completed_quantity = ?,
          snapshot_verified_read_count = ?,
          snapshot_verified_read_payload = ?,
          repair_count = ?,
          last_verified_at = NULL,
          reason_message = NULL,
          updated_at = ?
      WHERE id = ?
        AND user_id = ?
    `,
    [
      externalTaskId,
      progress,
      achievedQuantity,
      achievedQuantity,
      latest,
      payloadText,
      nextRepairCount,
      now,
      order.id,
      userId,
    ],
  );

  return {
    achieved_quantity: achievedQuantity,
    checked: true,
    external_task_id: externalTaskId,
    latest_count: latest,
    replenished: true,
    replenish_quantity: replenishQuantity,
  };
};

// 检查点赞类订单是否需要补单，并执行补单
const replenishLikeOrderIfNeeded = async (db, userId, order, options = {}) => {
  const now = options.now || new Date();
  const shouldDispatch = options.dispatch !== false;
  const targetType = normalizeTargetType(order.target_type);
  if (targetType !== 'like') {
    return { checked: false, reason: 'unsupported_target_type', replenished: false };
  }

  if (order.like_count === null || order.like_count === undefined || order.like_count === '') {
    return { checked: true, reason: 'missing_snapshot', replenished: false };
  }
  const baseline = Number(order.like_count);
  if (!Number.isFinite(baseline)) {
    return { checked: true, reason: 'missing_snapshot', replenished: false };
  }

  const latestResult = await requestNoteLikeCount({ note_id: order.note_id });
  const latest = latestResult.like_count;
  const payloadText = latestResult.payload ? JSON.stringify(latestResult.payload).slice(0, 8000) : null;
  if (!Number.isFinite(Number(latest))) {
    return { checked: true, reason: 'missing_like_count', replenished: false };
  }

  const orderedQuantity = Math.max(Number(order.ordered_quantity) || 0, 0);
  const achievedQuantity = Math.max(Number(latest) - baseline, 0);
  const replenishQuantity = Math.max(orderedQuantity - achievedQuantity, 0);
  const progress = orderedQuantity > 0
    ? Math.max(0, Math.min(round4(achievedQuantity / orderedQuantity), 1))
    : 0;

  if (replenishQuantity <= 0) {
    await db.execute(
      `
        UPDATE orders
        SET order_status = 'completed',
            completed_quantity = ?,
            snapshot_verified_like_count = ?,
            snapshot_verified_like_payload = ?,
            reason_message = NULL,
            updated_at = ?
        WHERE id = ?
          AND user_id = ?
      `,
      [achievedQuantity, latest, payloadText, now, order.id, userId],
    );
    return {
      achieved_quantity: achievedQuantity,
      checked: true,
      latest_count: latest,
      replenished: false,
      replenish_quantity: 0,
    };
  }

  if (!shouldDispatch) {
    return markOrderNeedsReplenish(db, userId, order, {
      achievedQuantity,
      latest,
      now,
      payloadColumn: 'snapshot_verified_like_payload',
      payloadText,
      progress,
      replenishQuantity,
      verifiedColumn: 'snapshot_verified_like_count',
    });
  }

  const nextRepairCount = Number(order.repair_count || 0) + 1;
  const xhsResult = await getXhsTaskClient().createTask(
    targetType,
    createXhsTaskPayload({
      batchNo: order.batch_no || `BATCH-${order.batch_id}`,
      item: {
        author_id: order.author_id || '',
        like_count: latest,
        note_id: order.note_id,
        ordered_quantity: replenishQuantity,
      },
      orderNo: order.order_no,
      source: `goodsAdmin:repair:${order.id}:${nextRepairCount}`,
      targetType,
    }),
    { token: createCurrentUserToken(userId) },
  );
  const externalTaskId = normalizeXhsTaskId(xhsResult?.id);
  if (!externalTaskId) {
    throw new Error('XHS API response missing task id (numeric)');
  }

  await db.execute(
    `
      UPDATE orders
      SET order_status = 'running',
          external_task_id = ?,
          external_status = 'accepted',
          external_progress = ?,
          external_completed_quantity = ?,
          completed_quantity = ?,
          snapshot_verified_like_count = ?,
          snapshot_verified_like_payload = ?,
          repair_count = ?,
          last_verified_at = NULL,
          reason_message = NULL,
          updated_at = ?
      WHERE id = ?
        AND user_id = ?
    `,
    [
      externalTaskId,
      progress,
      achievedQuantity,
      achievedQuantity,
      latest,
      payloadText,
      nextRepairCount,
      now,
      order.id,
      userId,
    ],
  );

  return {
    achieved_quantity: achievedQuantity,
    checked: true,
    external_task_id: externalTaskId,
    latest_count: latest,
    replenished: true,
    replenish_quantity: replenishQuantity,
  };
};

// 根据目标类型分发补单检查（点赞/阅读）
const replenishOrderIfNeeded = async (db, userId, order, options = {}) => {
  const targetType = normalizeTargetType(order.target_type);
  if (targetType === 'like') {
    return replenishLikeOrderIfNeeded(db, userId, order, options);
  }
  if (targetType === 'view') {
    return replenishViewOrderIfNeeded(db, userId, order, options);
  }
  return { checked: false, reason: 'unsupported_target_type', replenished: false };
};

// 为批次中需要补单的订单创建补单请求
const requestReplenishBatch = async (userId, batchId) => {
  const targetBatchId = Number(batchId);
  if (!targetBatchId) {
    const error = new Error('Invalid batch id');
    error.statusCode = 400;
    throw error;
  }

  const db = getPool();
  await ensureReplenishmentRecordTable(db);
  const [[batch]] = await db.execute(
    'SELECT id, batch_no, user_id FROM order_batches WHERE id = ? AND user_id = ?',
    [targetBatchId, userId],
  );
  if (!batch) {
    const error = new Error('Batch not found');
    error.statusCode = 404;
    throw error;
  }

  const [[existing]] = await db.execute(
    `
      SELECT id, status
      FROM order_replenishment_records
      WHERE batch_id = ?
        AND user_id = ?
        AND status = 'pending'
      ORDER BY id ASC
      LIMIT 1
    `,
    [targetBatchId, userId],
  );
  if (existing) {
    return {
      batch_id: targetBatchId,
      batch_no: batch.batch_no,
      id: Number(existing.id),
      status: existing.status,
    };
  }

  const [repairOrders] = await db.execute(
    `
      SELECT *
      FROM orders
      WHERE batch_id = ?
        AND user_id = ?
        AND order_status = 'repair_review'
      ORDER BY batch_item_id ASC, id ASC
    `,
    [targetBatchId, userId],
  );
  if (repairOrders.length === 0) {
    const error = new Error('No replenishable orders');
    error.statusCode = 400;
    throw error;
  }

  const now = new Date();
  for (const order of repairOrders) {
    const actualQuantity = Math.max(Number(order.completed_quantity) || 0, 0);
    const orderedQuantity = Math.max(Number(order.ordered_quantity) || 0, 0);
    await db.execute(
      `
        INSERT INTO order_replenishment_records
          (
            replenishment_no, order_id, order_no, batch_id, user_id, target_type,
            note_id, note_url, original_external_task_id, ordered_quantity,
            actual_quantity, shortage_quantity, snapshot_before_count, snapshot_after_count,
            status, reason_message, requested_at, created_at, updated_at
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `,
      [
        `REP-${Date.now()}-${order.id}`,
        order.id,
        order.order_no,
        targetBatchId,
        userId,
        order.target_type,
        order.note_id,
        order.note_url,
        order.external_task_id,
        orderedQuantity,
        actualQuantity,
        Math.max(orderedQuantity - actualQuantity, 0),
        order.like_count ?? order.snapshot_current_read_count ?? null,
        order.snapshot_verified_like_count ?? order.snapshot_verified_read_count ?? null,
        order.reason_message || `batch_no=${batch.batch_no}`,
        now,
        now,
        now,
      ],
    );
  }

  const [[record]] = await db.execute(
    `
      SELECT *
      FROM order_replenishment_records
      WHERE batch_id = ?
        AND status = 'pending'
      ORDER BY id ASC
      LIMIT 1
    `,
    [targetBatchId],
  );

  return {
    batch_id: targetBatchId,
    batch_no: batch.batch_no,
    id: Number(record.id),
    status: record.status,
  };
};

// 为单条订单创建待处理的补单请求
const cancelPendingReplenishments = async (db, orderId) => {
  await ensureReplenishmentRecordTable(getPool());
  await db.execute(
    `
      UPDATE order_replenishment_records
      SET status = 'cancelled',
          reason_message = CONCAT(COALESCE(reason_message, ''), '; 订单已申请退款，自动取消补单'),
          reviewed_at = NOW(),
          updated_at = NOW()
      WHERE order_id = ?
        AND status = 'pending'
    `,
    [orderId],
  );
};

const createPendingReplenishmentForOrder = async (
  db,
  order,
  reasonMessage,
  now = new Date(),
) => {
  await ensureReplenishmentRecordTable(getPool());
  const [[batch]] = await db.execute(
    'SELECT id, batch_no, user_id FROM order_batches WHERE id = ? LIMIT 1',
    [order.batch_id],
  );
  if (!batch) {
    return null;
  }

  const [[existing]] = await db.execute(
    `
      SELECT id, status
      FROM order_replenishment_records
      WHERE order_id = ?
        AND status = 'pending'
      ORDER BY id ASC
      LIMIT 1
    `,
    [order.id],
  );
  if (existing) {
    return {
      id: Number(existing.id),
      status: existing.status,
    };
  }

  const actualQuantity = Math.max(Number(order.completed_quantity) || 0, 0);
  const orderedQuantity = Math.max(Number(order.ordered_quantity) || 0, 0);
  await db.execute(
    `
      INSERT INTO order_replenishment_records
        (
          replenishment_no, order_id, order_no, batch_id, user_id, target_type,
          note_id, note_url, original_external_task_id, ordered_quantity,
          actual_quantity, shortage_quantity, snapshot_before_count, snapshot_after_count,
          status, reason_message, requested_at, created_at, updated_at
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `,
    [
      `REP-${Date.now()}-${order.id}`,
      order.id,
      order.order_no,
      order.batch_id,
      order.user_id,
      order.target_type,
      order.note_id,
      order.note_url,
      order.external_task_id,
      orderedQuantity,
      actualQuantity,
      Math.max(orderedQuantity - actualQuantity, 0),
      order.like_count ?? order.snapshot_current_read_count ?? null,
      order.snapshot_verified_like_count ?? order.snapshot_verified_read_count ?? null,
      reasonMessage,
      now,
      now,
      now,
    ],
  );

  const [[record]] = await db.execute(
    `
      SELECT id, status
      FROM order_replenishment_records
      WHERE order_id = ?
        AND status = 'pending'
      ORDER BY id DESC
      LIMIT 1
    `,
    [order.id],
  );
  return record ? { id: Number(record.id), status: record.status } : null;
};

// 获取补单请求列表（需管理员权限）
const listReplenishmentRequests = async (actorUserId, query = {}) => {
  const db = getPool();
  await assertAdmin(db, actorUserId);
  await ensureReplenishmentRecordTable(db);

  const { page, page_size: pageSize, status = 'pending' } = query;
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const offset = (safePage - 1) * safePageSize;
  const conditions = [];
  const params = [];
  conditions.push(`(rr.status != 'pending' OR NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = rr.order_id AND o.order_status IN ('refund_requested','refund_calculating','refund_approved','refunded','stopping')))`);
  if (status && status !== 'all') {
    conditions.push('rr.status = ?');
    params.push(status);
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [[countRow]] = await db.execute(
    `SELECT COUNT(DISTINCT CONCAT(rr.batch_id, '-', rr.user_id)) AS total
     FROM order_replenishment_records rr
     ${whereSql}`,
    params,
  );
  const [rows] = await db.execute(
    `
      SELECT
        MIN(rr.id) AS id,
        rr.batch_id,
        rr.user_id,
        rr.status,
        MIN(COALESCE(rr.requested_at, rr.created_at)) AS requested_at,
        MAX(rr.reviewed_at) AS reviewed_at,
        MAX(rr.reason_message) AS reason_message,
        ob.batch_no,
        ob.batch_id AS batch_uuid,
        ob.total_count AS target_count,
        ob.estimated_amount,
        u.username,
        u.real_name,
        COUNT(DISTINCT rr.order_id) AS pending_order_count,
        COALESCE(SUM(rr.shortage_quantity), 0) AS pending_quantity
      FROM order_replenishment_records rr
      INNER JOIN order_batches ob ON ob.id = rr.batch_id
      INNER JOIN users u ON u.id = rr.user_id
      ${whereSql}
      GROUP BY rr.batch_id, rr.user_id, rr.status, ob.batch_no, ob.batch_id, ob.total_count, ob.estimated_amount, u.username, u.real_name
      ORDER BY requested_at DESC, id DESC
      LIMIT ${safePageSize} OFFSET ${offset}
    `,
    params,
  );

  return {
    items: rows.map((row) => ({
      batch_id: Number(row.batch_id),
      batch_no: row.batch_no,
      batch_uuid: row.batch_uuid,
      estimated_amount: round4(row.estimated_amount),
      id: Number(row.id),
      pending_order_count: Number(row.pending_order_count) || 0,
      pending_quantity: Number(row.pending_quantity) || 0,
      reason_message: row.reason_message || '',
      real_name: row.real_name || '',
      requested_at: row.requested_at,
      reviewed_at: row.reviewed_at || null,
      status: row.status,
      target_count: Number(row.target_count) || 0,
      user_id: Number(row.user_id),
      username: row.username || '',
    })),
    page: safePage,
    page_size: safePageSize,
    total: Number(countRow.total) || 0,
  };
};

// 提交批量订单（扣费、创建订单、调用上游任务API）
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
  const validPreviewItems = preview.items.filter((entry) => entry.valid);

  // 硬性拦截：没有博主ID的订单不允许创建
  const missingAuthorItems = validPreviewItems.filter(
    (item) => !String(item.author_id || '').trim(),
  );
  if (missingAuthorItems.length > 0) {
    const error = new Error(
      `${missingAuthorItems.length} 条订单缺少博主ID，不允许创建订单`,
    );
    error.statusCode = 400;
    throw error;
  }

  const submitSnapshots = await collectSubmitSnapshots(preview.target_type, validPreviewItems);

  if (['like', 'view'].includes(preview.target_type)) {
    const missingSnapshots = validPreviewItems.filter((item) => {
      const snap = submitSnapshots.get(item.line_no);
      if (!snap) return true;
      const count = preview.target_type === 'like' ? snap.like_count : snap.view_count;
      return count === null || count === undefined || !Number.isFinite(Number(count));
    });
    if (missingSnapshots.length > 0) {
      const error = new Error(
        `${missingSnapshots.length} 条订单无法获取基准快照（${preview.target_type === 'like' ? '点赞数' : '阅读数'}），不允许提交`,
      );
      error.statusCode = 400;
      throw error;
    }
  }

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
    const orderRows = [];

    for (const [index, item] of validPreviewItems.entries()) {
      const orderNo = `ORDER-${Date.now()}-${String(index + 1).padStart(3, '0')}`;
      const recordNo = `REC-${Date.now()}-${String(index + 1).padStart(3, '0')}`;
      const submitSnapshot = submitSnapshots.get(item.line_no) || {};

      const [insertResult] = await connection.execute(
        `
          INSERT INTO orders
            (
              order_no, user_id, batch_id, batch_item_id, note_id, note_url, target_type,
              title, author_id, author_name, avatar_url, like_count,
              ordered_quantity, completed_quantity, order_status, external_task_id,
              external_status, external_progress, external_completed_quantity,
              last_verified_at, reason_message, snapshot_current_read_count,
              snapshot_current_read_payload, snapshot_current_like_payload,
              created_at, updated_at
            )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          item.author_id || null,
          item.author_name || null,
          item.avatar_url || null,
          item.like_count,
          item.ordered_quantity,
          0,
          'running',
          null,
          null,
          0,
          0,
          null,
          null,
          submitSnapshot.view_count ?? null,
          preview.target_type === 'view' ? submitSnapshot.payload ?? null : null,
          preview.target_type === 'like' ? submitSnapshot.payload ?? null : null,
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
              source: params.source || `goodsAdmin:${order.id}`,
              targetType: preview.target_type,
            }),
            { token: createCurrentUserToken(userId) },
          );
          const externalTaskId = normalizeXhsTaskId(xhsResult?.id);
          if (!externalTaskId) {
            throw new Error('XHS API response missing task id (numeric)');
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
          throw new Error('XHS API response missing task id (numeric)');
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
        const failReason = taskResultByOrderId.get(order.id)?.error?.message || '上游任务创建失败';
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
            VALUES (?, ?, 'order_charge', 'debit', ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
          `,
          [
            order.recordNo,
            userId,
            order.id,
            order.orderNo,
            order.item.ordered_quantity,
            preview.unit_price,
            order.item.original_amount ?? preview.unit_price,
            preview.discount_rate,
            preview.discounted_unit_price,
            order.item.discount_amount,
            order.item.payable_amount,
            beforeBalance,
            beforeBalance,
            failReason,
            now,
            now,
          ],
        );
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
          order.item.original_amount ?? preview.unit_price,
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

// 执行批次补单操作（逐条检查并补单）
const replenishBatch = async (userId, batchId) => {
  const targetBatchId = Number(batchId);
  if (!targetBatchId) {
    const error = new Error('Invalid batch id');
    error.statusCode = 400;
    throw error;
  }

  const db = getPool();
  await ensureOrderSnapshotColumns(db);
  await ensureNoteBasicCacheTable(db);
  const [[batch]] = await db.execute(
    'SELECT id, batch_no FROM order_batches WHERE id = ? AND user_id = ?',
    [targetBatchId, userId],
  );
  if (!batch) {
    const error = new Error('Batch not found');
    error.statusCode = 404;
    throw error;
  }

  const [orders] = await db.execute(
    `
      SELECT o.id, o.batch_id, ob.batch_no, o.order_no, o.note_id, o.target_type,
        o.ordered_quantity, o.repair_count, o.like_count, o.snapshot_current_read_count,
        o.snapshot_verified_read_count, o.snapshot_verified_like_count,
        COALESCE(o.author_id, nbc.author_id) AS author_id
      FROM orders o
      INNER JOIN order_batches ob ON ob.id = o.batch_id
      LEFT JOIN note_basic_cache nbc ON nbc.note_id = o.note_id
      WHERE o.batch_id = ?
        AND o.user_id = ?
        AND o.target_type IN ('like', 'view')
        AND o.order_status IN ('running', 'completed', 'repair_review')
      ORDER BY o.batch_item_id ASC, o.id ASC
    `,
    [targetBatchId, userId],
  );

  const results = [];
  for (const order of orders) {
    try {
      const result = await replenishOrderIfNeeded(db, userId, order, { now: new Date() });
      results.push({
        order_id: Number(order.id),
        ...result,
      });
    } catch (error) {
      results.push({
        error: normalizeXhsErrorMessage(error),
        order_id: Number(order.id),
        replenished: false,
      });
    }
  }

  await refreshBatchStats(db, userId, [targetBatchId]);

  return {
    batch_id: targetBatchId,
    batch_no: batch.batch_no,
    checked_count: results.filter((result) => result.checked !== false).length,
    errors: results.filter((result) => result.error),
    replenished_count: results.filter((result) => result.replenished).length,
    results,
    total_replenish_quantity: results.reduce(
      (total, result) => total + (Number(result.replenish_quantity) || 0),
      0,
    ),
  };
};

// 审批并执行单条补单请求（需管理员权限）
const approveReplenishmentRequest = async (actorUserId, requestId) => {
  const targetRequestId = Number(requestId);
  if (!targetRequestId) {
    const error = new Error('Invalid replenish request id');
    error.statusCode = 400;
    throw error;
  }

  const db = getPool();
  await assertAdmin(db, actorUserId);
  await ensureReplenishmentRecordTable(db);

  const [[record]] = await db.execute(
    `
      SELECT rr.*, ob.batch_no
      FROM order_replenishment_records rr
      INNER JOIN order_batches ob ON ob.id = rr.batch_id
      WHERE rr.id = ?
      LIMIT 1
    `,
    [targetRequestId],
  );
  if (!record) {
    const error = new Error('Replenish request not found');
    error.statusCode = 404;
    throw error;
  }
  if (record.status !== 'pending') {
    const error = new Error('Replenish request is not pending');
    error.statusCode = 400;
    throw error;
  }

  const now = new Date();
  try {
    const result = await replenishBatch(record.user_id, record.batch_id);
    await db.execute(
      `
        UPDATE order_replenishment_records
        SET status = 'approved',
            reviewed_at = ?,
            reviewed_by = ?,
            result_json = ?,
            updated_at = ?
        WHERE batch_id = ?
          AND user_id = ?
          AND status = 'pending'
      `,
      [
        now,
        actorUserId,
        JSON.stringify(result).slice(0, 8000),
        now,
        record.batch_id,
        record.user_id,
      ],
    );

    return {
      batch_id: Number(record.batch_id),
      batch_no: record.batch_no,
      id: targetRequestId,
      result,
      status: 'approved',
    };
  } catch (error) {
    await db.execute(
      `
        UPDATE order_replenishment_records
        SET status = 'failed',
            reviewed_at = ?,
            reviewed_by = ?,
            reason_message = ?,
            updated_at = ?
        WHERE batch_id = ?
          AND user_id = ?
          AND status = 'pending'
      `,
      [now, actorUserId, normalizeXhsErrorMessage(error), now, record.batch_id, record.user_id],
    );
    throw error;
  }
};

// 按批次审批补单请求（需管理员权限）
const approveReplenishmentBatch = async (actorUserId, batchId) => {
  const db = getPool();
  await assertAdmin(db, actorUserId);
  await ensureReplenishmentRecordTable(db);
  const [[record]] = await db.execute(
    `
      SELECT id
      FROM order_replenishment_records
      WHERE batch_id = ?
        AND status = 'pending'
      ORDER BY id DESC
      LIMIT 1
    `,
    [Number(batchId)],
  );
  if (!record) {
    return replenishBatch(actorUserId, batchId);
  }
  return approveReplenishmentRequest(actorUserId, record.id);
};

// 重试批次中失败的订单（已自动退款的订单不可重试）
const retryBatch = async (userId, batchId) => {
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
          COALESCE(o.author_id, nbc.author_id, '') AS author_id,
          COUNT(ar.id) AS charge_count
        FROM orders o
        LEFT JOIN note_basic_cache nbc ON nbc.note_id = o.note_id
        LEFT JOIN account_records ar
          ON ar.order_id = o.id
          AND ar.record_type = 'order_charge'
          AND ar.status = 'success'
        WHERE o.batch_id = ?
          AND o.user_id = ?
          AND o.order_status IN ('failed', 'manual_review', 'repair_review')
        GROUP BY
          o.id, o.order_no, o.batch_item_id, o.note_id, o.note_url, o.target_type,
          o.ordered_quantity, o.external_task_id, o.author_id, nbc.author_id
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
                author_id: order.author_id || '',
                note_id: order.note_id,
                note_url: order.note_url,
                ordered_quantity: Number(order.ordered_quantity) || 0,
              },
              orderNo: order.order_no,
              source: `goodsAdmin:retry:${order.id}`,
              targetType,
            }),
            { token: createCurrentUserToken(userId) },
          );
          externalTaskId = normalizeXhsTaskId(xhsResult?.id);
          if (!externalTaskId) {
            throw new Error('XHS API response missing task id (numeric)');
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
        const { discountAmount, originalAmount, payableAmount } = calculateOrderAmounts(
          context,
          orderedQuantity,
        );
        const item = {
          discount_amount: discountAmount,
          ordered_quantity: orderedQuantity,
          original_amount: originalAmount,
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
  approveReplenishmentBatch,
  approveReplenishmentRequest,
  batchApproveRefunds,
  buildPreview,
  getBatchOrders,
  listBatchOrderRecords,
  listBatchLinkCheckRecords,
  listConsumptionRecords,
  listProblemLinkRecords,
  listReplenishmentRequests,
  listRefundRecords,
  requestBatchRefund,
  requestReplenishBatch,
  requestOrderRefund,
  reviewOrderRefund,
  searchBatchOrdersByLinks,
  replenishBatch,
  retryBatch,
  saveProblemLinkRecords,
  submitBatch,
  _private: {
    ensureBatchLinkCheckRecordTable,
    ensureNoteBasicCacheTable,
    ensureProblemLinkRecordTable,
    ensureReplenishmentRecordTable,
    fetchNoteMetricsByUrl,
    requestNoteBasic,
    requestNoteId,
    requestNoteLikeCount,
    stopXhsTask,
    syncRunningOrdersFromXhs,
    requestNoteRealtimeViewCount,
    setXhsTaskClient,
  },
};
