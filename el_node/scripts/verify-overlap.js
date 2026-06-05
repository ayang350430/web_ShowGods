/**
 * 验证：117 个超时单(CLEANUP-STALE)有多少在 urls.txt 清单内、多少在清单外。
 * 解释为什么第一次按清单导出的 result-pending.csv 没包含它们。
 */
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const normUrl = (s) => String(s || '').trim().replace(/[\s.]+$/, '');
const firstField = (s) => String(s || '').split('\t')[0].trim().split(/\s+/)[0];

(async () => {
  const p = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });

  // 1. 你清单 urls.txt 的短链集合
  const csv = fs.readFileSync(path.join(__dirname, 'urls.txt'), 'utf-8');
  const urls = new Set(
    csv.split(/\r?\n/).map((l) => normUrl(l.split('\t')[0])).filter((u) => u && !/^url/i.test(u)),
  );
  console.log(`urls.txt 链接数(去重): ${urls.size}`);

  // 2. 通过 batch_link_check_records 把清单短链解析成 note_id 集合
  const userNoteIds = new Set();
  let lastId = 0;
  for (;;) {
    const [rows] = await p.query(
      "SELECT id, raw_content, note_url, note_id FROM batch_link_check_records WHERE id > ? AND note_id IS NOT NULL AND note_id <> '' ORDER BY id ASC LIMIT 5000",
      [lastId],
    );
    if (!rows.length) break;
    for (const r of rows) {
      if (urls.has(normUrl(firstField(r.raw_content)))) userNoteIds.add(r.note_id);
      if (urls.has(normUrl(r.note_url))) userNoteIds.add(r.note_id);
      lastId = r.id;
    }
    if (rows.length < 5000) break;
  }
  console.log(`你清单解析出的 note_id 数: ${userNoteIds.size}`);

  // 3. 117 个超时单的 note_id
  const [stale] = await p.query(
    "SELECT DISTINCT note_id FROM order_cleanup_records WHERE cleanup_batch LIKE 'CLEANUP-STALE-%' AND note_id IS NOT NULL AND note_id <> ''",
  );
  const staleIds = stale.map((r) => r.note_id);
  const inList = staleIds.filter((id) => userNoteIds.has(id)).length;
  console.log(`\n117 个超时单的 note_id 数: ${staleIds.length}`);
  console.log(`  在你清单内的: ${inList}`);
  console.log(`  清单外的(你那份没列): ${staleIds.length - inList}`);

  // 4. 对“清单内”的，看第一次为何没算缺口：按 note_id 聚合的 completed vs ordered
  if (inList > 0) {
    const inListIds = staleIds.filter((id) => userNoteIds.has(id));
    const ph = inListIds.map(() => '?').join(',');
    const [agg] = await p.query(
      `SELECT note_id,
              SUM(ordered_quantity) o, SUM(completed_quantity) c,
              SUM(ordered_quantity) - SUM(completed_quantity) shortage
       FROM orders WHERE note_id IN (${ph}) GROUP BY note_id`,
      inListIds,
    );
    const aggNoShort = agg.filter((r) => Number(r.shortage) <= 0).length;
    console.log(`  其中清单内的 ${inListIds.length} 个里，按笔记聚合后“无缺口”(被同笔记完成订单抵消)的: ${aggNoShort}`);
  }

  await p.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
