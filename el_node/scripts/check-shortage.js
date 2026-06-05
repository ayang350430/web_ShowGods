/**
 * 订单缺量查询脚本（线上）
 *
 * 原理：
 *   你给的是 xhslink 短链，但 orders 表里存的是解析后的 note_id / 真实链接。
 *   所以先用 batch_link_check_records（含原始短链 raw_content + note_id）建立
 *   “短链 -> note_id” 映射，再用 note_id 在 orders 表聚合下单量/完成量。
 *
 * 用法（线上库连接信息通过环境变量传入，不写进 .env）：
 *   PowerShell:
 *     $env:DB_HOST="192.168.31.189"; $env:DB_PORT="3306"; $env:DB_NAME="goods_admin";
 *     $env:DB_USER="goosd_admin"; $env:DB_PASSWORD="goosd_admin";
 *     node scripts/check-shortage.js scripts/urls.txt
 *
 * 输出：
 *   - 控制台：汇总信息
 *   - scripts/result.csv：明细（URL / 期望下单量 / 实际下单量 / 完成量 / 缺少量 / ...）
 *
 * 输入文件格式：每行  URL<TAB>下单量
 */

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

// 规范化链接：去首尾空白、去末尾的点
const normUrl = (s) => String(s || '').trim().replace(/[\s.]+$/, '');
// 取一段文本里的第一个字段（raw_content 形如 "短链\t2000"）
const firstField = (s) => String(s || '').split('\t')[0].trim().split(/\s+/)[0];

