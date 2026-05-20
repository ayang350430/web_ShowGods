const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
  const db = await mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  // 1. Find the batch
  const [batches] = await db.execute(
    `SELECT id, batch_no FROM order_batches WHERE batch_no = ?`,
    ['BATCH-MPDRV2SB-C3']
  );
  console.log('=== BATCH INFO ===');
  console.log(batches[0]);

  const batchId = batches[0].id;

  // 2. Orders summary
  const [orderSummary] = await db.execute(`
    SELECT
      COUNT(*) AS total_orders,
      SUM(ordered_quantity) AS total_ordered,
      SUM(completed_quantity) AS total_completed,
      SUM(external_completed_quantity) AS total_ext_completed,
      SUM(refunded_quantity) AS total_refunded,
      SUM(refund_amount_total) AS total_refund_amount,
      GROUP_CONCAT(DISTINCT order_status) AS statuses
    FROM orders WHERE batch_id = ?
  `, [batchId]);
  console.log('\n=== ORDERS SUMMARY ===');
  console.log(orderSummary[0]);

  // 3. Orders with completed > 0 or refund_amount_total > 0
  const [interestingOrders] = await db.execute(`
    SELECT id, order_no, ordered_quantity, completed_quantity,
           external_completed_quantity, refunded_quantity,
           refund_amount_total, order_status
    FROM orders
    WHERE batch_id = ?
      AND (completed_quantity > 0 OR external_completed_quantity > 0 OR refund_amount_total > 0)
    ORDER BY refund_amount_total DESC
    LIMIT 20
  `, [batchId]);
  console.log('\n=== ORDERS WITH COMPLETIONS OR PRIOR REFUNDS (top 20) ===');
  console.table(interestingOrders);

  // 4. Account records for this batch
  const [arSummary] = await db.execute(`
    SELECT
      ar.record_type,
      ar.direction,
      COUNT(*) AS count,
      SUM(ar.actual_paid_amount) AS total_actual_paid,
      SUM(ar.refund_amount) AS total_refund,
      SUM(ar.net_amount) AS total_net,
      MIN(ar.discounted_unit_price) AS min_unit_price,
      MAX(ar.discounted_unit_price) AS max_unit_price
    FROM account_records ar
    JOIN orders o ON o.id = ar.order_id
    WHERE o.batch_id = ?
    GROUP BY ar.record_type, ar.direction
  `, [batchId]);
  console.log('\n=== ACCOUNT RECORDS SUMMARY ===');
  console.table(arSummary);

  // 5. Check charge record distribution per order
  const [chargeDistrib] = await db.execute(`
    SELECT ar.order_id, COUNT(*) AS charge_count,
           SUM(ar.actual_paid_amount) AS total_paid,
           GROUP_CONCAT(ar.actual_paid_amount ORDER BY ar.id) AS amounts
    FROM account_records ar
    JOIN orders o ON o.id = ar.order_id
    WHERE o.batch_id = ? AND ar.record_type = 'order_charge'
    GROUP BY ar.order_id
    HAVING COUNT(*) > 1
    ORDER BY total_paid DESC
    LIMIT 10
  `, [batchId]);
  console.log('\n=== ORDERS WITH MULTIPLE CHARGES (top 10) ===');
  console.table(chargeDistrib);

  // 6. Check refund record distribution
  const [refundDistrib] = await db.execute(`
    SELECT ar.order_id, COUNT(*) AS refund_count,
           SUM(ar.refund_amount) AS total_refunded_ar,
           o.refund_amount_total AS order_refund_total,
           o.ordered_quantity, o.completed_quantity
    FROM account_records ar
    JOIN orders o ON o.id = ar.order_id
    WHERE o.batch_id = ? AND ar.record_type = 'refund'
    GROUP BY ar.order_id
    HAVING COUNT(*) > 1
    ORDER BY total_refunded_ar DESC
    LIMIT 10
  `, [batchId]);
  console.log('\n=== ORDERS WITH MULTIPLE REFUNDS (top 10) ===');
  console.table(refundDistrib);

  // 7. Full breakdown for one specific order (id=141, the biggest)
  const [order141Records] = await db.execute(`
    SELECT ar.id, ar.record_type, ar.direction, ar.actual_paid_amount,
           ar.refund_amount, ar.net_amount, ar.discounted_unit_price,
           ar.ordered_quantity, ar.refunded_quantity, ar.created_at
    FROM account_records ar
    WHERE ar.order_id = 141
    ORDER BY ar.id ASC
  `);
  console.log('\n=== ALL RECORDS FOR ORDER 141 (ordered=41000, refund_total=123) ===');
  console.table(order141Records);

  // 8. Calculate the missing refund amount per order
  const [missingRefunds] = await db.execute(`
    SELECT
      o.id, o.order_no, o.ordered_quantity, o.completed_quantity,
      o.refund_amount_total AS order_refund_total,
      COALESCE(charges.total_charged, 0) AS total_charged,
      COALESCE(refunds.total_refunded, 0) AS total_refunded_ar,
      ROUND(
        COALESCE(charges.total_charged, 0)
        * (o.ordered_quantity - GREATEST(o.completed_quantity, o.external_completed_quantity, 0))
        / GREATEST(o.ordered_quantity, 1)
        - COALESCE(refunds.total_refunded, 0),
        4
      ) AS still_owed
    FROM orders o
    LEFT JOIN (
      SELECT order_id, SUM(actual_paid_amount) AS total_charged
      FROM account_records WHERE record_type = 'order_charge' AND status = 'success'
      GROUP BY order_id
    ) charges ON charges.order_id = o.id
    LEFT JOIN (
      SELECT order_id, SUM(refund_amount) AS total_refunded
      FROM account_records WHERE record_type = 'refund' AND status = 'success'
      GROUP BY order_id
    ) refunds ON refunds.order_id = o.id
    WHERE o.batch_id = ?
    HAVING still_owed > 0.001
    ORDER BY still_owed DESC
  `, [batchId]);
  console.log('\n=== ORDERS STILL OWED REFUND (should-refund - already-refunded > 0) ===');
  console.log('Count:', missingRefunds.length);
  if (missingRefunds.length > 0) {
    console.table(missingRefunds.slice(0, 15));
    const totalOwed = missingRefunds.reduce((s, r) => s + Number(r.still_owed), 0);
    console.log('Total still owed:', totalOwed.toFixed(4));
  }

  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
