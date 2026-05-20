const mysql = require('mysql2/promise');
require('dotenv').config();

const round4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const db = await mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const batchNo = 'BATCH-MPDRV2SB-C3';
  const [[batch]] = await db.execute('SELECT id FROM order_batches WHERE batch_no = ?', [batchNo]);
  if (!batch) { console.error('Batch not found'); process.exit(1); }

  const [rows] = await db.execute(`
    SELECT
      o.id AS order_id, o.order_no, o.user_id, o.ordered_quantity,
      GREATEST(o.completed_quantity, o.external_completed_quantity, 0) AS completed_qty,
      COALESCE(charges.total_charged, 0) AS total_charged,
      COALESCE(charges.first_charge_id, 0) AS charge_record_id,
      COALESCE(charges.unit_price, 0) AS unit_price,
      COALESCE(charges.discount_rate, 0) AS discount_rate,
      COALESCE(refunds.total_refunded, 0) AS total_refunded
    FROM orders o
    LEFT JOIN (
      SELECT order_id,
        SUM(actual_paid_amount) AS total_charged,
        MIN(id) AS first_charge_id,
        MIN(discounted_unit_price) AS unit_price,
        MIN(discount_rate) AS discount_rate
      FROM account_records WHERE record_type = 'order_charge' AND status = 'success'
      GROUP BY order_id
    ) charges ON charges.order_id = o.id
    LEFT JOIN (
      SELECT order_id, SUM(refund_amount) AS total_refunded
      FROM account_records WHERE record_type = 'refund' AND status = 'success'
      GROUP BY order_id
    ) refunds ON refunds.order_id = o.id
    WHERE o.batch_id = ?
  `, [batch.id]);

  const repairs = [];
  for (const row of rows) {
    const orderedQty = Number(row.ordered_quantity) || 0;
    const completedQty = Number(row.completed_qty) || 0;
    const refundableQty = Math.max(orderedQty - completedQty, 0);
    const grossRefund = orderedQty > 0
      ? round4((Number(row.total_charged) * refundableQty) / orderedQty)
      : 0;
    const stillOwed = round4(grossRefund - Number(row.total_refunded));
    if (stillOwed > 0.001) {
      repairs.push({ ...row, refundableQty, grossRefund, stillOwed });
    }
  }

  console.log(`Found ${repairs.length} orders needing supplementary refund`);
  const totalOwed = round4(repairs.reduce((s, r) => s + r.stillOwed, 0));
  console.log(`Total to refund: ¥${totalOwed}`);

  if (repairs.length === 0) {
    console.log('Nothing to repair.');
    await db.end();
    return;
  }

  if (DRY_RUN) {
    console.log('\n--- DRY RUN (no changes) ---');
    for (const r of repairs.slice(0, 10)) {
      console.log(`  Order ${r.order_no}: charged ¥${r.total_charged}, refunded ¥${r.total_refunded}, owed ¥${r.stillOwed}`);
    }
    if (repairs.length > 10) console.log(`  ... and ${repairs.length - 10} more`);
    await db.end();
    return;
  }

  console.log('\nExecuting repair...');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const userTotals = new Map();
    for (const r of repairs) {
      const prev = userTotals.get(Number(r.user_id)) || 0;
      userTotals.set(Number(r.user_id), round4(prev + r.stillOwed));
    }

    const userIds = [...userTotals.keys()];
    const [balanceRows] = await connection.execute(
      `SELECT user_id, available_amount FROM balance_accounts WHERE user_id IN (${userIds.map(() => '?').join(',')}) FOR UPDATE`,
      userIds,
    );
    const balanceMap = new Map();
    for (const b of balanceRows) {
      balanceMap.set(Number(b.user_id), round4(b.available_amount));
    }

    const userRunning = new Map();
    const now = new Date();
    let insertCount = 0;

    for (const r of repairs) {
      const userId = Number(r.user_id);
      const prevAdd = userRunning.get(userId) || 0;
      const beforeBalance = round4((balanceMap.get(userId) || 0) + prevAdd);
      const afterBalance = round4(beforeBalance + r.stillOwed);
      userRunning.set(userId, round4(prevAdd + r.stillOwed));

      const recordNo = `REPAIR-${Date.now()}-${String(r.order_id).padStart(3, '0')}`;
      await connection.execute(
        `INSERT INTO account_records
          (record_no, user_id, record_type, direction, order_id, order_no,
           related_record_id, status, ordered_quantity, completed_quantity, refunded_quantity,
           original_unit_price, original_total_amount, discount_rate, discounted_unit_price,
           discount_amount, payable_amount, actual_paid_amount, refund_amount, net_amount,
           before_available_amount, after_available_amount, reason_message, remark, created_at, updated_at)
         VALUES (?, ?, 'refund', 'credit', ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, '补退差额修正', '', ?, ?)`,
        [
          recordNo, userId, r.order_id, r.order_no, r.charge_record_id,
          r.ordered_quantity, r.completed_qty, r.refundableQty,
          r.unit_price, r.stillOwed, r.discount_rate,
          r.unit_price, r.stillOwed, r.stillOwed, r.stillOwed,
          beforeBalance, afterBalance, now, now,
        ],
      );

      await connection.execute(
        'UPDATE orders SET refund_amount_total = refund_amount_total + ?, updated_at = ? WHERE id = ?',
        [r.stillOwed, now, r.order_id],
      );
      insertCount++;
    }

    for (const [userId, totalRefund] of userTotals) {
      await connection.execute(
        'UPDATE balance_accounts SET available_amount = available_amount + ?, updated_at = ? WHERE user_id = ?',
        [totalRefund, now, userId],
      );
    }

    await connection.commit();
    console.log(`Done! Created ${insertCount} supplementary refund records, total ¥${totalOwed} returned to balance.`);
  } catch (error) {
    await connection.rollback();
    console.error('Repair failed, rolled back:', error.message);
    throw error;
  } finally {
    connection.release();
    await db.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
