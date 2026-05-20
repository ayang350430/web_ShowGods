const mysql = require('mysql2/promise');
async function main() {
  const db = await mysql.createPool({ host:'127.0.0.1', port:3306, user:'goosd_admin', password:'goosd_admin_dev', database:'goosd_admin' });
  const [result] = await db.execute("UPDATE note_basic_cache SET avatar_url = NULL, author_name = NULL, author_id = NULL WHERE (avatar_url IS NULL OR avatar_url = '') AND (author_id IS NULL OR author_id = '')");
  console.log('Cleared rows:', result.affectedRows);
  const [rows] = await db.execute("SELECT COUNT(*) AS cnt FROM note_basic_cache");
  console.log('Total cache rows:', rows[0].cnt);
  await db.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
