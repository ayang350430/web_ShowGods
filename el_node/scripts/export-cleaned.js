/**
 * 导出已清理(终止)的订单明细。
 * 用法：
 *   node scripts/export-cleaned.js          -> 导出117个超时单 (cleaned-stale-117.csv)
 *   node scripts/export-cleaned.js PENDING  -> 导出43个清单缺口单 (cleaned-pending-43.csv)
 *   node scripts/export-cleaned.js ALL      -> 导出全部160个 (cleaned-all.csv)
 */
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const MODE = (process.argv[2] || 'STALE').toUpperCase();
const targetLabel = (t) => (t === 'impression' ? '曝光' : t === 'like' ? '点赞' : '阅读');
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

(async () => {
  const p = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });

  let where;
  let fname;
  if (MODE === 'PENDING') {
    where = "cleanup_batch NOT LIKE 'CLEANUP-STALE-%'";
    fname = 'cleaned-pending-43.csv';
  } else if (MODE === 'ALL') {
    where = '1=1';
    fname = 'cleaned-all.csv';
  } else {
    where = "cleanup_batch LIKE 'CLEANUP-STALE-%'";
    fname = 'cleaned-stale-117.csv';
  }

  const [rows] = await p.query(
    `SELECT order_id, order_no, user_id, note_id, note_url, target_type,
            ordered_quantity, completed_quantity, shortage,
            original_order_status, new_order_status, cleanup_batch, created_at
     FROM order_cleanup_records WHERE ${where}
     ORDER BY shortage DESC`,
  );

  const header = '订单ID,订单号,用户ID,note_id,笔记链接,类型,下单量,完成量,缺口量,原状态,现状态,清理批次,清理时间';
  const lines = rows.map((r) =>
    [
      r.order_id, r.order_no, r.user_id, r.note_id, r.note_url, targetLabel(r.target_type),
      r.ordered_quantity, r.completed_quantity, r.shortage,
      r.original_order_status, r.new_order_status, r.cleanup_batch,
      r.created_at ? new Date(r.created_at).toLocaleString('zh-CN') : '',
    ].map(csvCell).join(','),
  );

  const out = path.join(__dirname, fname);
  fs.writeFileSync(out, `﻿${header}\n${lines.join('\n')}\n`, 'utf-8');

  const totalShortage = rows.reduce((s, r) => s + (Number(r.shortage) || 0), 0);
  console.log(`导出 ${rows.length} 行 -> ${out}`);
  console.log(`缺口合计: ${totalShortage}`);
  await p.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
