const mysql = require('mysql2/promise');

(async () => {
  const p = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });

  const [a] = await p.query('SELECT order_status, COUNT(*) c FROM orders GROUP BY order_status ORDER BY c DESC');
  console.log('=== orders 状态分布(清理后) ===');
  for (const x of a) console.log(`  ${x.order_status}: ${x.c}`);

  const [b] = await p.query('SELECT cleanup_batch, COUNT(*) c FROM order_cleanup_records GROUP BY cleanup_batch');
  console.log('=== 归档表 order_cleanup_records ===');
  for (const x of b) console.log(`  ${x.cleanup_batch}: ${x.c} 行`);

  const [c] = await p.query(
    'SELECT order_id, original_order_status, new_order_status, ordered_quantity, completed_quantity, shortage FROM order_cleanup_records ORDER BY shortage DESC LIMIT 3',
  );
  console.log('=== 抽查归档前3行（缺口最大）===');
  for (const x of c) {
    console.log(`  order_id=${x.order_id} ${x.original_order_status}->${x.new_order_status} 下单${x.ordered_quantity}/完成${x.completed_quantity}/缺${x.shortage}`);
  }

  await p.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
