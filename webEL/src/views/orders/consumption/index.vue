<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { useUserStore } from '@vben/stores';

import {
  ElButton,
  ElInput,
  ElMessage,
  ElOption,
  ElPagination,
  ElPopconfirm,
  ElSelect,
  ElTable,
  ElTableColumn,
  ElTag,
} from 'element-plus';

import { getConsumptionRecordsApi, requestOrderRefundApi } from '#/api';

const loading = ref(false);
const route = useRoute();
const records = ref<OrderApi.ConsumptionRecord[]>([]);
const userStore = useUserStore();
const summary = ref<OrderApi.ConsumptionRecordSummary>({
  expense_amount: 0,
  income_amount: 0,
  net_amount: 0,
  refund_amount: 0,
});

const filters = reactive({
  direction: '',
  keyword: '',
  record_type: '',
  status: '',
});

const pagination = reactive({
  page: 1,
  page_size: 10,
  total: 0,
});

function applyRouteKeyword() {
  const keyword = route.query.keyword;
  if (typeof keyword === 'string') {
    filters.keyword = keyword;
  }
}

const stats = computed(() => [
  {
    label: '支出金额',
    value: formatMoney(summary.value.expense_amount),
    tone: 'danger',
  },
  {
    label: '退款金额',
    value: formatMoney(summary.value.refund_amount),
    tone: 'success',
  },
  {
    label: '净消费',
    value: formatMoney(Math.abs(summary.value.net_amount)),
    tone: 'primary',
  },
  {
    label: '记录数',
    value: pagination.total.toLocaleString('zh-CN'),
    tone: 'normal',
  },
]);

const canManageRefund = computed(() =>
  (userStore.userInfo?.roles ?? []).some((role) => ['admin', 'super'].includes(role)),
);

