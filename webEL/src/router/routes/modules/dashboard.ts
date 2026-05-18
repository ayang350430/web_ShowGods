import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

const routes: RouteRecordRaw[] = [
  {
    name: 'Analytics',
    path: '/analytics',
    component: () => import('#/views/dashboard/analytics/index.vue'),
    meta: {
      affixTab: true,
      authority: ['super', 'admin', 'user'],
      icon: 'lucide:area-chart',
      order: -1,
      title: $t('page.dashboard.analytics'),
    },
  },
  {
    name: 'Workspace',
    path: '/workspace',
    component: () => import('#/views/dashboard/workspace/index.vue'),
    meta: {
      authority: ['super', 'admin', 'user'],
      hideInMenu: true,
      icon: 'carbon:workspace',
      title: $t('page.dashboard.workspace'),
    },
  },
  {
    name: 'BatchOrder',
    path: '/orders/batch',
    component: () => import('#/views/orders/batch/index.vue'),
    meta: {
      authority: ['super', 'admin', 'user'],
      icon: 'lucide:shopping-cart',
      order: 0,
      title: '批量下单',
    },
  },
  {
    name: 'OrderRecords',
    path: '/orders/records',
    component: () => import('#/views/orders/records/index.vue'),
    meta: {
      authority: ['super', 'admin', 'user'],
      icon: 'lucide:list-checks',
      order: 1,
      title: '下单记录',
    },
  },
  {
    name: 'ConsumptionRecords',
    path: '/orders/consumption',
    component: () => import('#/views/orders/consumption/index.vue'),
    meta: {
      authority: ['super', 'admin', 'user'],
      icon: 'lucide:receipt-text',
      order: 2,
      title: '消费记录',
    },
  },
  {
    name: 'RefundRecords',
    path: '/orders/refunds',
    component: () => import('#/views/orders/refunds/index.vue'),
    meta: {
      authority: ['super', 'admin', 'user'],
      icon: 'lucide:undo-2',
      order: 3,
      title: '退款记录',
    },
  },
  {
    name: 'ReplenishmentRecords',
    path: '/orders/replenishments',
    component: () => import('#/views/orders/replenishments/index.vue'),
    meta: {
      authority: ['super', 'admin'],
      icon: 'lucide:badge-check',
      order: 4,
      title: '补单列表',
    },
  },
  {
    name: 'OrderSearch',
    path: '/orders/search',
    component: () => import('#/views/orders/search/index.vue'),
    meta: {
      authority: ['super', 'admin', 'user'],
      icon: 'lucide:search',
      order: 1.5,
      title: '批量查找',
    },
  },
  {
    name: 'OpenApiKeys',
    path: '/open-api/keys',
    component: () => import('#/views/open-api/keys/index.vue'),
    meta: {
      authority: ['super', 'admin', 'user'],
      icon: 'lucide:key-round',
      order: 5,
      title: '开放接口',
    },
  },
  {
    name: 'PermissionManage',
    path: '/system/permissions',
    component: () => import('#/views/system/permissions/index.vue'),
    meta: {
      authority: ['super', 'admin'],
      icon: 'lucide:shield-check',
      order: 10,
      title: '权限管理',
    },
  },
];

export default routes;
