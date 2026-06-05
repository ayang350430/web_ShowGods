const mysql = require('mysql2/promise');

(async () => {
  const p = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });

  // 被清理订单涉及的批次，及这些批次当前的订单构成 + 批次存储状态
  const [rows] = await p.query(`
    SELECT ob.id AS batch_id, ob.batch_no, ob.status AS batch_status,
           ob.total_count, ob.succeeded_count, ob.processing_count, ob.failed_count,
           COUNT(*) AS orders_in_batch,
           SUM(o.order_status = 'running')   AS running_cnt,
           SUM(o.order_status = 'cancelled') AS cancelled_cnt,
           SUM(o.order_status = 'completed') AS completed_cnt,
           SUM(o.order_status LIKE 'refund%') AS refund_cnt
    FROM orders o
    JOIN order_batches ob ON ob.id = o.batch_id
    WHERE o.batch_id IN (
      SELECT DISTINCT batch_id FROM orders
      WHERE order_status = 'cancelled' AND reason_message LIKE '%批量清理%'
    )
    GROUP BY ob.id, ob.batch_no, ob.status, ob.total_count, ob.succeeded_count, ob.processing_count, ob.failed_count
    ORDER BY running_cnt DESC, cancelled_cnt DESC
  `);

  console.log(`被清理订单涉及 ${rows.length} 个批次:\n`);
  console.log('batch_no\t批次状态\t总订单\t运行中\t已终止\t已完成\t退款\t(批次存储)proc/succ/total');
  let noRunning = 0;
  for (const r of rows) {
    if (Number(r.running_cnt) === 0) noRunning += 1;
    console.log(
      `${r.batch_no}\t${r.batch_status}\t${r.orders_in_batch}\t${r.running_cnt}\t${r.cancelled_cnt}\t${r.completed_cnt}\t${r.refund_cnt}\t${r.processing_count}/${r.succeeded_count}/${r.total_count}`,
    );
  }
  console.log(`\n其中已无 running 订单的批次: ${noRunning} / ${rows.length}`);
  console.log('（这些批次若状态仍是 processing，就是前端显示「处理中」的原因）');

  await p.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