async function main() {
  const inputPath = process.argv[2] || path.join(__dirname, 'urls.txt');
  const outPath = path.join(__dirname, 'result-pending.csv');

  // ── 1. 读取输入 ──
  const raw = fs.readFileSync(inputPath, 'utf-8');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^url\b/i.test(l));

  const inputs = [];
  for (const line of lines) {
    const parts = line.split('\t');
    const url = normUrl(parts[0]);
    const qty = Number(String(parts[1] || '').replace(/[^\d.]/g, '')) || 0;
    if (!url) continue;
    inputs.push({ url, qty });
  }

  // 按 URL 汇总期望下单量（同一短链多次出现则累加），保持首次出现顺序
  const expected = new Map(); // url -> { qty, count }
  for (const { url, qty } of inputs) {
    const e = expected.get(url) || { qty: 0, count: 0 };
    e.qty += qty;
    e.count += 1;
    expected.set(url, e);
  }
  console.error(`读取 ${inputs.length} 行，去重后 ${expected.size} 个不同链接`);

  // ── 2. 连接线上库 ──
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || '192.168.31.189',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'goosd_admin',
    password: process.env.DB_PASSWORD || 'goosd_admin',
    database: process.env.DB_NAME || 'goods_admin',
    waitForConnections: true,
    connectionLimit: 4,
    connectTimeout: 15000,
  });

  try {
    // ── 3. 建立 “短链/原始链接 -> note_id” 映射（来自 batch_link_check_records 全量）──
    console.error('正在加载链接解析映射表 batch_link_check_records ...');
    const urlToNote = new Map();
    let lastId = 0;
    const PAGE = 5000;
    let loaded = 0;
    for (;;) {
      const [rows] = await pool.query(
        "SELECT id, raw_content, note_url, note_id FROM batch_link_check_records " +
          "WHERE id > ? AND note_id IS NOT NULL AND note_id <> '' ORDER BY id ASC LIMIT ?",
        [lastId, PAGE],
      );
      if (!rows.length) break;
      for (const r of rows) {
        const k1 = normUrl(firstField(r.raw_content));
        if (k1) urlToNote.set(k1, r.note_id); // 后出现的覆盖，取较新解析
        const k2 = normUrl(r.note_url);
        if (k2 && k2.includes('xhslink.com')) urlToNote.set(k2, r.note_id);
      }
      loaded += rows.length;
      lastId = rows[rows.length - 1].id;
      if (rows.length < PAGE) break;
    }
    console.error(`映射表加载完成：${loaded} 行，建立 ${urlToNote.size} 个链接索引`);

    // 补充：note_basic_cache 里 source_url 为短链的映射
    try {
      const [nbc] = await pool.query(
        "SELECT source_url, note_id FROM note_basic_cache WHERE source_url LIKE '%xhslink.com%' AND note_id IS NOT NULL AND note_id <> ''",
      );
      for (const r of nbc) {
        const k = normUrl(r.source_url);
        if (k && !urlToNote.has(k)) urlToNote.set(k, r.note_id);
      }
    } catch {
      /* 忽略 */
    }

    // ── 4. 解析每个链接的 note_id ──
    const noteIds = new Set();
    const urlNote = new Map(); // url -> note_id
    const unresolved = []; // 没解析到 note_id 的短链
    for (const url of expected.keys()) {
      const nid = urlToNote.get(url);
      if (nid) {
        urlNote.set(url, nid);
        noteIds.add(nid);
      } else {
        unresolved.push(url);
      }
    }
    console.error(`解析到 note_id 的链接：${urlNote.size}，未解析：${unresolved.length}`);

    // ── 5. 按 note_id 在 orders 聚合 ──
    const aggByNote = new Map();
    const ids = [...noteIds];
    const B = 500;
    for (let i = 0; i < ids.length; i += B) {
      const batch = ids.slice(i, i + B);
      const ph = batch.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT note_id,
                SUM(ordered_quantity)   AS o,
                SUM(completed_quantity) AS c,
                COUNT(*)                AS n,
                GROUP_CONCAT(DISTINCT order_status ORDER BY order_status) AS st,
                GROUP_CONCAT(DISTINCT target_type  ORDER BY target_type)  AS tt
         FROM orders WHERE note_id IN (${ph}) GROUP BY note_id`,
        batch,
      );
      for (const r of rows) aggByNote.set(r.note_id, r);
    }

    // ── 6. 兜底：未解析的短链，直接用 note_url 在 orders 精确匹配 ──
    const fallbackAgg = new Map(); // url -> agg
    if (unresolved.length) {
      for (let i = 0; i < unresolved.length; i += B) {
        const batch = unresolved.slice(i, i + B);
        const ph = batch.map(() => '?').join(',');
        const [rows] = await pool.query(
          `SELECT note_url,
                  SUM(ordered_quantity)   AS o,
                  SUM(completed_quantity) AS c,
                  COUNT(*)                AS n,
                  GROUP_CONCAT(DISTINCT order_status ORDER BY order_status) AS st,
                  GROUP_CONCAT(DISTINCT target_type  ORDER BY target_type)  AS tt
           FROM orders WHERE note_url IN (${ph}) GROUP BY note_url`,
          batch,
        );
        for (const r of rows) fallbackAgg.set(normUrl(r.note_url), r);
      }
    }

    // ── 7. 组装结果（保持输入顺序）──
    const results = [];
    let sumExpected = 0;
    let sumOrdered = 0;
    let sumCompleted = 0;
    let sumShortage = 0;
    let cntShortage = 0;
    let cntNotFound = 0;

    for (const [url, e] of expected) {
      const nid = urlNote.get(url) || '';
      const agg = nid ? aggByNote.get(nid) : fallbackAgg.get(url);

      const ordered = agg ? Number(agg.o) || 0 : 0;
      const completed = agg ? Number(agg.c) || 0 : 0;
      const shortage = ordered - completed; // 正数=缺少，负数=超额完成
      const orderCount = agg ? Number(agg.n) || 0 : 0;
      let status;
      if (!agg) {
        status = nid ? '解析到笔记但无下单记录' : '未找到（链接未入库/无效）';
        cntNotFound += 1;
      } else {
        status = agg.st;
      }
      if (agg && shortage > 0) cntShortage += 1;

      sumExpected += e.qty;
      sumOrdered += ordered;
      sumCompleted += completed;
      if (agg) sumShortage += Math.max(shortage, 0);

      results.push({
        url,
        expectedQty: e.qty,
        ordered,
        completed,
        shortage,
        orderCount,
        noteId: nid,
        targetType: agg ? agg.tt || '' : '',
        status,
      });
    }

    // ── 8. 写 CSV（带 BOM 方便 Excel）──
    // 只导出“没跑完”的：完成量 < 实际下单量（缺少量 > 0），按缺少量从大到小排序
    const header = 'URL,期望下单量,实际下单量,完成量,缺少量,订单数,类型,note_id,状态';
    const exportRows = results
      .filter((r) => r.shortage > 0)
      .sort((a, b) => b.shortage - a.shortage);
    const csvLines = exportRows.map((r) =>
      [
        r.url,
        r.expectedQty,
        r.ordered,
        r.completed,
        r.shortage,
        r.orderCount,
        r.targetType,
        r.noteId,
        `"${String(r.status).replace(/"/g, '""')}"`,
      ].join(','),
    );
    fs.writeFileSync(outPath, '﻿' + header + '\n' + csvLines.join('\n') + '\n', 'utf-8');

    // ── 9. 控制台汇总 ──
    console.error('\n========== 汇总 ==========');
    console.error(`不同链接数:        ${expected.size}`);
    console.error(`期望总下单量:      ${sumExpected}`);
    console.error(`实际总下单量(系统): ${sumOrdered}`);
    console.error(`实际总完成量:      ${sumCompleted}`);
    console.error(`总缺少量(仅正缺口): ${sumShortage}`);
    console.error(`有缺口的链接数:    ${cntShortage}`);
    console.error(`未找到的链接数:    ${cntNotFound}`);
    console.error(`\n仅导出“没跑完”的 ${exportRows.length} 条 -> ${outPath}`);

    // 控制台打印前 30 条有缺口的
    const withShort = results
      .filter((r) => r.shortage > 0 && r.orderCount > 0)
      .sort((a, b) => b.shortage - a.shortage);
    if (withShort.length) {
      console.error(`\n缺口最大的前 ${Math.min(30, withShort.length)} 条:`);
      console.error('  缺少量\t下单\t完成\tURL');
      for (const r of withShort.slice(0, 30)) {
        console.error(`  ${r.shortage}\t${r.ordered}\t${r.completed}\t${r.url}`);
      }
    }

    // 未找到的链接清单（最多列 40 个）
    const notFound = results.filter((r) => r.orderCount === 0);
    if (notFound.length) {
      console.error(`\n未找到下单记录的链接（${notFound.length} 个，最多列 40 个）:`);
      for (const r of notFound.slice(0, 40)) {
        console.error(`  ${r.url}  (${r.status})`);
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('错误:', err.message);
  process.exit(1);
});
