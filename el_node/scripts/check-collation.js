const mysql = require('mysql2/promise');

(async () => {
  const p = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const db = process.env.DB_NAME;

  const [t] = await p.query(
    'SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_COLLATION, TABLE_NAME',
    [db],
  );
  console.log('=== 各表 collation ===');
  for (const x of t) console.log(`  ${x.TABLE_NAME}: ${x.TABLE_COLLATION}`);

  // 找出与多数不一致的字符串列
  const [c] = await p.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND COLLATION_NAME IS NOT NULL
     ORDER BY COLLATION_NAME, TABLE_NAME, COLUMN_NAME`,
    [db],
  );
  const byColl = {};
  for (const x of c) byColl[x.COLLATION_NAME] = (byColl[x.COLLATION_NAME] || 0) + 1;
  console.log('\n=== 字符串列 collation 计数 ===');
  for (const [k, v] of Object.entries(byColl)) console.log(`  ${k}: ${v} 列`);

  // 重点：order_cleanup_records 的 collation
  console.log('\n=== order_cleanup_records 列 collation ===');
  for (const x of c.filter((r) => r.TABLE_NAME === 'order_cleanup_records')) {
    console.log(`  ${x.COLUMN_NAME}: ${x.COLLATION_NAME}`);
  }

  await p.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
