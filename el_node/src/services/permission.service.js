const { getPool } = require('../config/database');

const getUserInfo = async (userId) => {
  const db = getPool();
  const [[user]] = await db.execute(
    'SELECT id, username, real_name AS realName, home_path AS homePath FROM users WHERE id = ?',
    [userId],
  );

  if (!user) {
    return null;
  }

  const [roles] = await db.execute(
    `
      SELECT r.code
      FROM roles r
      INNER JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ?
      ORDER BY FIELD(r.code, 'super', 'admin', 'user'), r.code
    `,
    [userId],
  );

  return {
    avatar: '',
    desc: 'Local admin user',
    homePath: user.homePath,
    realName: user.realName,
    roles: roles.map((role) => role.code),
    userId: String(user.id),
    username: user.username,
  };
};

const getPermissionCodes = async (userId) => {
  const db = getPool();
  const [rows] = await db.execute(
    `
      SELECT DISTINCT p.code
      FROM permissions p
      INNER JOIN role_permissions rp ON rp.permission_id = p.id
      INNER JOIN user_roles ur ON ur.role_id = rp.role_id
      WHERE ur.user_id = ?
      ORDER BY p.code
    `,
    [userId],
  );

  return rows.map((row) => row.code);
};

const getMenus = async (userId) => {
  const userInfo = await getUserInfo(userId);
  const roles = new Set(userInfo?.roles || []);

  const menus = [];
  if (roles.has('super') || roles.has('admin') || roles.has('user')) {
    menus.push({
      component: '/dashboard/analytics/index',
      meta: {
        affixTab: true,
        authority: ['super', 'admin', 'user'],
        icon: 'lucide:area-chart',
        order: -1,
        title: 'page.dashboard.analytics',
      },
      name: 'Analytics',
      path: '/analytics',
    });
  }

  if (roles.has('super') || roles.has('admin') || roles.has('user')) {
    menus.push({
      component: '/dashboard/workspace/index',
      meta: {
        authority: ['super', 'admin', 'user'],
        hideInMenu: true,
        icon: 'carbon:workspace',
        title: 'page.dashboard.workspace',
      },
      name: 'Workspace',
      path: '/workspace',
    });
  }

  if (roles.has('super') || roles.has('admin') || roles.has('user')) {
    menus.push({
      component: '/orders/batch/index',
      meta: {
        authority: ['super', 'admin', 'user'],
        icon: 'lucide:shopping-cart',
        order: 0,
        title: '批量下单',
      },
      name: 'BatchOrder',
      path: '/orders/batch',
    });
    menus.push({
      component: '/orders/records/index',
      meta: {
        authority: ['super', 'admin', 'user'],
        icon: 'lucide:list-checks',
        order: 1,
        title: '下单记录',
      },
      name: 'OrderRecords',
      path: '/orders/records',
    });
    menus.push({
      component: '/orders/consumption/index',
      meta: {
        authority: ['super', 'admin', 'user'],
        icon: 'lucide:receipt-text',
        order: 2,
        title: '消费记录',
      },
      name: 'ConsumptionRecords',
      path: '/orders/consumption',
    });
    menus.push({
      component: '/orders/refunds/index',
      meta: {
        authority: ['super', 'admin', 'user'],
        icon: 'lucide:undo-2',
        order: 3,
        title: '退款记录',
      },
      name: 'RefundRecords',
      path: '/orders/refunds',
    });
  }

  if (roles.has('super') || roles.has('admin')) {
    menus.push({
      component: '/orders/replenishments/index',
      meta: {
        authority: ['super', 'admin'],
        icon: 'lucide:badge-check',
        order: 4,
        title: '补单列表',
      },
      name: 'ReplenishmentRecords',
      path: '/orders/replenishments',
    });
  }

  if (roles.has('super') || roles.has('admin')) {
    menus.push({
      component: '/system/permissions/index',
      meta: {
        authority: ['super', 'admin'],
        icon: 'lucide:shield-check',
        order: 10,
        title: '权限管理',
      },
      name: 'PermissionManage',
      path: '/system/permissions',
    });
  }

  if (roles.has('super') || roles.has('admin')) {
    menus.push({
      children: [
        {
          component: '/demos/element/index',
          meta: {
            authority: ['super', 'admin'],
            title: 'demos.elementPlus',
          },
          name: 'NaiveDemos',
          path: '/demos/element',
        },
        {
          component: '/demos/form/basic',
          meta: {
            authority: ['super'],
            title: 'demos.form',
          },
          name: 'BasicForm',
          path: '/demos/form',
        },
      ],
      meta: {
        authority: ['super', 'admin'],
        hideInMenu: true,
        icon: 'ic:baseline-view-in-ar',
        keepAlive: true,
        order: 1000,
        title: 'demos.title',
      },
      name: 'Demos',
      path: '/demos',
    });
  }

  return menus;
};

module.exports = {
  getMenus,
  getPermissionCodes,
  getUserInfo,
};
