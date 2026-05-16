const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

let pool;

// 获取数据库连接池
const getPool = () => {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT) || 3306,
      database: process.env.DB_NAME || 'goosd_admin',
      user: process.env.DB_USER || 'goosd_admin',
      password: process.env.DB_PASSWORD || 'goosd_admin_dev',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }

  return pool;
};

// 确保数据库表存在指定列
const ensureColumn = async (db, tableName, columnName, definition) => {
  const [columns] = await db.execute(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
    `,
    [tableName, columnName],
  );

  if (columns.length === 0) {
    await db.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
};

const quoteIdentifier = (value) => `\`${String(value).replaceAll('`', '``')}\``;

// 转义SQL字符串中的特殊字符
const escapeSqlString = (value) =>
  `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;

const parseBooleanEnv = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
};

// 是否初始化演示数据
const shouldSeedDemoData = () => {
  const explicitSeedFlag = parseBooleanEnv(process.env.SEED_DEMO_DATA);
  if (explicitSeedFlag !== undefined) {
    return explicitSeedFlag;
  }

  return false;
};

// 数据库表注释
const schemaComments = {
  account_records: {
    columns: {
      actual_paid_amount: ['DECIMAL(18,4) DEFAULT NULL', '实际支付金额'],
      after_available_amount: [
        'DECIMAL(18,4) NOT NULL DEFAULT 0.0000',
        '变更后可用余额',
      ],
      before_available_amount: [
        'DECIMAL(18,4) NOT NULL DEFAULT 0.0000',
        '变更前可用余额',
      ],
      calc_snapshot: ['JSON DEFAULT NULL', '计费或退款计算快照'],
      completed_quantity: ['INT UNSIGNED DEFAULT NULL', '完成数量快照'],
      created_at: ['DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', '创建时间'],
      direction: ['VARCHAR(16) NOT NULL', '资金方向'],
      discount_amount: ['DECIMAL(18,4) DEFAULT NULL', '优惠金额'],
      discount_rate: ['DECIMAL(10,4) DEFAULT NULL', '折扣率'],
      discounted_unit_price: ['DECIMAL(18,4) DEFAULT NULL', '折后单价'],
      id: ['BIGINT UNSIGNED NOT NULL AUTO_INCREMENT', '主键ID'],
      net_amount: ['DECIMAL(18,4) NOT NULL DEFAULT 0.0000', '本次净变动金额'],
      order_id: ['BIGINT UNSIGNED DEFAULT NULL', '关联订单ID'],
      order_no: ['VARCHAR(40) DEFAULT NULL', '关联订单编号'],
      ordered_quantity: ['INT UNSIGNED DEFAULT NULL', '下单数量快照'],
      original_total_amount: ['DECIMAL(18,4) DEFAULT NULL', '原价总金额'],
      original_unit_price: ['DECIMAL(18,4) DEFAULT NULL', '原始单价'],
      payable_amount: ['DECIMAL(18,4) DEFAULT NULL', '应付金额'],
      reason_code: ['VARCHAR(64) DEFAULT NULL', '原因编码'],
      reason_message: ['VARCHAR(255) DEFAULT NULL', '原因说明'],
      record_no: ['VARCHAR(40) NOT NULL', '流水编号'],
      record_type: ['VARCHAR(32) NOT NULL', '流水类型'],
      refund_amount: ['DECIMAL(18,4) DEFAULT NULL', '退款金额'],
      refunded_quantity: ['INT UNSIGNED DEFAULT NULL', '退款数量快照'],
      related_record_id: ['BIGINT UNSIGNED DEFAULT NULL', '关联原流水ID'],
      remark: ['VARCHAR(255) DEFAULT NULL', '备注'],
      status: ["VARCHAR(32) NOT NULL DEFAULT 'success'", '流水状态'],
      updated_at: [
        'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
        '更新时间',
      ],
      user_id: ['BIGINT UNSIGNED NOT NULL', '用户ID'],
    },
    table: '账户流水记录表',
  },
  balance_accounts: {
    columns: {
      available_amount: ['DECIMAL(18,4) NOT NULL DEFAULT 0.0000', '可用余额'],
      created_at: ['DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', '创建时间'],
      id: ['BIGINT UNSIGNED NOT NULL AUTO_INCREMENT', '主键ID'],
      updated_at: [
        'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
        '更新时间',
      ],
      user_id: ['BIGINT UNSIGNED NOT NULL', '用户ID'],
      version: ['BIGINT UNSIGNED NOT NULL DEFAULT 0', '乐观锁版本号'],
    },
    table: '用户余额账户表',
  },
  order_batches: {
    columns: {
      batch_id: ['CHAR(36) NOT NULL', '批次UUID'],
      batch_no: ['VARCHAR(40) NOT NULL', '批次业务编号'],
      created_at: ['DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', '创建时间'],
      estimated_amount: [
        'DECIMAL(18,4) NOT NULL DEFAULT 0.0000',
        '预计消费金额',
      ],
      failed_count: ['INT UNSIGNED NOT NULL DEFAULT 0', '失败数量'],
      finished_at: ['DATETIME DEFAULT NULL', '完成时间'],
      id: ['BIGINT UNSIGNED NOT NULL AUTO_INCREMENT', '主键ID'],
      pending_count: ['INT UNSIGNED NOT NULL DEFAULT 0', '待处理数量'],
      processing_count: ['INT UNSIGNED NOT NULL DEFAULT 0', '处理中数量'],
      raw_content: ['LONGTEXT DEFAULT NULL', '原始提交内容'],
      retryable_count: ['INT UNSIGNED NOT NULL DEFAULT 0', '可重试数量'],
      source_type: ["VARCHAR(32) NOT NULL DEFAULT 'manual'", '提交来源类型'],
      status: ["VARCHAR(32) NOT NULL DEFAULT 'pending'", '批次状态'],
      submit_mode: ["VARCHAR(32) NOT NULL DEFAULT 'single'", '提交模式'],
      submitted_at: ['DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', '提交时间'],
      succeeded_count: ['INT UNSIGNED NOT NULL DEFAULT 0', '成功数量'],
      total_count: ['INT UNSIGNED NOT NULL DEFAULT 0', '总数量'],
      updated_at: [
        'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
        '更新时间',
      ],
      user_id: ['BIGINT UNSIGNED NOT NULL', '用户ID'],
    },
    table: '订单批次表',
  },
  orders: {
    columns: {
      archived_at: ['DATETIME DEFAULT NULL', '归档时间'],
      batch_id: ['BIGINT UNSIGNED NOT NULL DEFAULT 0', '来源批次ID'],
      batch_item_id: ['BIGINT UNSIGNED NOT NULL DEFAULT 0', '来源批次明细ID'],
      completed_quantity: ['INT UNSIGNED NOT NULL DEFAULT 0', '已完成数量'],
      created_at: ['DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', '创建时间'],
      external_completed_quantity: [
        'INT UNSIGNED NOT NULL DEFAULT 0',
        '外部返回完成数量',
      ],
      external_last_synced_at: ['DATETIME DEFAULT NULL', '外部进度同步时间'],
      external_progress: ['DECIMAL(10,4) DEFAULT NULL', '外部任务进度'],
      external_status: ['VARCHAR(64) DEFAULT NULL', '外部任务状态'],
      external_task_id: ['VARCHAR(128) DEFAULT NULL', '外部任务ID'],
      id: ['BIGINT UNSIGNED NOT NULL AUTO_INCREMENT', '主键ID'],
      last_dispatch_at: ['DATETIME DEFAULT NULL', '最近投递时间'],
      last_verified_at: ['DATETIME DEFAULT NULL', '最近验收时间'],
      note_id: ['VARCHAR(64) DEFAULT NULL', '小红书笔记ID'],
      note_url: ['VARCHAR(1024) DEFAULT NULL', '小红书笔记链接'],
      order_no: ['VARCHAR(40) NOT NULL', '订单编号'],
      order_status: ["VARCHAR(32) NOT NULL DEFAULT 'running'", '订单状态'],
      ordered_quantity: ['INT UNSIGNED NOT NULL DEFAULT 0', '下单数量'],
      reason_code: ['VARCHAR(64) DEFAULT NULL', '原因编码'],
      reason_message: ['VARCHAR(255) DEFAULT NULL', '原因说明'],
      refund_amount_total: [
        'DECIMAL(18,4) NOT NULL DEFAULT 0.0000',
        '累计退款金额',
      ],
      refund_calc_after_at: ['DATETIME DEFAULT NULL', '退款计算时间点'],
      refund_lock_status: [
        "VARCHAR(32) NOT NULL DEFAULT 'unlocked'",
        '退款锁状态',
      ],
      refund_locked_at: ['DATETIME DEFAULT NULL', '退款锁定时间'],
      refund_requested_at: ['DATETIME DEFAULT NULL', '申请退款时间'],
      refunded_quantity: ['INT UNSIGNED NOT NULL DEFAULT 0', '已退款数量'],
      repair_count: ['INT UNSIGNED NOT NULL DEFAULT 0', '补单次数'],
      snapshot_current_read_count: ['INT UNSIGNED DEFAULT NULL', '下单时阅读数快照'],
      snapshot_verified_read_count: ['INT UNSIGNED DEFAULT NULL', '验收时阅读数快照'],
      stop_requested_at: ['DATETIME DEFAULT NULL', '请求停止时间'],
      stop_response_message: ['VARCHAR(255) DEFAULT NULL', '停止任务响应说明'],
      target_type: ["VARCHAR(32) NOT NULL DEFAULT 'view'", '下单目标类型'],
      updated_at: [
        'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
        '更新时间',
      ],
      user_id: ['BIGINT UNSIGNED NOT NULL', '用户ID'],
    },
    table: '订单主表',
  },
  system_configs: {
    columns: {
      config_group: ['VARCHAR(64) NOT NULL', '配置分组'],
      config_key: ['VARCHAR(128) NOT NULL', '配置键'],
      config_value: ['JSON NOT NULL', '配置值'],
      created_at: ['DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', '创建时间'],
      description: ['VARCHAR(255) DEFAULT NULL', '配置说明'],
      id: ['BIGINT UNSIGNED NOT NULL AUTO_INCREMENT', '主键ID'],
      status: ["VARCHAR(32) NOT NULL DEFAULT 'active'", '配置状态'],
      updated_at: [
        'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
        '更新时间',
      ],
      version: ['BIGINT UNSIGNED NOT NULL DEFAULT 1', '配置版本'],
    },
    table: '系统配置表',
  },
  users: {
    columns: {
      discount_rate: [
        'DECIMAL(10,4) NOT NULL DEFAULT 1.0000',
        '阅读业务折扣率',
      ],
      home_path: ["VARCHAR(255) NOT NULL DEFAULT '/analytics'", '登录后首页路径'],
      impression_discount_rate: [
        'DECIMAL(10,4) NOT NULL DEFAULT 1.0000',
        '曝光业务折扣率',
      ],
      nickname: ['VARCHAR(64) DEFAULT NULL', '用户昵称'],
      real_name: ["VARCHAR(100) NOT NULL DEFAULT ''", '真实姓名'],
      status: ["VARCHAR(32) NOT NULL DEFAULT 'active'", '用户状态'],
      user_no: ['VARCHAR(32) DEFAULT NULL', '用户业务编号'],
      username: ['VARCHAR(100) NOT NULL', '登录用户名'],
    },
    table: '系统用户表',
  },
  xhs_query_accounts: {
    columns: {
      account_name: ['VARCHAR(64) NOT NULL', '账号备注名称'],
      account_no: ['VARCHAR(40) NOT NULL', '账号业务编号'],
      consecutive_failures: [
        'INT UNSIGNED NOT NULL DEFAULT 0',
        '连续失败次数',
      ],
      cookie_encrypted: ['LONGTEXT DEFAULT NULL', '加密后的 Cookie'],
      created_at: ['DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', '创建时间'],
      deleted_at: ['DATETIME DEFAULT NULL', '软删除时间'],
      enabled: ['TINYINT(1) NOT NULL DEFAULT 1', '是否启用'],
      failure_count: ['INT UNSIGNED NOT NULL DEFAULT 0', '失败次数'],
      id: ['BIGINT UNSIGNED NOT NULL AUTO_INCREMENT', '主键ID'],
      last_error_code: ['VARCHAR(64) DEFAULT NULL', '最近错误编码'],
      last_error_message: ['VARCHAR(255) DEFAULT NULL', '最近错误说明'],
      last_failure_at: ['DATETIME DEFAULT NULL', '最近失败时间'],
      last_success_at: ['DATETIME DEFAULT NULL', '最近成功时间'],
      last_used_at: ['DATETIME DEFAULT NULL', '最近使用时间'],
      login_identifier: ['VARCHAR(128) DEFAULT NULL', '登录标识'],
      next_available_at: ['DATETIME DEFAULT NULL', '下次可用时间'],
      proxy_url: ['VARCHAR(512) DEFAULT NULL', '代理地址'],
      remark: ['VARCHAR(255) DEFAULT NULL', '备注'],
      risk_level: ["VARCHAR(32) NOT NULL DEFAULT 'normal'", '风险等级'],
      sid_encrypted: ['TEXT NOT NULL', '加密后的 SID'],
      status: ["VARCHAR(32) NOT NULL DEFAULT 'active'", '账号状态'],
      success_count: ['INT UNSIGNED NOT NULL DEFAULT 0', '成功次数'],
      updated_at: [
        'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
        '更新时间',
      ],
      user_agent: ['VARCHAR(512) DEFAULT NULL', '请求 User-Agent'],
    },
    table: '小红书查询账号池表',
  },
};

const applySchemaComments = async (db) => {
  for (const [tableName, tableMeta] of Object.entries(schemaComments)) {
    await db.execute(
      `ALTER TABLE ${quoteIdentifier(tableName)} COMMENT=${escapeSqlString(tableMeta.table)}`,
    );

    for (const [columnName, [definition, comment]] of Object.entries(tableMeta.columns)) {
      await db.execute(
        `ALTER TABLE ${quoteIdentifier(tableName)} MODIFY COLUMN ${quoteIdentifier(columnName)} ${definition} COMMENT ${escapeSqlString(comment)}`,
      );
    }
  }
};

// 初始化角色和权限
const seedRolesAndPermissions = async (db) => {
  const roles = [
    ['super', 'Super Administrator'],
    ['admin', 'Administrator'],
    ['user', 'User'],
  ];

  for (const [code, name] of roles) {
    await db.execute(
      'INSERT INTO roles (code, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [code, name],
    );
  }

  const permissions = [
    ['AC_100100', 'Common action'],
    ['AC_100110', 'Create action'],
    ['AC_100120', 'Update action'],
    ['AC_100010', 'Read action'],
    ['AC_DASHBOARD_ANALYTICS', 'Dashboard analytics page'],
    ['AC_DASHBOARD_WORKSPACE', 'Dashboard workspace page'],
    ['AC_DEMOS_VIEW', 'Demos pages'],
    ['AC_SYSTEM_ADMIN', 'System admin pages'],
  ];

  for (const [code, name] of permissions) {
    await db.execute(
      'INSERT INTO permissions (code, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [code, name],
    );
  }

  const rolePermissions = {
    admin: ['AC_100010', 'AC_DASHBOARD_WORKSPACE', 'AC_SYSTEM_ADMIN'],
    super: permissions.map(([code]) => code),
    user: ['AC_DASHBOARD_WORKSPACE'],
  };

  for (const [roleCode, permissionCodes] of Object.entries(rolePermissions)) {
    const [[role]] = await db.execute('SELECT id FROM roles WHERE code = ?', [roleCode]);

    for (const permissionCode of permissionCodes) {
      const [[permission]] = await db.execute('SELECT id FROM permissions WHERE code = ?', [
        permissionCode,
      ]);

      await db.execute(
        'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [role.id, permission.id],
      );
    }
  }
};

// 创建商品表
const createGoodsTables = async (db) => {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS balance_accounts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      available_amount DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
      version BIGINT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_balance_accounts_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // XHS 查询账号表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS xhs_query_accounts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      account_no VARCHAR(40) NOT NULL,
      account_name VARCHAR(64) NOT NULL,
      login_identifier VARCHAR(128) DEFAULT NULL,
      sid_encrypted TEXT NOT NULL,
      cookie_encrypted LONGTEXT DEFAULT NULL,
      user_agent VARCHAR(512) DEFAULT NULL,
      proxy_url VARCHAR(512) DEFAULT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      last_used_at DATETIME DEFAULT NULL,
      next_available_at DATETIME DEFAULT NULL,
      last_success_at DATETIME DEFAULT NULL,
      last_failure_at DATETIME DEFAULT NULL,
      consecutive_failures INT UNSIGNED NOT NULL DEFAULT 0,
      success_count INT UNSIGNED NOT NULL DEFAULT 0,
      failure_count INT UNSIGNED NOT NULL DEFAULT 0,
      risk_level VARCHAR(32) NOT NULL DEFAULT 'normal',
      last_error_code VARCHAR(64) DEFAULT NULL,
      last_error_message VARCHAR(255) DEFAULT NULL,
      remark VARCHAR(255) DEFAULT NULL,
      deleted_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_xhs_query_accounts_account_no (account_no),
      KEY idx_xhs_query_accounts_status_enabled (status, enabled),
      KEY idx_xhs_query_accounts_next_available_at (next_available_at),
      KEY idx_xhs_query_accounts_last_used_at (last_used_at),
      KEY idx_xhs_query_accounts_deleted_at (deleted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 系统配置表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS system_configs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      config_group VARCHAR(64) NOT NULL,
      config_key VARCHAR(128) NOT NULL,
      config_value JSON NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      description VARCHAR(255) DEFAULT NULL,
      version BIGINT UNSIGNED NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_system_configs_group_key (config_group, config_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 账户记录表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS account_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      record_no VARCHAR(40) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      record_type VARCHAR(32) NOT NULL,
      direction VARCHAR(16) NOT NULL,
      order_id BIGINT UNSIGNED DEFAULT NULL,
      order_no VARCHAR(40) DEFAULT NULL,
      related_record_id BIGINT UNSIGNED DEFAULT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'success',
      ordered_quantity INT UNSIGNED DEFAULT NULL,
      completed_quantity INT UNSIGNED DEFAULT NULL,
      refunded_quantity INT UNSIGNED DEFAULT NULL,
      original_unit_price DECIMAL(18,4) DEFAULT NULL,
      original_total_amount DECIMAL(18,4) DEFAULT NULL,
      discount_rate DECIMAL(10,4) DEFAULT NULL,
      discounted_unit_price DECIMAL(18,4) DEFAULT NULL,
      discount_amount DECIMAL(18,4) DEFAULT NULL,
      payable_amount DECIMAL(18,4) DEFAULT NULL,
      actual_paid_amount DECIMAL(18,4) DEFAULT NULL,
      refund_amount DECIMAL(18,4) DEFAULT NULL,
      net_amount DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
      before_available_amount DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
      after_available_amount DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
      reason_code VARCHAR(64) DEFAULT NULL,
      reason_message VARCHAR(255) DEFAULT NULL,
      remark VARCHAR(255) DEFAULT NULL,
      calc_snapshot JSON DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_account_records_record_no (record_no),
      KEY idx_account_records_user_created_at (user_id, created_at),
      KEY idx_account_records_order_id (order_id),
      KEY idx_account_records_record_type_status (record_type, status),
      KEY idx_account_records_related_record_id (related_record_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 订单批次表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS order_batches (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      batch_id CHAR(36) NOT NULL,
      batch_no VARCHAR(40) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      source_type VARCHAR(32) NOT NULL DEFAULT 'manual',
      submit_mode VARCHAR(32) NOT NULL DEFAULT 'single',
      raw_content LONGTEXT DEFAULT NULL,
      estimated_amount DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      total_count INT UNSIGNED NOT NULL DEFAULT 0,
      pending_count INT UNSIGNED NOT NULL DEFAULT 0,
      processing_count INT UNSIGNED NOT NULL DEFAULT 0,
      succeeded_count INT UNSIGNED NOT NULL DEFAULT 0,
      failed_count INT UNSIGNED NOT NULL DEFAULT 0,
      retryable_count INT UNSIGNED NOT NULL DEFAULT 0,
      submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_order_batches_batch_id (batch_id),
      UNIQUE KEY uk_order_batches_batch_no (batch_no),
      KEY idx_order_batches_user_created_at (user_id, created_at),
      KEY idx_order_batches_status_submitted_at (status, submitted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 订单表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_no VARCHAR(40) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      batch_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
      batch_item_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
      note_id VARCHAR(64) DEFAULT NULL,
      note_url VARCHAR(1024) DEFAULT NULL,
      target_type VARCHAR(32) NOT NULL DEFAULT 'view',
      ordered_quantity INT UNSIGNED NOT NULL DEFAULT 0,
      completed_quantity INT UNSIGNED NOT NULL DEFAULT 0,
      refunded_quantity INT UNSIGNED NOT NULL DEFAULT 0,
      refund_amount_total DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
      repair_count INT UNSIGNED NOT NULL DEFAULT 0,
      order_status VARCHAR(32) NOT NULL DEFAULT 'running',
      external_task_id VARCHAR(128) DEFAULT NULL,
      external_status VARCHAR(64) DEFAULT NULL,
      external_progress DECIMAL(10,4) DEFAULT NULL,
      external_completed_quantity INT UNSIGNED NOT NULL DEFAULT 0,
      external_last_synced_at DATETIME DEFAULT NULL,
      reason_code VARCHAR(64) DEFAULT NULL,
      reason_message VARCHAR(255) DEFAULT NULL,
      snapshot_current_read_count INT UNSIGNED DEFAULT NULL,
      snapshot_verified_read_count INT UNSIGNED DEFAULT NULL,
      last_dispatch_at DATETIME DEFAULT NULL,
      last_verified_at DATETIME DEFAULT NULL,
      refund_lock_status VARCHAR(32) NOT NULL DEFAULT 'unlocked',
      refund_locked_at DATETIME DEFAULT NULL,
      refund_requested_at DATETIME DEFAULT NULL,
      stop_requested_at DATETIME DEFAULT NULL,
      stop_response_message VARCHAR(255) DEFAULT NULL,
      refund_calc_after_at DATETIME DEFAULT NULL,
      archived_at DATETIME DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_orders_order_no (order_no),
      KEY idx_orders_user_created_at (user_id, created_at),
      KEY idx_orders_status_updated_at (order_status, updated_at),
      KEY idx_orders_batch_id (batch_id),
      KEY idx_orders_batch_item_id (batch_item_id),
      KEY idx_orders_note_id (note_id),
      KEY idx_orders_external_task_id (external_task_id),
      KEY idx_orders_refund_lock_status (refund_lock_status),
      KEY idx_orders_refund_calc_after_at (refund_calc_after_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS batch_problem_link_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      line_no INT UNSIGNED NOT NULL DEFAULT 0,
      raw_content VARCHAR(2048) NOT NULL,
      note_url VARCHAR(1024) DEFAULT NULL,
      note_id VARCHAR(64) DEFAULT NULL,
      target_type VARCHAR(32) NOT NULL DEFAULT 'view',
      errors JSON DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_batch_problem_link_user_created_at (user_id, created_at),
      KEY idx_batch_problem_link_note_id (note_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS batch_link_check_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      check_batch_no VARCHAR(48) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      line_no INT UNSIGNED NOT NULL DEFAULT 0,
      raw_content VARCHAR(2048) NOT NULL,
      note_url VARCHAR(1024) DEFAULT NULL,
      resolved_note_url VARCHAR(1024) DEFAULT NULL,
      note_id VARCHAR(64) DEFAULT NULL,
      target_type VARCHAR(32) NOT NULL DEFAULT 'view',
      ordered_quantity INT UNSIGNED NOT NULL DEFAULT 0,
      payable_amount DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
      valid TINYINT(1) NOT NULL DEFAULT 0,
      title VARCHAR(255) DEFAULT NULL,
      author_name VARCHAR(128) DEFAULT NULL,
      avatar_url VARCHAR(1024) DEFAULT NULL,
      errors JSON DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_batch_link_check_batch_no (check_batch_no),
      KEY idx_batch_link_check_user_created_at (user_id, created_at),
      KEY idx_batch_link_check_valid (valid),
      KEY idx_batch_link_check_note_id (note_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
};

// 初始化商品配置
const seedGoodsConfigs = async (db) => {
  const configs = [
    ['pricing', 'view_unit_price', JSON.stringify({ value: 0.01 }), 'View unit price'],
    ['pricing', 'impression_unit_price', JSON.stringify({ value: 0.01 }), 'Impression unit price'],
    ['system', 'view_submit_enabled', JSON.stringify({ enabled: true }), 'Enable view orders'],
    [
      'system',
      'impression_submit_enabled',
      JSON.stringify({ enabled: true }),
      'Enable impression orders',
    ],
  ];

  for (const [group, key, value, description] of configs) {
    await db.execute(
      `
        INSERT INTO system_configs
          (config_group, config_key, config_value, status, description, version)
        VALUES (?, ?, ?, 'active', ?, 1)
        ON DUPLICATE KEY UPDATE
          description = description
      `,
      [group, key, value, description],
    );
  }
};

// 初始化数据库
const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000);

const seedDemoUsers = async (db) => {
  const passwordHash = await bcrypt.hash('demo123', 10);
  const users = [
    ['demo_rednote_ops', '小红书爆文运营', 0.95, 0.9],
    ['demo_brand_growth', '品牌增长组', 0.9, 0.88],
    ['demo_kol_launch', '达人投放组', 0.98, 0.96],
    ['demo_content_boost', '内容加热组', 0.92, 0.89],
  ];
  const balances = {
    demo_brand_growth: 5280.25,
    demo_content_boost: 6715.75,
    demo_kol_launch: 3190,
    demo_rednote_ops: 8360.5,
  };
  const [[userRole]] = await db.execute('SELECT id FROM roles WHERE code = ?', ['user']);
  const userMap = {};

  for (const [username, displayName, discountRate, impressionDiscountRate] of users) {
    await db.execute(
      `
        INSERT INTO users
          (username, password_hash, real_name, home_path, nickname, status, discount_rate, impression_discount_rate)
        VALUES (?, ?, ?, '/analytics', ?, 'active', ?, ?)
        ON DUPLICATE KEY UPDATE
          real_name = VALUES(real_name),
          home_path = VALUES(home_path),
          nickname = VALUES(nickname),
          status = VALUES(status),
          discount_rate = VALUES(discount_rate),
          impression_discount_rate = VALUES(impression_discount_rate)
      `,
      [username, passwordHash, displayName, displayName, discountRate, impressionDiscountRate],
    );

    const [[row]] = await db.execute('SELECT id FROM users WHERE username = ?', [username]);
    userMap[username] = row.id;

    await db.execute(
      "UPDATE users SET user_no = CONCAT('U', LPAD(id, 6, '0')) WHERE id = ?",
      [row.id],
    );
    if (userRole) {
      await db.execute('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [
        row.id,
        userRole.id,
      ]);
    }
    await db.execute(
      `
        INSERT INTO balance_accounts (user_id, available_amount)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE available_amount = VALUES(available_amount)
      `,
      [row.id, balances[username]],
    );
  }

  return userMap;
};

const seedDemoXhsAccounts = async (db) => {
  const accounts = [
    ['DEMO-XHS-001', '主力查询账号 A', 'active', 1, 0, 230, 3, 'normal'],
    ['DEMO-XHS-002', '主力查询账号 B', 'active', 1, 0, 190, 6, 'normal'],
    ['DEMO-XHS-003', '冷却账号 C', 'cooling', 1, 2, 88, 9, 'warning'],
    ['DEMO-XHS-004', '失效账号 D', 'invalid', 1, 5, 61, 12, 'high'],
    ['DEMO-XHS-005', '禁用账号 E', 'disabled', 0, 1, 42, 4, 'normal'],
    ['DEMO-XHS-006', '冷却账号 F', 'cooling', 1, 3, 105, 10, 'warning'],
  ];

  for (const [
    accountNo,
    accountName,
    status,
    enabled,
    failures,
    successCount,
    failureCount,
    riskLevel,
  ] of accounts) {
    await db.execute(
      `
        INSERT INTO xhs_query_accounts
          (
            account_no, account_name, login_identifier, sid_encrypted, cookie_encrypted,
            user_agent, proxy_url, status, enabled, last_used_at, next_available_at,
            last_success_at, last_failure_at, consecutive_failures, success_count,
            failure_count, risk_level, last_error_code, last_error_message, remark
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          account_name = VALUES(account_name),
          login_identifier = VALUES(login_identifier),
          sid_encrypted = VALUES(sid_encrypted),
          cookie_encrypted = VALUES(cookie_encrypted),
          user_agent = VALUES(user_agent),
          proxy_url = VALUES(proxy_url),
          status = VALUES(status),
          enabled = VALUES(enabled),
          last_used_at = VALUES(last_used_at),
          next_available_at = VALUES(next_available_at),
          last_success_at = VALUES(last_success_at),
          last_failure_at = VALUES(last_failure_at),
          consecutive_failures = VALUES(consecutive_failures),
          success_count = VALUES(success_count),
          failure_count = VALUES(failure_count),
          risk_level = VALUES(risk_level),
          last_error_code = VALUES(last_error_code),
          last_error_message = VALUES(last_error_message),
          remark = VALUES(remark)
      `,
      [
        accountNo,
        accountName,
        `${accountNo.toLowerCase()}@demo.local`,
        `encrypted-sid-${accountNo}`,
        `encrypted-cookie-${accountNo}`,
        'Mozilla/5.0 demo goods dashboard',
        null,
        status,
        enabled,
        hoursAgo(1),
        status === 'cooling' ? hoursAgo(-1) : null,
        hoursAgo(3),
        failures > 0 ? hoursAgo(2) : null,
        failures,
        successCount,
        failureCount,
        riskLevel,
        failures > 0 ? 'DEMO_RISK' : null,
        failures > 0 ? '模拟账号最近查询失败，用于首页风险提醒' : null,
        '首页演示账号池数据',
      ],
    );
  }
};

const upsertDemoBatch = async (db, item) => {
  await db.execute(
    `
      INSERT INTO order_batches
        (
          batch_id, batch_no, user_id, source_type, submit_mode, raw_content,
          estimated_amount, status, total_count, pending_count, processing_count,
          succeeded_count, failed_count, retryable_count, submitted_at, finished_at,
          created_at, updated_at
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        batch_no = VALUES(batch_no),
        user_id = VALUES(user_id),
        source_type = VALUES(source_type),
        submit_mode = VALUES(submit_mode),
        raw_content = VALUES(raw_content),
        estimated_amount = VALUES(estimated_amount),
        status = VALUES(status),
        total_count = VALUES(total_count),
        pending_count = VALUES(pending_count),
        processing_count = VALUES(processing_count),
        succeeded_count = VALUES(succeeded_count),
        failed_count = VALUES(failed_count),
        retryable_count = VALUES(retryable_count),
        submitted_at = VALUES(submitted_at),
        finished_at = VALUES(finished_at),
        created_at = VALUES(created_at),
        updated_at = VALUES(updated_at)
    `,
    [
      item.batchId,
      item.batchNo,
      item.userId,
      item.sourceType,
      item.submitMode,
      item.rawContent,
      item.estimatedAmount,
      item.status,
      item.totalCount,
      item.pendingCount,
      item.processingCount,
      item.succeededCount,
      item.failedCount,
      item.retryableCount,
      item.submittedAt,
      item.finishedAt,
      item.createdAt,
      item.updatedAt,
    ],
  );

  const [[row]] = await db.execute('SELECT id FROM order_batches WHERE batch_id = ?', [
    item.batchId,
  ]);
  return row.id;
};

const upsertDemoOrder = async (db, item) => {
  await db.execute(
    `
      INSERT INTO orders
        (
          order_no, user_id, batch_id, batch_item_id, note_id, note_url, target_type,
          ordered_quantity, completed_quantity, refunded_quantity, refund_amount_total,
          repair_count, order_status, external_task_id, external_status,
          external_progress, external_completed_quantity, reason_code, reason_message,
          snapshot_current_read_count, snapshot_verified_read_count, last_dispatch_at,
          last_verified_at, refund_lock_status, refund_requested_at, stop_requested_at,
          refund_calc_after_at, archived_at, created_at, updated_at
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id),
        batch_id = VALUES(batch_id),
        batch_item_id = VALUES(batch_item_id),
        note_id = VALUES(note_id),
        note_url = VALUES(note_url),
        target_type = VALUES(target_type),
        ordered_quantity = VALUES(ordered_quantity),
        completed_quantity = VALUES(completed_quantity),
        refunded_quantity = VALUES(refunded_quantity),
        refund_amount_total = VALUES(refund_amount_total),
        repair_count = VALUES(repair_count),
        order_status = VALUES(order_status),
        external_task_id = VALUES(external_task_id),
        external_status = VALUES(external_status),
        external_progress = VALUES(external_progress),
        external_completed_quantity = VALUES(external_completed_quantity),
        reason_code = VALUES(reason_code),
        reason_message = VALUES(reason_message),
        snapshot_current_read_count = VALUES(snapshot_current_read_count),
        snapshot_verified_read_count = VALUES(snapshot_verified_read_count),
        last_dispatch_at = VALUES(last_dispatch_at),
        last_verified_at = VALUES(last_verified_at),
        refund_lock_status = VALUES(refund_lock_status),
        refund_requested_at = VALUES(refund_requested_at),
        stop_requested_at = VALUES(stop_requested_at),
        refund_calc_after_at = VALUES(refund_calc_after_at),
        archived_at = VALUES(archived_at),
        created_at = VALUES(created_at),
        updated_at = VALUES(updated_at)
    `,
    [
      item.orderNo,
      item.userId,
      item.batchDbId,
      item.batchItemId,
      item.noteId,
      item.noteUrl,
      item.targetType,
      item.orderedQuantity,
      item.completedQuantity,
      item.refundedQuantity,
      item.refundAmountTotal,
      item.repairCount,
      item.orderStatus,
      item.externalTaskId,
      item.externalStatus,
      item.externalProgress,
      item.externalCompletedQuantity,
      item.reasonCode,
      item.reasonMessage,
      item.snapshotCurrentReadCount,
      item.snapshotVerifiedReadCount,
      item.lastDispatchAt,
      item.lastVerifiedAt,
      item.refundLockStatus,
      item.refundRequestedAt,
      item.stopRequestedAt,
      item.refundCalcAfterAt,
      item.archivedAt,
      item.createdAt,
      item.updatedAt,
    ],
  );

  const [[row]] = await db.execute('SELECT id FROM orders WHERE order_no = ?', [
    item.orderNo,
  ]);
  return row.id;
};

const upsertDemoAccountRecord = async (db, item) => {
  const originalTotalAmount = item.orderedQuantity * item.originalUnitPrice;
  const discountAmount = Math.max(originalTotalAmount - item.actualPaidAmount, 0);

  await db.execute(
    `
      INSERT INTO account_records
        (
          record_no, user_id, record_type, direction, order_id, order_no,
          related_record_id, status, ordered_quantity, completed_quantity,
          refunded_quantity, original_unit_price, original_total_amount,
          discount_rate, discounted_unit_price, discount_amount, payable_amount,
          actual_paid_amount, refund_amount, net_amount, before_available_amount,
          after_available_amount, reason_code, reason_message, remark,
          calc_snapshot, created_at, updated_at
        )
      VALUES (?, ?, 'order_charge', 'debit', ?, ?, NULL, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)
      ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id),
        order_id = VALUES(order_id),
        order_no = VALUES(order_no),
        ordered_quantity = VALUES(ordered_quantity),
        completed_quantity = VALUES(completed_quantity),
        refunded_quantity = VALUES(refunded_quantity),
        original_unit_price = VALUES(original_unit_price),
        original_total_amount = VALUES(original_total_amount),
        discount_rate = VALUES(discount_rate),
        discounted_unit_price = VALUES(discounted_unit_price),
        discount_amount = VALUES(discount_amount),
        payable_amount = VALUES(payable_amount),
        actual_paid_amount = VALUES(actual_paid_amount),
        net_amount = VALUES(net_amount),
        before_available_amount = VALUES(before_available_amount),
        after_available_amount = VALUES(after_available_amount),
        reason_code = VALUES(reason_code),
        reason_message = VALUES(reason_message),
        remark = VALUES(remark),
        calc_snapshot = VALUES(calc_snapshot),
        created_at = VALUES(created_at),
        updated_at = VALUES(updated_at)
    `,
    [
      item.recordNo,
      item.userId,
      item.orderId,
      item.orderNo,
      item.orderedQuantity,
      item.completedQuantity,
      item.refundedQuantity,
      item.originalUnitPrice,
      originalTotalAmount,
      item.discountRate,
      item.discountedUnitPrice,
      discountAmount,
      item.actualPaidAmount,
      item.actualPaidAmount,
      -item.actualPaidAmount,
      item.beforeAvailableAmount,
      item.beforeAvailableAmount - item.actualPaidAmount,
      item.reasonCode,
      item.reasonMessage,
      item.remark,
      JSON.stringify({
        source: 'demo_seed',
        target_type: item.targetType,
        unit_price: item.discountedUnitPrice,
      }),
      item.createdAt,
      item.updatedAt,
    ],
  );
};

const seedDemoDashboardData = async (db) => {
  const users = await seedDemoUsers(db);
  await seedDemoXhsAccounts(db);

  const batchItems = [
    ['00000000-0000-0000-0000-000000000101', 'DEMO-BATCH-001', users.demo_rednote_ops, 'processing', 210, 2, 0, 1, 1, 0, 0, hoursAgo(3), null, hoursAgo(3), hoursAgo(1)],
    ['00000000-0000-0000-0000-000000000102', 'DEMO-BATCH-002', users.demo_brand_growth, 'completed', 215, 2, 0, 0, 2, 0, 0, hoursAgo(28), hoursAgo(24), hoursAgo(28), hoursAgo(24)],
    ['00000000-0000-0000-0000-000000000103', 'DEMO-BATCH-003', users.demo_kol_launch, 'manual_review', 125, 2, 0, 0, 0, 1, 2, hoursAgo(5), null, hoursAgo(5), hoursAgo(2)],
    ['00000000-0000-0000-0000-000000000104', 'DEMO-BATCH-004', users.demo_content_boost, 'completed', 170, 2, 0, 0, 2, 0, 0, hoursAgo(80), hoursAgo(70), hoursAgo(80), hoursAgo(70)],
  ];

  const batchMap = {};
  for (const [
    batchId,
    batchNo,
    userId,
    status,
    estimatedAmount,
    totalCount,
    pendingCount,
    processingCount,
    succeededCount,
    failedCount,
    retryableCount,
    submittedAt,
    finishedAt,
    createdAt,
    updatedAt,
  ] of batchItems) {
    batchMap[batchId] = await upsertDemoBatch(db, {
      batchId,
      batchNo,
      createdAt,
      estimatedAmount,
      failedCount,
      finishedAt,
      pendingCount,
      processingCount,
      rawContent: `https://www.xiaohongshu.com/explore/${batchNo.toLowerCase()}`,
      retryableCount,
      sourceType: 'manual',
      status,
      submitMode: 'batch',
      submittedAt,
      succeededCount,
      totalCount,
      updatedAt,
      userId,
    });
  }

  const orderItems = [
    ['DEMO-ORDER-001', 'DEMO-RECORD-001', users.demo_rednote_ops, batchMap['00000000-0000-0000-0000-000000000101'], 1001, 'view', 12_000, 12_000, 'completed', 114, 0.95, hoursAgo(2), hoursAgo(1), null],
    ['DEMO-ORDER-002', 'DEMO-RECORD-002', users.demo_rednote_ops, batchMap['00000000-0000-0000-0000-000000000101'], 1002, 'impression', 8_000, 3_200, 'running', 72, 0.9, hoursAgo(1), hoursAgo(1), null],
    ['DEMO-ORDER-003', 'DEMO-RECORD-003', users.demo_brand_growth, batchMap['00000000-0000-0000-0000-000000000102'], 1003, 'view', 6_500, 6_500, 'completed', 58.5, 0.9, hoursAgo(26), hoursAgo(24), null],
    ['DEMO-ORDER-004', 'DEMO-RECORD-004', users.demo_brand_growth, batchMap['00000000-0000-0000-0000-000000000102'], 1004, 'impression', 15_000, 15_000, 'completed', 132, 0.88, hoursAgo(4), hoursAgo(2), null],
    ['DEMO-ORDER-005', null, users.demo_kol_launch, batchMap['00000000-0000-0000-0000-000000000103'], 1005, 'view', 3_500, 0, 'failed', 0, 0.98, hoursAgo(3), hoursAgo(2), '模拟失败：笔记不可访问'],
    ['DEMO-ORDER-006', 'DEMO-RECORD-006', users.demo_kol_launch, batchMap['00000000-0000-0000-0000-000000000103'], 1006, 'impression', 9_000, 0, 'manual_review', 86.4, 0.96, hoursAgo(30), hoursAgo(3), '模拟审核：内容需要人工确认'],
    ['DEMO-ORDER-007', 'DEMO-RECORD-007', users.demo_content_boost, batchMap['00000000-0000-0000-0000-000000000104'], 1007, 'view', 5_000, 2_800, 'refund_requested', 46, 0.92, hoursAgo(6), hoursAgo(2), '模拟退款：用户申请停止'],
    ['DEMO-ORDER-008', 'DEMO-RECORD-008', users.demo_content_boost, batchMap['00000000-0000-0000-0000-000000000104'], 1008, 'impression', 12_000, 12_000, 'completed', 106.8, 0.89, hoursAgo(72), hoursAgo(70), null],
  ];

  for (const [
    orderNo,
    recordNo,
    userId,
    batchDbId,
    batchItemId,
    targetType,
    orderedQuantity,
    completedQuantity,
    orderStatus,
    actualPaidAmount,
    discountRate,
    createdAt,
    updatedAt,
    reasonMessage,
  ] of orderItems) {
    const orderId = await upsertDemoOrder(db, {
      archivedAt: null,
      batchDbId,
      batchItemId,
      completedQuantity,
      createdAt,
      externalCompletedQuantity: completedQuantity,
      externalProgress: orderedQuantity > 0 ? completedQuantity / orderedQuantity : 0,
      externalStatus: orderStatus,
      externalTaskId: orderNo.replace('ORDER', 'TASK'),
      lastDispatchAt: createdAt,
      lastVerifiedAt: orderStatus === 'completed' ? updatedAt : null,
      noteId: orderNo.toLowerCase(),
      noteUrl: `https://www.xiaohongshu.com/explore/${orderNo.toLowerCase()}`,
      orderNo,
      orderStatus,
      orderedQuantity,
      reasonCode: reasonMessage ? 'DEMO_NOTICE' : null,
      reasonMessage,
      refundAmountTotal: 0,
      refundCalcAfterAt: orderStatus === 'refund_requested' ? hoursAgo(-18) : null,
      refundLockStatus: 'unlocked',
      refundRequestedAt: orderStatus === 'refund_requested' ? updatedAt : null,
      refundedQuantity: 0,
      repairCount: 0,
      snapshotCurrentReadCount: 1000 + orderedQuantity,
      snapshotVerifiedReadCount: orderStatus === 'completed' ? 1000 + completedQuantity : null,
      stopRequestedAt: orderStatus === 'refund_requested' ? updatedAt : null,
      targetType,
      updatedAt,
      userId,
    });

    if (recordNo && actualPaidAmount > 0) {
      await upsertDemoAccountRecord(db, {
        actualPaidAmount,
        beforeAvailableAmount: 10_000,
        completedQuantity,
        createdAt,
        discountedUnitPrice: actualPaidAmount / orderedQuantity,
        discountRate,
        orderId,
        orderedQuantity,
        orderNo,
        originalUnitPrice: 0.01,
        reasonCode: reasonMessage ? 'DEMO_NOTICE' : null,
        reasonMessage,
        recordNo,
        refundedQuantity: 0,
        remark: '首页分析页演示消费流水',
        targetType,
        updatedAt,
        userId,
      });
    }
  }
};

