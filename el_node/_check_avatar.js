const mysql = require('mysql2/promise');
async function main() {
  const db = await mysql.createPool({ host:'127.0.0.1', port:3306, user:'goosd_admin', password:'goosd_admin_dev', database:'goosd_admin' });
  const [rows] = await db.execute("SELECT note_id, avatar_url, author_name FROM note_basic_cache LIMIT 5");
  for (const r of rows) { console.log(`note=${r.note_id} | avatar=[${r.avatar_url || ''}] | author=[${r.author_name || ''}]`); }
  await db.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
