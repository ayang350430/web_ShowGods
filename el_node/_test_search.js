const mysql = require('mysql2/promise');
(async () => {
  const db = await mysql.createPool({ host:'127.0.0.1', port:3306, user:'goosd_admin', password:'goosd_admin_dev', database:'goosd_admin' });

  const searchUrls = [
    'http://xhslink.com/o/6tMiVizr0jc',
    'http://xhslink.com/o/5UppwAE0RiE',
    'http://xhslink.com/o/4NPLS9pJe7M',
  ];
  const urlSet = new Set(searchUrls);

  // Step 1: find batches and precise batch_item_ids
  const likeConditions = searchUrls.map(() => 'raw_content LIKE ?');
  const likeParams = searchUrls.map(u => `%${u}%`);
  const [batches] = await db.execute(
    `SELECT id, raw_content FROM order_batches WHERE ${likeConditions.join(' OR ')}`,
    likeParams
  );
  console.log(`Found ${batches.length} matching batches`);

  const pairs = [];
  for (const batch of batches) {
    const lines = batch.raw_content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    lines.forEach((line, idx) => {
      const lineUrl = line.split(/\s+/)[0];
      if (urlSet.has(lineUrl)) {
        pairs.push({ batch_id: batch.id, batch_item_id: idx + 1, url: lineUrl });
      }
    });
  }
  console.log(`Precise pairs:`, pairs);

  // Step 2: query specific orders
  const where = [];
  const params = [];
  where.push(`o.note_url IN (${searchUrls.map(() => '?').join(',')})`);
  params.push(...searchUrls);
  for (const p of pairs) {
    where.push('(o.batch_id = ? AND o.batch_item_id = ?)');
    params.push(p.batch_id, p.batch_item_id);
  }

  const [rows] = await db.execute(
    `SELECT o.id, o.batch_id, o.batch_item_id, o.note_url, o.note_id
     FROM orders o WHERE (${where.join(' OR ')}) LIMIT 50`,
    params
  );
  console.log(`Query returned ${rows.length} orders:`);
  rows.forEach(r => console.log(`  id=${r.id} batch_item_id=${r.batch_item_id} note_url=${r.note_url}`));

  await db.end();
})().catch(console.error);