const purgeDemoDashboardData = async (db) => {
  await db.execute("DELETE FROM account_records WHERE record_no LIKE 'DEMO-RECORD-%'");
  await db.execute("DELETE FROM orders WHERE order_no LIKE 'DEMO-ORDER-%'");
  await db.execute("DELETE FROM order_batches WHERE batch_no LIKE 'DEMO-BATCH-%'");
  await db.execute("DELETE FROM xhs_query_accounts WHERE account_no LIKE 'DEMO-XHS-%'");
  await db.execute(
    "DELETE ba FROM balance_accounts ba INNER JOIN users u ON u.id = ba.user_id WHERE u.username LIKE 'demo\\_%'",
  );
  await db.execute(
    "DELETE ur FROM user_roles ur INNER JOIN users u ON u.id = ur.user_id WHERE u.username LIKE 'demo\\_%'",
  );
  await db.execute("DELETE FROM users WHERE username LIKE 'demo\\_%'");
};

const initializeDatabase = async () => {
  const db = getPool();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      real_name VARCHAR(100) NOT NULL DEFAULT '',
      home_path VARCHAR(255) NOT NULL DEFAULT '/analytics',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await ensureColumn(db, 'users', 'real_name', "VARCHAR(100) NOT NULL DEFAULT ''");
  await ensureColumn(
    db,
    'users',
    'home_path',
    "VARCHAR(255) NOT NULL DEFAULT '/analytics'",
  );
  await ensureColumn(db, 'users', 'user_no', 'VARCHAR(32) DEFAULT NULL');
  await ensureColumn(db, 'users', 'nickname', 'VARCHAR(64) DEFAULT NULL');
  await ensureColumn(db, 'users', 'status', "VARCHAR(32) NOT NULL DEFAULT 'active'");
  await ensureColumn(
    db,
    'users',
    'discount_rate',
    'DECIMAL(10,4) NOT NULL DEFAULT 1.0000',
  );
  await ensureColumn(
    db,
    'users',
    'impression_discount_rate',
    'DECIMAL(10,4) NOT NULL DEFAULT 1.0000',
  );
  await ensureColumn(
    db,
    'users',
    'price_mode',
    "VARCHAR(32) NOT NULL DEFAULT 'discount'",
  );
  await ensureColumn(
    db,
    'users',
    'impression_price_mode',
    "VARCHAR(32) NOT NULL DEFAULT 'discount'",
  );
  await ensureColumn(
    db,
    'users',
    'fixed_unit_price',
    'DECIMAL(18,4) DEFAULT NULL',
  );
  await ensureColumn(
    db,
    'users',
    'impression_fixed_unit_price',
    'DECIMAL(18,4) DEFAULT NULL',
  );

  await db.execute(
    "UPDATE users SET home_path = '/analytics' WHERE home_path IN ('/dashboard/workspace', '/workspace')",
  );
  await db.execute(
    "UPDATE users SET user_no = CONCAT('U', LPAD(id, 6, '0')) WHERE user_no IS NULL OR user_no = ''",
  );
  await db.execute(
    "UPDATE users SET nickname = real_name WHERE (nickname IS NULL OR nickname = '') AND real_name <> ''",
  );

  await db.execute(`
    CREATE TABLE IF NOT EXISTS roles (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      code VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS permissions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      code VARCHAR(100) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INT UNSIGNED NOT NULL,
      role_id INT UNSIGNED NOT NULL,
      PRIMARY KEY (user_id, role_id),
      CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INT UNSIGNED NOT NULL,
      permission_id INT UNSIGNED NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
      CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  await seedRolesAndPermissions(db);
  await createGoodsTables(db);
  await seedGoodsConfigs(db);
  await applySchemaComments(db);

  const [rows] = await db.execute('SELECT id FROM users WHERE username = ?', ['admin']);
  let adminId = rows[0]?.id;

  if (!adminId) {
    const passwordHash = await bcrypt.hash('admin123', 10);
    const [result] = await db.execute(
      'INSERT INTO users (username, password_hash, real_name, home_path, nickname) VALUES (?, ?, ?, ?, ?)',
      ['admin', passwordHash, 'Admin', '/analytics', 'Admin'],
    );
    adminId = result.insertId;
  } else {
    await db.execute(
      'UPDATE users SET real_name = ?, home_path = ?, nickname = COALESCE(NULLIF(nickname, \'\'), ?) WHERE id = ?',
      ['Admin', '/analytics', 'Admin', adminId],
    );
  }

  await db.execute(
    "UPDATE users SET user_no = CONCAT('U', LPAD(id, 6, '0')) WHERE id = ? AND (user_no IS NULL OR user_no = '')",
    [adminId],
  );

  const [adminRoles] = await db.execute(
    "SELECT id FROM roles WHERE code IN ('super', 'admin')",
  );

  for (const role of adminRoles) {
    await db.execute('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [
      adminId,
      role.id,
    ]);
  }

  await db.execute(
    'INSERT IGNORE INTO balance_accounts (user_id, available_amount) SELECT id, 0 FROM users',
  );
  if (shouldSeedDemoData()) {
    await seedDemoDashboardData(db);
  } else {
    await purgeDemoDashboardData(db);
  }
};

const closePool = async () => {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
};

module.exports = {
  closePool,
  getPool,
  initializeDatabase,
  shouldSeedDemoData,
};
