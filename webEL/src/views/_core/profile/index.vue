<script setup lang="ts">
import type { UserApi } from '#/api';

import { computed, onMounted, ref } from 'vue';

import { createIconifyIcon } from '@vben/icons';
import { preferences } from '@vben/preferences';
import { useUserStore } from '@vben/stores';

import { ElButton, ElEmpty, ElSkeleton } from 'element-plus';

import { getUserProfileApi } from '#/api';

interface RecentOperation {
  amount?: number;
  description: string;
  id: string;
  status?: string;
  time: null | string;
  title: string;
  type: 'order' | 'record';
}

const AwardIcon = createIconifyIcon('lucide:badge-check');
const EyeIcon = createIconifyIcon('lucide:eye');
const MoreIcon = createIconifyIcon('lucide:ellipsis');
const RefreshIcon = createIconifyIcon('lucide:refresh-cw');
const WalletIcon = createIconifyIcon('lucide:wallet-cards');

const userStore = useUserStore();
const profile = ref<UserApi.Profile>();
const loading = ref(false);

const account = computed(() => profile.value?.account);
const discounts = computed(() => profile.value?.discounts);
const orderStats = computed(() => profile.value?.order_stats);
const recentOrders = computed(() => profile.value?.recent_orders ?? []);
const recentRecords = computed(() => profile.value?.recent_records ?? []);
const balance = computed(() => profile.value?.balance.available_amount ?? 0);
const avatar = computed(
  () => userStore.userInfo?.avatar || preferences.app.defaultAvatar,
);

const accountStatItems = computed(() => [
  {
    label: '订单',
    value: compactNumber(orderStats.value?.order_total ?? 0),
  },
  {
    label: '完成',
    value: compactNumber(orderStats.value?.completed_total ?? 0),
  },
  {
    label: '数量',
    value: compactNumber(orderStats.value?.completed_quantity_total ?? 0),
  },
  {
    label: '认证',
    value: account.value?.account_status ?? '正常',
  },
]);

const overviewCards = computed(() => [
  {
    delta: `+ ${compactNumber(orderStats.value?.completed_total ?? 0)}`,
    label: '订单总数',
    value: compactNumber(orderStats.value?.order_total ?? 0),
  },
  {
    delta: `+ ${compactNumber(orderStats.value?.running_total ?? 0)}`,
    label: '进行中订单',
    value: compactNumber(orderStats.value?.running_total ?? 0),
  },
  {
    delta: `+ ${compactNumber(orderStats.value?.completed_quantity_total ?? 0)}`,
    label: '完成数量',
    value: compactNumber(orderStats.value?.completed_quantity_total ?? 0),
  },
  {
    delta: `+ ${compactNumber(orderStats.value?.ordered_quantity_total ?? 0)}`,
    label: '下单数量',
    value: compactNumber(orderStats.value?.ordered_quantity_total ?? 0),
  },
  {
    delta: `- ${compactNumber(orderStats.value?.failed_total ?? 0)}`,
    label: '异常订单',
    tone: 'danger',
    value: compactNumber(orderStats.value?.failed_total ?? 0),
  },
  {
    delta: compactNumber(orderStats.value?.manual_review_total ?? 0),
    label: '审核订单',
    value: compactNumber(orderStats.value?.manual_review_total ?? 0),
  },
]);

const walletItems = computed(() => {
  const expenseTotal = recentRecords.value.reduce(
    (sum, record) => sum + Math.abs(record.net_amount || 0),
    0,
  );
  const refundTotal = recentRecords.value.reduce(
    (sum, record) => sum + Math.abs(record.refund_amount || 0),
    0,
  );

  return [
    { label: '可用余额', value: formatMoney(balance.value) },
    { label: '近期消费', value: formatMoney(expenseTotal) },
    { label: '退款金额', value: formatMoney(refundTotal) },
  ];
});

const weeklyRows = computed(() => [
  {
    label: '本周订单活跃度',
    value: `${compactNumber(orderStats.value?.order_total ?? 0)} 单`,
  },
  {
    label: '阅读折扣权益',
    value: formatDiscount(discounts.value?.view_discount_rate ?? 1),
  },
  {
    label: '曝光折扣权益',
    value: formatDiscount(discounts.value?.impression_discount_rate ?? 1),
  },
]);

