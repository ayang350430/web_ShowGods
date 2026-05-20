const mysql = require('mysql2/promise');
require('dotenv').config();

const BATCH_NO = process.argv[2] || 'BATCH-MPDU20GN-D6';
const BASE_URL = process.env.XHS_API_BASE_URL || 'http://185.213.63.243:9101';
const TOKEN = process.env.XHS_API_TOKEN || 'xhs-api-123456789';
const ENDPOINTS = { impression: '/api/v2/impression', like: '/api/v2/note_likes', view: '/api/v2/note_views' };
const TIMEOUT = 15000;
const CONCURRENCY = 20;

const STATUS_LABELS = { 0: '未知', 1: '运行中', 2: '已完成', 3: '已停止' };

async function fetchTaskStatus(targetType, taskId) {
  const endpoint = ENDPOINTS[targetType] || ENDPOINTS.view;
  const url = `${BASE_URL}${endpoint}?id=${taskId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, signal: controller.signal });
    const body = await res.json().catch(() => null);
    const data = body?.data ?? body ?? {};
    return { status: Number(data.status ?? body?.status ?? 0) || 0, current_count: Number(data.current_count ?? 0) || 0, total_count: Number(data.total_count ?? 0) || 0 };
  } catch (e) {
    return { status: -1, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const db = await mysql.createPool({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

  const [[batch]] = await db.execute('SELECT id FROM order_batches WHERE batch_no = ?', [BATCH_NO]);
  if (!batch) { console.error('Batch not found:', BATCH_NO); process.exit(1); }

  const [orders] = await db.execute(
    `SELECT id, order_no, external_task_id, target_type, order_status, ordered_quantity, completed_quantity, external_completed_quantity
     FROM orders WHERE batch_id = ? ORDER BY id ASC`,
    [batch.id],
  );

  console.log(`Batch: ${BATCH_NO}, Orders: ${orders.length}`);
  const withTask = orders.filter((o) => o.external_task_id);
  const noTask = orders.filter((o) => !o.external_task_id);
  console.log(`With upstream task: ${withTask.length}, No task: ${noTask.length}\n`);

  const results = [];
  for (let i = 0; i < withTask.length; i += CONCURRENCY) {
    const chunk = withTask.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.allSettled(
      chunk.map(async (order) => {
        const targetType = (order.target_type || 'view').toLowerCase();
        const upstream = await fetchTaskStatus(targetType, order.external_task_id);
        return { ...order, upstream };
      }),
    );
    for (const r of chunkResults) {
      results.push(r.status === 'fulfilled' ? r.value : { ...chunk[0], upstream: { status: -1, error: 'promise rejected' } });
    }
  }

  const summary = { running: 0, completed: 0, stopped: 0, unknown: 0, error: 0 };
  const rows = results.map((r) => {
    const s = r.upstream.status;
    if (s === 1) summary.running++;
    else if (s === 2) summary.completed++;
    else if (s === 3) summary.stopped++;
    else if (s === -1) summary.error++;
    else summary.unknown++;
    return {
      order_id: r.id,
      order_no: r.order_no,
      order_status: r.order_status,
      task_id: r.external_task_id,
      upstream_status: STATUS_LABELS[s] || `${s}`,
      current: r.upstream.current_count ?? '-',
      total: r.upstream.total_count ?? '-',
      ordered: r.ordered_quantity,
    };
  });

  console.table(rows.slice(0, 30));
  if (rows.length > 30) console.log(`... and ${rows.length - 30} more`);

  console.log('\n=== SUMMARY ===');
  console.log(`Running: ${summary.running}, Completed: ${summary.completed}, Stopped: ${summary.stopped}, Unknown: ${summary.unknown}, Error: ${summary.error}`);

  const stillRunning = results.filter((r) => r.upstream.status === 1);
  if (stillRunning.length > 0) {
    console.log(`\n⚠ ${stillRunning.length} tasks still RUNNING upstream:`);
    for (const r of stillRunning.slice(0, 10)) {
      console.log(`  Order ${r.order_no} (task ${r.external_task_id}): ${r.upstream.current_count}/${r.upstream.total_count}`);
    }
  }

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