function formatMoney(value?: number) {
  return `￥ ${(Number(value) || 0).toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatUnitPrice(value?: number) {
  return `￥ ${(Number(value) || 0).toLocaleString('zh-CN', {
    maximumFractionDigits: 4,
    minimumFractionDigits: 4,
  })}`;
}

function recordDisplayPrice(row: OrderApi.ConsumptionRecord) {
  if (row.record_type === 'refund') {
    return Number(row.refund_amount || 0);
  }
  return Number(row.actual_paid_amount || row.payable_amount || row.discounted_unit_price || 0);
}

function recordOriginalPrice(row: OrderApi.ConsumptionRecord) {
  return Number(row.original_total_amount || row.original_unit_price || 0);
}

function formatDateTime(value?: string) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const pad = (number: number) => String(number).padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(' ');
}

function recordTypeLabel(type: string) {
  const map: Record<string, string> = {
    adjustment: '人工调整',
    balance_adjustment: '余额调整',
    order_charge: '下单扣费',
    recharge: '余额充值',
    refund: '订单退款',
  };
  return map[type] || type || '-';
}

function isBalanceAdjustment(row: OrderApi.ConsumptionRecord) {
  return row.record_type === 'balance_adjustment';
}

function directionLabel(direction: string) {
  const map: Record<string, string> = {
    credit: '收入',
    debit: '支出',
  };
  return map[direction] || direction || '-';
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    failed: '失败',
    pending: '待处理',
    success: '成功',
  };
  return map[status] || status || '-';
}

function statusTagType(status: string) {
  if (status === 'success') {
    return 'success';
  }
  if (status === 'failed') {
    return 'danger';
  }
  return 'warning';
}

function orderStatusLabel(status: string) {
  const map: Record<string, string> = {
    completed: '订单完成',
    failed: '订单失败',
    manual_review: '人工处理',
    refund_approved: '退款通过',
    refund_calculating: '退款中',
    refund_rejected: '退款拒绝',
    refund_requested: '退款中',
    repair_review: '待补单',
    running: '进行中',
    stopping: '停止中',
  };
  return map[status] || status || '-';
}

function orderStatusTagType(status: string) {
  if (status === 'refund_approved') {
    return 'success';
  }
  if (status === 'refund_rejected' || status === 'failed') {
    return 'danger';
  }
  if (['refund_requested', 'refund_calculating', 'stopping'].includes(status)) {
    return 'warning';
  }
  return 'info';
}

function isRepairVerifyWaiting(
  item: OrderApi.ConsumptionRecord['order_items'][number],
) {
  return (
    item.order_status === 'running' &&
    item.external_status === 'completed' &&
    Number(item.repair_count || 0) > 0
  );
}

function canRequestRefund(item: OrderApi.ConsumptionRecord['order_items'][number]) {
  return ![
    'completed',
    'failed',
    'refund_approved',
    'refund_calculating',
    'refund_rejected',
    'refund_requested',
    'stopping',
  ].includes(item.order_status);
}

function disabledRefundLabel(item: OrderApi.ConsumptionRecord['order_items'][number]) {
  if (item.order_status === 'repair_review') {
    return '申请补单';
  }
  if (isRepairVerifyWaiting(item)) {
    return '补单复查中';
  }
  if (item.order_status === 'refund_requested') {
    return '退款中';
  }
  if (item.order_status === 'refund_approved') {
    return '已退款';
  }
  return '不可申请';
}

async function requestRefund(orderId: number) {
  await requestOrderRefundApi(orderId);
  ElMessage.success('已提交退款申请，等待管理员审核');
  await loadRecords();
}

async function loadRecords() {
  loading.value = true;
  try {
    const result = await getConsumptionRecordsApi({
      direction: filters.direction || undefined,
      keyword: filters.keyword.trim() || undefined,
      page: pagination.page,
      page_size: pagination.page_size,
      record_type: filters.record_type || undefined,
      status: filters.status || undefined,
    });
    records.value = result.items;
    pagination.total = result.total;
    summary.value = result.summary;
  } finally {
    loading.value = false;
  }
}

function searchRecords() {
  pagination.page = 1;
  loadRecords();
}

function resetFilters() {
  filters.direction = '';
  filters.keyword = '';
  filters.record_type = '';
  filters.status = '';
  pagination.page = 1;
  loadRecords();
}

function handlePageChange(page: number) {
  pagination.page = page;
  loadRecords();
}

function handlePageSizeChange(pageSize: number) {
  pagination.page = 1;
  pagination.page_size = pageSize;
  loadRecords();
}

onMounted(() => {
  applyRouteKeyword();
  void loadRecords();
});

watch(
  () => route.query.keyword,
  () => {
    applyRouteKeyword();
    pagination.page = 1;
    void loadRecords();
  },
);
</script>

<template>
  <div class="consumption-page">
    <section class="page-head">
      <div>
        <h1>消费记录</h1>
        <p>展示真实账户流水，包含下单扣费、退款、余额变化和关联订单。</p>
      </div>
      <ElButton :loading="loading" type="primary" @click="loadRecords">
        刷新
      </ElButton>
    </section>

    <section class="summary-grid">
      <div
        v-for="item in stats"
        :key="item.label"
        class="summary-card"
        :class="`is-${item.tone}`"
      >
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </div>
    </section>

    <section class="record-panel">
      <div class="filter-bar">
        <ElInput
          v-model="filters.keyword"
          clearable
          placeholder="搜索流水号、订单号、用户、备注"
          @keyup.enter="searchRecords"
        />
        <ElSelect v-model="filters.record_type" placeholder="全部类型">
          <ElOption label="全部类型" value="" />
          <ElOption label="下单扣费" value="order_charge" />
          <ElOption label="订单退款" value="refund" />
          <ElOption label="余额充值" value="recharge" />
          <ElOption label="人工调整" value="adjustment" />
        </ElSelect>
        <ElSelect v-model="filters.direction" placeholder="全部方向">
          <ElOption label="全部方向" value="" />
          <ElOption label="支出" value="debit" />
          <ElOption label="收入" value="credit" />
        </ElSelect>
        <ElSelect v-model="filters.status" placeholder="全部状态">
          <ElOption label="全部状态" value="" />
          <ElOption label="成功" value="success" />
          <ElOption label="待处理" value="pending" />
          <ElOption label="失败" value="failed" />
        </ElSelect>
        <ElButton type="primary" @click="searchRecords">查询</ElButton>
        <ElButton @click="resetFilters">重置</ElButton>
      </div>

      <ElTable
        v-loading="loading"
        :data="records"
        row-key="id"
        class="record-table"
        empty-text="暂无消费记录"
      >
        <ElTableColumn type="expand" width="44">
          <template #default="{ row }">
            <div v-if="row.order_items?.length" class="order-items">
              <div
                v-for="item in row.order_items"
                :key="item.order_id"
                class="order-item-row"
              >
                <div class="order-item-main">
                  <strong>{{ item.order_no }}</strong>
                  <span>数量 {{ item.ordered_quantity.toLocaleString('zh-CN') }}</span>
                </div>
                <div class="order-item-amount">
                  <strong>{{ formatMoney(item.actual_paid_amount) }}</strong>
                  <span v-if="item.refund_amount">
                    已退 {{ formatMoney(item.refund_amount) }}
                  </span>
                </div>
                <ElTag
                  :type="orderStatusTagType(item.order_status)"
                  effect="plain"
                  size="small"
                >
                  {{ orderStatusLabel(item.order_status) }}
                </ElTag>
                <ElPopconfirm
                  v-if="canManageRefund && canRequestRefund(item)"
                  title="确认申请这条订单退款？申请后需要管理员审核。"
                  confirm-button-text="申请退款"
                  cancel-button-text="取消"
                  @confirm="requestRefund(item.order_id)"
                >
                  <template #reference>
                    <ElButton size="small" type="warning">申请退款</ElButton>
                  </template>
                </ElPopconfirm>
                <ElButton v-else-if="canManageRefund" disabled size="small">
                  {{ disabledRefundLabel(item) }}
                </ElButton>
              </div>
            </div>
            <span v-else class="empty-detail">这条记录没有可申请退款的订单明细</span>
          </template>
        </ElTableColumn>
        <ElTableColumn label="流水信息" min-width="230">
          <template #default="{ row }">
            <div class="main-cell">
              <strong>{{ row.record_no }}</strong>
              <span>{{ formatDateTime(row.created_at) }}</span>
              <small>{{ row.display_name }} / {{ row.username }}</small>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="类型" min-width="112">
          <template #default="{ row }">
            <div class="type-cell">
              <span class="type-badge">{{ recordTypeLabel(row.record_type) }}</span>
              <span class="direction-text" :class="`is-${row.direction}`">
                {{ directionLabel(row.direction) }}
              </span>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="关联订单" min-width="190">
          <template #default="{ row }">
            <div class="muted-cell">
              <strong>{{ isBalanceAdjustment(row) ? '余额调整' : row.order_no || '-' }}</strong>
              <span>{{ row.reason_message || row.remark || '-' }}</span>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="数量" min-width="100">
          <template #default="{ row }">
            <div class="number-cell">
              <strong>{{ isBalanceAdjustment(row) ? '-' : row.ordered_quantity.toLocaleString('zh-CN') }}</strong>
              <span v-if="!isBalanceAdjustment(row) && row.refunded_quantity">
                退 {{ row.refunded_quantity }}
              </span>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="价格" min-width="140">
          <template #default="{ row }">
            <div class="muted-cell">
              <template v-if="isBalanceAdjustment(row)">
                <strong>-</strong>
                <span>不涉及单价</span>
              </template>
              <template v-else>
                <strong>{{ formatUnitPrice(recordDisplayPrice(row)) }}</strong>
                <span>原价 {{ formatUnitPrice(recordOriginalPrice(row)) }}</span>
              </template>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="金额" min-width="170">
          <template #default="{ row }">
            <div class="amount-cell">
              <strong>{{ formatMoney(row.actual_paid_amount) }}</strong>
              <span>退款 {{ formatMoney(row.refund_amount) }}</span>
              <span>净额 {{ formatMoney(row.net_amount) }}</span>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="余额变化" min-width="180">
          <template #default="{ row }">
            <div class="muted-cell">
              <strong>{{ formatMoney(row.after_available_amount) }}</strong>
              <span>之前 {{ formatMoney(row.before_available_amount) }}</span>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="状态" width="110" align="center">
          <template #default="{ row }">
            <ElTag :type="statusTagType(row.status)" effect="plain" size="small">
              {{ statusLabel(row.status) }}
            </ElTag>
          </template>
        </ElTableColumn>
      </ElTable>

      <div class="pagination-bar">
        <ElPagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.page_size"
          :page-sizes="[10, 20, 50, 100]"
          :total="pagination.total"
          background
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="handlePageChange"
          @size-change="handlePageSizeChange"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.consumption-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  padding: 20px;
  color: hsl(var(--foreground));
  background: hsl(var(--background));
}

.page-head,
.record-panel {
  border: 1px solid hsl(var(--border));
  border-radius: 8px;
  background: hsl(var(--card));
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
}

.page-head h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
}

.page-head p {
  margin: 6px 0 0;
  color: hsl(var(--muted-foreground));
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.summary-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 96px;
  padding: 18px;
  border: 1px solid hsl(var(--border));
  border-radius: 8px;
  background: hsl(var(--card));
}

.summary-card span {
  color: hsl(var(--muted-foreground));
}

.summary-card strong {
  font-size: 24px;
  line-height: 1.2;
}

.summary-card.is-danger strong {
  color: #f56c6c;
}

.summary-card.is-success strong {
  color: #2fbf71;
}

.summary-card.is-primary strong {
  color: #2f80ed;
}

.record-panel {
  padding: 16px;
}

.filter-bar {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 150px 130px 130px auto auto;
  gap: 10px;
  margin-bottom: 16px;
}

.record-table {
  width: 100%;
}

.main-cell,
.muted-cell,
.amount-cell,
.number-cell,
.type-cell {
  display: flex;
  flex-direction: column;
  gap: 5px;
  line-height: 1.25;
}

.type-cell {
  align-items: flex-start;
}

.main-cell span,
.main-cell small,
.muted-cell span,
.amount-cell span,
.number-cell span {
  color: hsl(var(--muted-foreground));
}

.type-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 68px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid rgba(47, 128, 237, 0.28);
  border-radius: 4px;
  color: #2f80ed;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  background: rgba(47, 128, 237, 0.12);
}

.direction-text {
  padding-left: 2px;
  color: hsl(var(--muted-foreground));
  font-size: 13px;
}

.direction-text.is-debit {
  color: #f56c6c;
}

.direction-text.is-credit {
  color: #2fbf71;
}

.amount-cell strong,
.number-cell strong {
  font-size: 16px;
}

.order-items {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 16px 12px 64px;
}

.order-item-row {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) 140px 120px 100px;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border: 1px solid hsl(var(--border));
  border-radius: 8px;
  background: hsl(var(--muted) / 35%);
}

.order-item-main,
.order-item-amount {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.order-item-main span,
.order-item-amount span,
.empty-detail {
  color: hsl(var(--muted-foreground));
}

.empty-detail {
  display: block;
  padding: 12px 16px 12px 64px;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}

@media (max-width: 1100px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .filter-bar {
    grid-template-columns: 1fr 1fr;
  }

  .order-item-row {
    grid-template-columns: 1fr 120px;
  }
}

@media (max-width: 640px) {
  .consumption-page {
    padding: 12px;
  }

  .page-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .summary-grid,
  .filter-bar {
    grid-template-columns: 1fr;
  }

  .pagination-bar {
    justify-content: flex-start;
    overflow-x: auto;
  }

  .order-items,
  .empty-detail {
    padding-left: 12px;
  }

  .order-item-row {
    grid-template-columns: 1fr;
  }
}
</style>