const recentOperations = computed<RecentOperation[]>(() => {
  const orderOperations = recentOrders.value.map((order) => ({
    description: `${order.target_type === 'impression' ? '曝光' : order.target_type === 'like' ? '点赞' : '阅读'} / ${order.completed_quantity}/${order.ordered_quantity}`,
    id: `order-${order.order_no}`,
    status: getOrderStatusLabel(order.order_status),
    time: order.created_at,
    title: order.order_no,
    type: 'order' as const,
  }));

  const recordOperations = recentRecords.value.map((record) => ({
    amount: Math.abs(record.net_amount || 0),
    description: `关联订单：${record.order_no || '-'}`,
    id: `record-${record.record_no}`,
    status: record.status === 'success' ? '成功' : record.status,
    time: record.created_at,
    title: getRecordTypeLabel(record.record_type),
    type: 'record' as const,
  }));

  return [...orderOperations, ...recordOperations]
    .sort(
      (a, b) =>
        new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime(),
    )
    .slice(0, 6);
});

function compactNumber(value: number) {
  const numberValue = Number(value || 0);
  if (numberValue >= 10_000) {
    return `${(numberValue / 10_000).toFixed(1)}w`;
  }
  return numberValue.toLocaleString('zh-CN');
}

function formatDate(value?: null | string) {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleDateString('zh-CN');
}

function formatDateTime(value?: null | string) {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatDiscount(value: number) {
  return `${(Number(value || 1) * 10).toFixed(1)} 折`;
}

function formatMoney(value: number) {
  return `${Number(value || 0).toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })} 元`;
}

function getOrderStatusLabel(status: string) {
  const labels: Record<string, string> = {
    completed: '已完成',
    failed: '失败',
    manual_review: '审核中',
    refund_calculating: '退款计算',
    refund_requested: '退款中',
    repair_review: '审核中',
    running: '进行中',
    stopping: '停止中',
  };
  return labels[status] || status;
}

function getRecordTypeLabel(type: string) {
  const labels: Record<string, string> = {
    order_charge: '订单扣费',
    recharge: '充值记录',
    refund: '退款记录',
  };
  return labels[type] || type;
}

async function loadProfile() {
  loading.value = true;
  try {
    profile.value = await getUserProfileApi();
  } finally {
    loading.value = false;
  }
}

onMounted(loadProfile);
</script>

<template>
  <div class="creator-profile">
    <ElSkeleton :loading="loading && !profile" animated :rows="12">
      <div class="profile-grid">
        <section class="panel account-panel">
          <div class="account-main">
            <img class="avatar" :src="avatar" alt="" />
            <div class="account-copy">
              <div class="account-name">
                <strong>{{ account?.display_name || '用户' }}</strong>
                <span class="role-badge">
                  <component :is="AwardIcon" />
                  {{ account?.role_label || '普通用户' }}
                </span>
              </div>
              <div class="account-id">
                {{ account?.username || '-' }} / {{ account?.user_no || '-' }}
              </div>
            </div>
          </div>

          <div class="account-stats">
            <div v-for="item in accountStatItems" :key="item.label">
              <strong>{{ item.value }}</strong>
              <span>{{ item.label }}</span>
            </div>
          </div>

          <div class="notice-line">
            <span>公告</span>
            <strong>账号资料、余额与订单数据已同步到个人中心</strong>
            <em>NEW</em>
            <time>{{ formatDate(account?.created_at) }}</time>
          </div>
        </section>

        <section class="banner-panel">
          <div>
            <span>创作者权益</span>
            <strong>订单数据中心</strong>
            <p>余额、折扣、订单与消费记录统一查看</p>
          </div>
        </section>

        <section class="panel overview-panel">
          <div class="section-head">
            <div>
              <h2>数据总览</h2>
            </div>
            <div class="tabs">
              <!-- <button class="active">订单数据</button>
              <button>账务数据</button> -->
              <button>
                <component :is="MoreIcon" />
              </button>
            </div>
          </div>

          <div class="overview-grid">
            <div
              v-for="item in overviewCards"
              :key="item.label"
              class="overview-card"
            >
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
              <em :class="{ danger: item.tone === 'danger' }">
                {{ item.delta }}
              </em>
            </div>
          </div>
        </section>

        <section class="panel weekly-panel">
          <div class="section-head compact">
            <h2>创作者周报</h2>
            <component :is="MoreIcon" />
          </div>
          <div class="weekly-list">
            <div v-for="row in weeklyRows" :key="row.label">
              <span>{{ row.label }}</span>
              <strong>{{ row.value }}</strong>
            </div>
          </div>
        </section>

        <section class="panel operation-panel">
          <div class="section-head">
            <div>
              <h2>最近操作</h2>
              <div class="tips">订单与账务动态</div>
            </div>
            <div class="tabs">
              <!-- <button class="active">全部</button>
              <button>订单</button>
              <button>账务</button> -->
              <button>
                <component :is="MoreIcon" />
              </button>
            </div>
          </div>

          <div class="hint-line">
            已合并最近订单和消费记录，共
            <strong>{{ compactNumber(recentOperations.length) }}</strong>
            条操作动态
          </div>

          <div v-if="recentOperations.length > 0" class="operation-list">
            <article
              v-for="(operation, index) in recentOperations"
              :key="operation.id"
              class="operation-row"
            >
              <span class="rank" :class="operation.type">{{ index + 1 }}</span>
              <div>
                <strong>{{ operation.title }}</strong>
                <p>{{ operation.description }}</p>
              </div>
              <div class="operation-meta">
                <span>{{ operation.status }}</span>
                <em v-if="operation.amount !== undefined">
                  {{ formatMoney(operation.amount) }}
                </em>
                <time>{{ formatDateTime(operation.time) }}</time>
              </div>
            </article>
          </div>
          <ElEmpty v-else description="暂无最近操作" />
        </section>

        <section class="panel wallet-panel">
          <div class="section-head compact">
            <h2 class="title-with-icon">
              <component :is="WalletIcon" />
              钱包
            </h2>
            <component :is="EyeIcon" />
          </div>
          <div class="wallet-grid">
            <div v-for="item in walletItems" :key="item.label">
              <strong>{{ item.value }}</strong>
              <span>{{ item.label }}</span>
            </div>
          </div>
        </section>
      </div>

      <ElButton class="floating-refresh" circle @click="loadProfile">
        <component :is="RefreshIcon" />
      </ElButton>
    </ElSkeleton>
  </div>
</template>

<style scoped>
.creator-profile {
  min-height: 100%;
  padding: 16px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-primary);
}

