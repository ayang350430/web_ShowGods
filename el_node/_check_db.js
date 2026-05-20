const mysql = require("mysql2/promise");
(async () => {
  const db = await mysql.createConnection({
    host: "192.168.31.189",
    port: 3306,
    user: "goosd_admin",
    password: "goosd_admin",
    database: "goods_admin",
  });
  // Check users
  const [users] = await db.execute("SELECT * FROM users ORDER BY id");
  console.log("--- Users ---");
  for (const u of users) {
    console.log("id=" + u.id + " username=" + u.username);
  }
  // Check user_roles
  const [ur] = await db.execute("SELECT * FROM user_roles ORDER BY user_id");
  console.log("\n--- User Roles ---");
  for (const r of ur) {
    console.log("user_id=" + r.user_id + " role_id=" + r.role_id);
  }
  // Check roles
  const [roles] = await db.execute("SELECT * FROM roles ORDER BY id");
  console.log("\n--- Roles ---");
  for (const r of roles) {
    console.log("id=" + r.id + " name=" + r.name);
  }
  // Check balance_accounts
  const [ba] = await db.execute("SELECT * FROM balance_accounts ORDER BY user_id");
  console.log("\n--- Balance Accounts ---");
  for (const b of ba) {
    console.log("user_id=" + b.user_id + " available=" + b.available_amount);
  }
  // Check open_api_keys
  const [keys] = await db.execute("SELECT id, user_id, key_name FROM open_api_keys ORDER BY id");
  console.log("\n--- Open API Keys ---");
  for (const k of keys) {
    console.log("id=" + k.id + " user_id=" + k.user_id + " name=" + k.key_name);
  }
  await db.end();
})();
