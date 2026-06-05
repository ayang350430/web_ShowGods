/**
 * 只读核对：result-pending.csv 里的未跑完链接，对应 orders 表中哪些「未完成订单行」
 * （completed_quantity < ordered_quantity）。统计状态分布、行数、缺口，供决策。
 * 不做任何写操作。
 */
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

(async () => {
  const csv = fs.readFileSync(path.join(__dirname, 'result-pending.csv'), 'utf-8');
  const rows = csv.split(/\r?\n/).slice(1).filter(Boolean);
  // 列: URL,期望下单量,实际下单量,完成量,缺少量,订单数,类型,note_id,状态
  const noteIds = [...new Set(rows.map((l) => l.split(',')[7]).filter(Boolean))];
  console.log(`result-pending.csv: ${rows.length} 个链接，${noteIds.length} 个 note_id`);

  const pool = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    connectionLimit: 4, connectTimeout: 15000,
  });

  try {
    const B = 500;
    const allRows = [];
    for (let i = 0; i < noteIds.length; i += B) {
      const batch = noteIds.slice(i, i + B);
      const ph = batch.map(() => '?').join(',');
      const [r] = await pool.query(
        `SELECT id, order_no, user_id, note_id, target_type,
                ordered_quantity, completed_quantity,
                (ordered_quantity - completed_quantity) AS shortage,
                order_status, external_status, refunded_quantity,
                refund_lock_status, created_at
         FROM orders
         WHERE note_id IN (${ph})
           AND completed_quantity < ordered_quantity
         ORDER BY (ordered_quantity - completed_quantity) DESC`,
        batch,
      );
      allRows.push(...r);
    }

    console.log(`\n未完成订单行（completed < ordered）共 ${allRows.length} 行`);

    // 状态分布
    const byStatus = {};
    let totalShortage = 0;
    let totalOrdered = 0;
    let totalCompleted = 0;
    for (const r of allRows) {
      byStatus[r.order_status] = (byStatus[r.order_status] || 0) + 1;
      totalShortage += Number(r.shortage) || 0;
      totalOrdered += Number(r.ordered_quantity) || 0;
      totalCompleted += Number(r.completed_quantity) || 0;
    }
    console.log('\n按 order_status 分布:');
    for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${v} 行`);
    }

    // 退款锁状态分布
    const byRefundLock = {};
    for (const r of allRows) {
      byRefundLock[r.refund_lock_status] = (byRefundLock[r.refund_lock_status] || 0) + 1;
    }
    console.log('\n按 refund_lock_status 分布:');
    for (const [k, v] of Object.entries(byRefundLock)) {
      console.log(`  ${k}: ${v} 行`);
    }

    console.log('\n合计:');
    console.log(`  下单量: ${totalOrdered}`);
    console.log(`  完成量: ${totalCompleted}`);
    console.log(`  缺口量: ${totalShortage}`);

    console.log('\n缺口最大的前 15 行:');
    console.log('  order_id\t下单\t完成\t缺口\t状态\t外部状态');
    for (const r of allRows.slice(0, 15)) {
      console.log(`  ${r.id}\t${r.ordered_quantity}\t${r.completed_quantity}\t${r.shortage}\t${r.order_status}\t${r.external_status}`);
    }
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error('错误:', e.message); process.exit(1); });