.tips {
  font-size: 13px;
  margin-top: 10px;
  color: var(--el-text-color-secondary);
}

.profile-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(320px, 0.9fr);
  gap: 16px;
}

.panel,
.banner-panel {
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
  box-shadow: 0 8px 22px rgb(15 23 42 / 4%);
}

.account-panel {
  padding: 18px 22px;
}

.account-main,
.account-name,
.account-stats,
.notice-line,
.section-head,
.tabs,
.wallet-grid,
.operation-row {
  display: flex;
  align-items: center;
}

.account-main {
  gap: 14px;
}

.avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
}

.account-copy {
  min-width: 0;
}

.account-name {
  gap: 10px;
}

.account-name strong {
  font-size: 20px;
}

.role-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--el-color-warning) 18%, transparent);
  color: var(--el-color-warning);
  font-size: 13px;
}

.role-badge svg,
.tabs svg {
  width: 16px;
  height: 16px;
}

.account-id,
.notice-line,
.section-head span,
.overview-card span,
.wallet-grid span,
.weekly-list span,
.operation-row p,
.operation-meta em,
.operation-meta time,
.banner-panel p {
  color: var(--el-text-color-secondary);
}

.account-id {
  margin-top: 4px;
}

.account-stats {
  justify-content: flex-end;
  gap: 22px;
  margin-top: -36px;
}

.account-stats div {
  text-align: center;
}

.account-stats strong,
.account-stats span {
  display: block;
}

.notice-line {
  gap: 10px;
  margin-top: 24px;
  padding-top: 14px;
  border-top: 1px solid var(--el-border-color-lighter);
  font-size: 13px;
}

.notice-line strong {
  color: var(--el-text-color-regular);
  font-weight: 500;
}

.notice-line em {
  padding: 1px 5px;
  border: 1px solid var(--el-color-primary);
  border-radius: 4px;
  color: var(--el-color-primary);
  font-style: normal;
  font-size: 12px;
}

