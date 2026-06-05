const mysql = require('mysql2/promise');

(async () => {
  const p = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });

  const [[s]] = await p.query(`
    SELECT COUNT(*) total,
      SUM(completed_quantity >= ordered_quantity) reached,
      SUM(completed_quantity <  ordered_quantity) not_reached,
      COALESCE(SUM(CASE WHEN completed_quantity < ordered_quantity THEN ordered_quantity - completed_quantity ELSE 0 END),0) shortage,
      COALESCE(SUM(external_status = 'completed'),0) ext_completed
    FROM orders WHERE order_status = 'running'
  `);
  console.log('=== running 订单构成 ===');
  console.log(`  总数: ${s.total}`);
  console.log(`  已达标 completed>=下单 (会自动转完成，不该清理): ${s.reached}`);
  console.log(`  未达标 completed<下单 (真没跑完): ${s.not_reached}`);
  console.log(`  未达标缺口合计: ${s.shortage}`);
  console.log(`  外部状态已完成(ext=completed): ${s.ext_completed}`);

  const [[age]] = await p.query(`
    SELECT
      SUM(created_at >= NOW() - INTERVAL 1 DAY) d1,
      SUM(created_at <  NOW() - INTERVAL 1 DAY AND created_at >= NOW() - INTERVAL 3 DAY) d1_3,
      SUM(created_at <  NOW() - INTERVAL 3 DAY AND created_at >= NOW() - INTERVAL 7 DAY) d3_7,
      SUM(created_at <  NOW() - INTERVAL 7 DAY) d7
    FROM orders WHERE order_status = 'running'
  `);
  console.log('\n=== running 订单年龄分布 ===');
  console.log(`  <1天: ${age.d1} | 1-3天: ${age.d1_3} | 3-7天: ${age.d3_7} | >7天: ${age.d7}`);

  const [rows] = await p.query(`
    SELECT id, ordered_quantity o, completed_quantity c, (ordered_quantity - completed_quantity) sh,
           external_status, DATEDIFF(NOW(), created_at) age
    FROM orders WHERE order_status = 'running' AND completed_quantity < ordered_quantity
    ORDER BY (ordered_quantity - completed_quantity) DESC LIMIT 15
  `);
  console.log('\n=== 未达标(真没跑完)缺口最大前15 ===');
  console.log('  id\t下单\t完成\t缺口\t外部状态\t天数');
  for (const r of rows) {
    console.log(`  ${r.id}\t${r.o}\t${r.c}\t${r.sh}\t${r.external_status}\t${r.age}`);
  }

  await p.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
