/**
 * 清理「未完成订单」：把 result-pending.csv 对应的 running 未完成订单
 * （completed_quantity < ordered_quantity）order_status 改为 'cancelled'（已终止）。
 *
 * 安全措施：
 *   - 单事务：先把每一行完整快照备份进 order_cleanup_records（含 raw_order JSON），再改状态。
 *   - WHERE 双保险：只改 order_status 仍为 'running' 的行。
 *   - 更新行数必须等于备份行数，否则回滚。
 *   - 默认 DRY-RUN（只预览不写）；加参数 execute 才真正执行。
 *   - 归档表保留原始 order_status，可随时恢复。
 *
 * 用法：
 *   预览：node scripts/cleanup-pending.js
 *   执行：node scripts/cleanup-pending.js execute
 */
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const EXECUTE = process.argv.includes('execute');
const NEW_STATUS = 'cancelled';
const REASON = '批量清理未完成订单（已终止）';

(async () => {
  const csv = fs.readFileSync(path.join(__dirname, 'result-pending.csv'), 'utf-8');
  const noteIds = [
    ...new Set(
      csv.split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')[7]).filter(Boolean),
    ),
  ];
  console.log(`输入 note_id: ${noteIds.length} 个`);
  console.log(`模式: ${EXECUTE ? '*** EXECUTE 真正写入 ***' : 'DRY-RUN 仅预览'}`);

  const pool = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    connectionLimit: 4, connectTimeout: 15000,
  });
  const conn = await pool.getConnection();

  try {
    // 1. 建归档表（幂等）
    await conn.query(`
      CREATE TABLE IF NOT EXISTS order_cleanup_records (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        cleanup_batch VARCHAR(64) NOT NULL COMMENT '清理批次',
        order_id BIGINT UNSIGNED NOT NULL COMMENT '原订单ID',
        order_no VARCHAR(64) DEFAULT NULL COMMENT '订单号',
        user_id BIGINT UNSIGNED DEFAULT NULL COMMENT '用户ID',
        note_id VARCHAR(64) DEFAULT NULL COMMENT '笔记ID',
        note_url VARCHAR(1024) DEFAULT NULL COMMENT '笔记链接',
        target_type VARCHAR(32) DEFAULT NULL COMMENT '目标类型',
        ordered_quantity INT UNSIGNED DEFAULT 0 COMMENT '下单量',
        completed_quantity INT UNSIGNED DEFAULT 0 COMMENT '完成量',
        shortage INT DEFAULT 0 COMMENT '缺口量(下单-完成)',
        original_order_status VARCHAR(32) DEFAULT NULL COMMENT '清理前订单状态',
        original_external_status VARCHAR(32) DEFAULT NULL COMMENT '清理前外部状态',
        new_order_status VARCHAR(32) DEFAULT NULL COMMENT '清理后订单状态',
        action VARCHAR(32) DEFAULT NULL COMMENT '清理动作',
        raw_order JSON DEFAULT NULL COMMENT '原订单整行快照',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '清理时间',
        PRIMARY KEY (id),
        KEY idx_cleanup_batch (cleanup_batch),
        KEY idx_order_id (order_id),
        KEY idx_note_id (note_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='未完成订单清理归档表'
    `);
    console.log('归档表 order_cleanup_records 就绪');

    await conn.beginTransaction();

    // 2. 锁定并取出目标行
    const ph = noteIds.map(() => '?').join(',');
    const [targets] = await conn.query(
      `SELECT * FROM orders
       WHERE note_id IN (${ph})
         AND completed_quantity < ordered_quantity
         AND order_status = 'running'
       FOR UPDATE`,
      noteIds,
    );
    console.log(`匹配到待清理订单: ${targets.length} 行`);

    const totalShortage = targets.reduce(
      (s, o) => s + (Number(o.ordered_quantity) - Number(o.completed_quantity)), 0,
    );
    console.log(`缺口合计: ${totalShortage}`);

    if (!EXECUTE) {
      console.log('\n[DRY-RUN] 将执行：');
      console.log(`  1) 把以上 ${targets.length} 行完整快照写入 order_cleanup_records`);
      console.log(`  2) UPDATE orders SET order_status='${NEW_STATUS}' （仅 running 行）`);
      console.log('  未做任何写入。确认无误后加参数 execute 重新运行。');
      await conn.rollback();
      return;
    }

    // 3. 备份 + 改状态（同一事务）
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const batchTag = `CLEANUP-${stamp}`;
    const now = new Date();
    let archived = 0;
    for (const o of targets) {
      await conn.query(
        `INSERT INTO order_cleanup_records
          (cleanup_batch, order_id, order_no, user_id, note_id, note_url, target_type,
           ordered_quantity, completed_quantity, shortage,
           original_order_status, original_external_status, new_order_status, action, raw_order, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          batchTag, o.id, o.order_no, o.user_id, o.note_id, o.note_url, o.target_type,
          o.ordered_quantity, o.completed_quantity,
          Number(o.ordered_quantity) - Number(o.completed_quantity),
          o.order_status, o.external_status, NEW_STATUS, 'status_terminated',
          JSON.stringify(o), now,
        ],
      );
      archived += 1;
    }

    const ids = targets.map((o) => o.id);
    const ph2 = ids.map(() => '?').join(',');
    const [upd] = await conn.query(
      `UPDATE orders SET order_status = '${NEW_STATUS}', reason_message = ?, updated_at = ?
       WHERE id IN (${ph2}) AND order_status = 'running'`,
      [REASON, now, ...ids],
    );

    console.log(`\n备份行数: ${archived}，更新行数: ${upd.affectedRows}`);
    if (upd.affectedRows !== archived) {
      console.log('⚠️ 更新行数与备份不一致，已回滚，未做任何改动');
      await conn.rollback();
      process.exitCode = 1;
      return;
    }

    await conn.commit();
    console.log(`\n✅ 清理完成。cleanup_batch = ${batchTag}`);
    console.log(`   - 已归档 ${archived} 行到 order_cleanup_records`);
    console.log(`   - 已把这些订单 order_status 改为 '${NEW_STATUS}'`);
    console.log(`   - 恢复方法：按 cleanup_batch 从归档表取 original_order_status 改回即可`);
  } catch (e) {
    try { await conn.rollback(); } catch { /* ignore */ }
    console.error('错误，已回滚:', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
})();