.notice-line time {
  margin-left: auto;
}

.banner-panel {
  min-height: 118px;
  padding: 24px 28px;
  overflow: hidden;
  background:
    radial-gradient(circle at 18% 60%, rgb(255 255 255 / 18%) 0 30px, transparent 31px),
    radial-gradient(circle at 70% 0%, rgb(255 255 255 / 18%) 0 48px, transparent 49px),
    linear-gradient(135deg, #6254f3, #2f77ff);
  color: #fff;
}

.banner-panel span {
  opacity: 0.82;
}

.banner-panel strong {
  display: block;
  margin-top: 8px;
  font-size: 24px;
}

.banner-panel p {
  color: rgb(255 255 255 / 76%);
}

.overview-panel,
.operation-panel,
.weekly-panel,
.wallet-panel {
  padding: 22px;
}

.overview-panel,
.operation-panel {
  grid-column: 1;
}

.section-head {
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}

.section-head.compact {
  margin-bottom: 14px;
}

.section-head h2 {
  margin: 0;
  font-size: 20px;
}

.title-with-icon {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.title-with-icon svg {
  width: 19px;
  height: 19px;
}

.section-head span {
  margin-left: 12px;
  font-size: 14px;
}

.tabs {
  gap: 16px;
}

.tabs button {
  border: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
}

.tabs .active {
  color: var(--el-color-primary);
  font-weight: 650;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.overview-card {
  position: relative;
  min-height: 92px;
  padding: 18px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}

.overview-card strong {
  display: block;
  margin-top: 10px;
  font-size: 24px;
}

.overview-card em {
  position: absolute;
  top: 16px;
  right: 16px;
  color: var(--el-color-danger);
  font-style: normal;
  font-size: 13px;
}

.overview-card em.danger {
  color: var(--el-color-success);
}

.weekly-list {
  display: grid;
  gap: 2px;
}

.weekly-list div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 0;
  border-top: 1px solid var(--el-border-color-lighter);
}

.hint-line {
  margin-bottom: 14px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
}

.hint-line strong {
  color: var(--el-color-primary);
}

.operation-list {
  display: grid;
  gap: 4px;
}

.operation-row {
  gap: 14px;
  padding: 13px 0;
  border-top: 1px solid var(--el-border-color-lighter);
}

.rank {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: var(--el-color-primary);
  color: #fff;
  font-size: 13px;
}

.rank.record {
  background: var(--el-color-success);
}

.operation-row div:nth-child(2) {
  min-width: 0;
  flex: 1;
}

.operation-row p {
  margin: 4px 0 0;
}

.operation-meta {
  min-width: 160px;
  text-align: right;
}

.operation-meta span,
.operation-meta em,
.operation-meta time {
  display: block;
}

.wallet-grid {
  justify-content: space-between;
  gap: 16px;
}

.wallet-grid div {
  flex: 1;
  min-width: 0;
  padding-right: 14px;
  border-right: 1px solid var(--el-border-color);
}

.wallet-grid div:last-child {
  border-right: 0;
}

.wallet-grid strong,
.wallet-grid span {
  display: block;
}

.wallet-grid strong {
  font-size: 18px;
}

.floating-refresh {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 2;
}

.floating-refresh svg {
  width: 16px;
  height: 16px;
}

@media (max-width: 1180px) {
  .profile-grid {
    grid-template-columns: 1fr;
  }

  .overview-panel,
  .operation-panel {
    grid-column: auto;
  }

  .account-stats {
    justify-content: flex-start;
    margin-top: 18px;
  }
}

@media (max-width: 720px) {
  .creator-profile {
    padding: 12px;
  }

  .overview-grid {
    grid-template-columns: 1fr;
  }

  .account-main,
  .account-stats,
  .notice-line,
  .section-head,
  .tabs,
  .wallet-grid,
  .operation-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .notice-line time {
    margin-left: 0;
  }

  .operation-meta {
    text-align: left;
  }

  .wallet-grid div {
    width: 100%;
    padding-right: 0;
    padding-bottom: 12px;
    border-right: 0;
    border-bottom: 1px solid var(--el-border-color);
  }

  .wallet-grid div:last-child {
    border-bottom: 0;
  }
}
</style>
