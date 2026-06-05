/**
 * 清理「超时未完成」订单：order_status='running' 且 completed<ordered 且 created_at 超过 N 天。
 * 把它们 order_status 改为 'cancelled'（已终止）。
 *
 * 安全措施同 cleanup-pending.js：单事务、先整行备份进 order_cleanup_records、更新数=备份数否则回滚、
 * 默认 DRY-RUN，加参数 execute 才写。归档表保留原状态，可恢复。
 *
 * 用法：
 *   预览：node scripts/cleanup-stale-running.js
 *   执行：node scripts/cleanup-stale-running.js execute
 *   天数阈值默认 7，可用环境变量 STALE_DAYS 调整。
 */
const mysql = require('mysql2/promise');

const EXECUTE = process.argv.includes('execute');
const DAYS = Number.isFinite(Number(process.env.STALE_DAYS)) && Number(process.env.STALE_DAYS) > 0
  ? Math.floor(Number(process.env.STALE_DAYS)) : 7;
const NEW_STATUS = 'cancelled';
const REASON = '批量清理超时未完成订单（已终止）';

(async () => {
  console.log(`阈值: created_at 超过 ${DAYS} 天 | 模式: ${EXECUTE ? '*** EXECUTE 真正写入 ***' : 'DRY-RUN 仅预览'}`);

  const pool = await mysql.createPool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    connectionLimit: 4, connectTimeout: 15000,
  });
  const conn = await pool.getConnection();

  try {
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

    await conn.beginTransaction();

    const [targets] = await conn.query(
      `SELECT * FROM orders
       WHERE order_status = 'running'
         AND completed_quantity < ordered_quantity
         AND created_at < (NOW() - INTERVAL ${DAYS} DAY)
       FOR UPDATE`,
    );
    const totalShortage = targets.reduce(
      (s, o) => s + (Number(o.ordered_quantity) - Number(o.completed_quantity)), 0,
    );
    console.log(`匹配待终止: ${targets.length} 行，缺口合计: ${totalShortage}`);

    if (!EXECUTE) {
      console.log('[DRY-RUN] 未做任何写入。确认无误后加参数 execute 重新运行。');
      await conn.rollback();
      return;
    }

    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const batchTag = `CLEANUP-STALE-${stamp}`;
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
    const ph = ids.map(() => '?').join(',');
    const [upd] = await conn.query(
      `UPDATE orders SET order_status = '${NEW_STATUS}', reason_message = ?, updated_at = ?
       WHERE id IN (${ph}) AND order_status = 'running'`,
      [REASON, now, ...ids],
    );

    console.log(`备份行数: ${archived}，更新行数: ${upd.affectedRows}`);
    if (upd.affectedRows !== archived) {
      console.log('⚠️ 更新行数与备份不一致，已回滚');
      await conn.rollback();
      process.exitCode = 1;
      return;
    }

    await conn.commit();
    console.log(`\n✅ 清理完成。cleanup_batch = ${batchTag}`);
    console.log(`   已终止 ${archived} 行，归档表保留原状态可恢复`);
  } catch (e) {
    try { await conn.rollback(); } catch { /* ignore */ }
    console.error('错误，已回滚:', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
})();
