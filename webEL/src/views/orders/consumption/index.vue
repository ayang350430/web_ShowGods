<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { useUserStore } from '@vben/stores';

import {
  ElButton,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElPagination,
  ElPopconfirm,
  ElSelect,
  ElTable,
  ElTableColumn,
  ElTag,
} from 'element-plus';

import {
  getConsumptionRecordsApi,
  requestBatchRefundApi,
  requestOrderRefundApi,
} from '#/api';

const loading = ref(false);
const tableRef = ref<InstanceType<typeof ElTable>>();
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


const canManageRefund = computed(() =>
  (userStore.userInfo?.roles ?? []).some((role) => ['admin', 'super', 'user'].includes(role)),
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
  const unitPrice = Number(row.discounted_unit_price || 0);
  if (unitPrice > 0) return unitPrice;
  // fallback: calculate from totals
  if (row.record_type === 'refund') {
    const qty = Number(row.refunded_quantity) || Number(row.ordered_quantity) || 1;
    return Number(row.refund_amount || 0) / qty;
  }
  const qty = Number(row.ordered_quantity) || 1;
  return Number(row.actual_paid_amount || 0) / qty;
}

function recordOriginalPrice(row: OrderApi.ConsumptionRecord) {
  const unitPrice = Number(row.original_unit_price || 0);
  if (unitPrice > 0) return unitPrice;
  // fallback: same as display price
  return recordDisplayPrice(row);
}

function recordMainAmount(row: OrderApi.ConsumptionRecord) {
  // refund records have actual_paid_amount=0 in DB, use refund_amount instead
  if (row.record_type === 'refund') {
    return Number(row.refund_amount || 0);
  }
  return Number(row.actual_paid_amount || 0);
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

function targetTypeLabel(type: string) {
  const map: Record<string, string> = {
    exposure: '曝光',
    like: '点赞',
    read: '阅读',
  };
  return map[type] || type || '-';
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
    return '补单审批中';
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

const batchRefundLoading = ref(false);

async function requestRefund(orderId: number) {
  await requestOrderRefundApi(orderId);
  ElMessage.success('已提交退款申请，等待管理员审核');
  await loadRecords();
}

function batchRefundableOrders(row: OrderApi.ConsumptionRecord) {
  return (row.order_items || []).filter((item) => {
    const blocked = [
      'failed',
      'refund_approved',
      'refund_calculating',
      'refund_rejected',
      'refund_requested',
      'stopping',
    ];
    return !blocked.includes(item.order_status);
  });
}

async function handleBatchRefund(row: OrderApi.ConsumptionRecord) {
  const eligible = batchRefundableOrders(row);
  if (eligible.length === 0) {
    ElMessage.warning('该批次没有可退款的订单');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `该批次共 ${row.order_items.length} 条订单，其中 ${eligible.length} 条可退款。确定全部申请退款吗？`,
      '批次全部退款',
      { confirmButtonText: '确定退款', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  batchRefundLoading.value = true;
  try {
    const result = await requestBatchRefundApi(row.batch_id);
    if (result.failed_count === 0) {
      ElMessage.success(`已成功提交 ${result.success_count} 条退款申请`);
    } else {
      ElMessage.warning(`提交完成：${result.success_count} 条成功，${result.failed_count} 条失败`);
    }
  } catch (error: any) {
    ElMessage.error(error?.message || '批量退款失败');
  } finally {
    batchRefundLoading.value = false;
  }
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
      <div class="head-text">
        <span class="eyebrow">Consumption</span>
        <h1>消费记录</h1>
        <p>展示真实账户流水，包含下单扣费、退款、余额变化和关联订单。</p>
      </div>
      <button class="head-btn" :disabled="loading" @click="loadRecords">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </section>

    <section class="summary-grid">
      <div class="stat-card stat-card--danger">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M5.05 3.636a1 1 0 010 1.414 7 7 0 000 9.9 1 1 0 11-1.414 1.414 9 9 0 010-12.728 1 1 0 011.414 0zm9.9 0a1 1 0 011.414 0 9 9 0 010 12.728 1 1 0 11-1.414-1.414 7 7 0 000-9.9 1 1 0 010-1.414zM7.879 6.464a1 1 0 010 1.414 3 3 0 000 4.243 1 1 0 11-1.415 1.414 5 5 0 010-7.07 1 1 0 011.415 0zm4.242 0a1 1 0 011.415 0 5 5 0 010 7.072 1 1 0 01-1.415-1.415 3 3 0 000-4.242 1 1 0 010-1.415zM10 9a1 1 0 100 2 1 1 0 000-2z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>支出金额</span>
          <strong>{{ formatMoney(summary.expense_amount) }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--success">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 4a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>退款金额</span>
          <strong>{{ formatMoney(summary.refund_amount) }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--primary">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M11 17a1 1 0 001.447.894l4-2A1 1 0 0017 15V9.236a1 1 0 00-1.447-.894l-4 2a1 1 0 00-.553.894V17zM15.211 6.276a1 1 0 000-1.788l-4.764-2.382a1 1 0 00-.894 0L4.789 4.488a1 1 0 000 1.788l4.764 2.382a1 1 0 00.894 0l4.764-2.382zM4.447 8.342A1 1 0 003 9.236V15a1 1 0 00.553.894l4 2A1 1 0 009 17v-5.764a1 1 0 00-.553-.894l-4-2z" /></svg></div>
        <div class="stat-body">
          <span>净消费</span>
          <strong>{{ formatMoney(Math.abs(summary.net_amount)) }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--normal">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" /><path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>记录数</span>
          <strong>{{ pagination.total.toLocaleString('zh-CN') }}</strong>
        </div>
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
        ref="tableRef"
        v-loading="loading"
        :data="records"
        row-key="id"
        class="record-table"
        empty-text="暂无消费记录"
        @row-click="(row: OrderApi.ConsumptionRecord) => tableRef?.toggleRowExpansion(row)"
      >
        <ElTableColumn type="expand" width="44">
          <template #default="{ row }">
            <div v-if="row.order_items?.length" class="order-items">
              <div v-if="canManageRefund && batchRefundableOrders(row).length > 0" class="batch-refund-bar">
                <span>该批次共 {{ row.order_items.length }} 条订单，{{ batchRefundableOrders(row).length }} 条可退款</span>
                <ElButton
                  type="danger"
                  size="small"
                  :loading="batchRefundLoading"
                  @click.stop="handleBatchRefund(row)"
                >
                  批次全部退款
                </ElButton>
              </div>
              <div
                v-for="item in row.order_items"
                :key="item.order_id"
                class="order-item-card"
              >
                <div class="oic-left">
                  <div class="oic-no">{{ item.order_no }}</div>
                  <div class="oic-meta">
                    <span class="oic-chip">{{ item.ordered_quantity.toLocaleString('zh-CN') }} 个</span>
                    <ElTag :type="orderStatusTagType(item.order_status)" effect="plain" size="small">
                      {{ orderStatusLabel(item.order_status) }}
                    </ElTag>
                  </div>
                  <div v-if="item.note_id || item.target_type" class="oic-note-row">
                    <span v-if="item.note_id" class="oic-note">
                      <span class="oic-note-label">笔记</span>
                      <a
                        v-if="item.note_url"
                        :href="item.note_url"
                        target="_blank"
                        rel="noopener"
                        class="oic-note-id"
                      >{{ item.note_id }}</a>
                      <span v-else class="oic-note-id">{{ item.note_id }}</span>
                    </span>
                    <span v-if="item.target_type" class="oic-target-tag">{{ targetTypeLabel(item.target_type) }}</span>
                    <span class="oic-progress">完成 <strong>{{ item.completed_quantity ?? 0 }}</strong> / {{ item.ordered_quantity }}</span>
                  </div>
                </div>
                <div class="oic-right">
                  <div class="oic-money">
                    <strong>{{ formatMoney(item.actual_paid_amount) }}</strong>
                    <span v-if="item.refund_amount" class="oic-refunded">已退 {{ formatMoney(item.refund_amount) }}</span>
                  </div>
                  <ElPopconfirm
                    v-if="canManageRefund && canRequestRefund(item)"
                    title="确认申请这条订单退款？申请后需要管理员审核。"
                    confirm-button-text="申请退款"
                    cancel-button-text="取消"
                    @confirm="requestRefund(item.order_id)"
                  >
                    <template #reference>
                      <button class="oic-btn oic-btn--refund" @click.stop>申请退款</button>
                    </template>
                  </ElPopconfirm>
                  <button v-else-if="canManageRefund" class="oic-btn oic-btn--disabled" disabled>
                    {{ disabledRefundLabel(item) }}
                  </button>
                </div>
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
              <template v-if="row.record_type === 'refund'">
                <strong class="text-success">+{{ formatMoney(row.refund_amount) }}</strong>
                <span>净额 {{ formatMoney(row.net_amount) }}</span>
              </template>
              <template v-else>
                <strong>{{ formatMoney(row.actual_paid_amount) }}</strong>
                <span>退款 {{ formatMoney(row.refund_amount) }}</span>
                <span>净额 {{ formatMoney(row.net_amount) }}</span>
              </template>
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
  color: var(--el-text-color-primary);
}

/* ---- header ---- */
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 24px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.eyebrow {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--el-color-primary);
}

.page-head h1 { margin: 2px 0 0; font-size: 22px; font-weight: 700; }
.page-head p { margin: 4px 0 0; font-size: 13px; color: var(--el-text-color-secondary); }

.head-btn {
  padding: 8px 20px;
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 8px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.head-btn:hover:not(:disabled) { background: var(--el-color-primary); color: #fff; }
.head-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ---- stat cards ---- */
.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.stat-card:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
}

.stat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 10px;
  flex-shrink: 0;
}

.stat-card--danger .stat-icon { background: var(--el-color-danger-light-8); color: var(--el-color-danger); }
.stat-card--success .stat-icon { background: var(--el-color-success-light-8); color: var(--el-color-success); }
.stat-card--primary .stat-icon { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.stat-card--normal .stat-icon { background: var(--el-fill-color); color: var(--el-text-color-secondary); }

.stat-body { display: flex; flex-direction: column; gap: 4px; }
.stat-body span { font-size: 12px; color: var(--el-text-color-secondary); }
.stat-body strong { font-size: 22px; font-weight: 700; line-height: 1.1; }

.stat-card--danger .stat-body strong { color: var(--el-color-danger); }
.stat-card--success .stat-body strong { color: var(--el-color-success); }
.stat-card--primary .stat-body strong { color: var(--el-color-primary); }

/* ---- record panel ---- */
.record-panel {
  padding: 18px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.filter-bar {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 150px 130px 130px auto auto;
  gap: 10px;
  margin-bottom: 16px;
}

/* ---- table ---- */
.record-table { width: 100%; }
.record-table :deep(.el-table__row) { cursor: pointer; }

:deep(.el-table) {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: var(--el-fill-color-light);
}
:deep(.el-table th.el-table__cell) { background: var(--el-fill-color-light); }

.main-cell,
.muted-cell,
.amount-cell,
.number-cell,
.type-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.3;
}

.type-cell { align-items: flex-start; }

.main-cell strong { font-size: 13px; font-family: Consolas, monospace; }
.main-cell span,
.main-cell small,
.muted-cell span,
.amount-cell span,
.number-cell span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.type-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 68px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 6px;
  color: var(--el-color-primary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  background: var(--el-color-primary-light-9);
}

.direction-text {
  padding-left: 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}
.direction-text.is-debit { color: var(--el-color-danger); }
.direction-text.is-credit { color: var(--el-color-success); }

.amount-cell strong,
.number-cell strong {
  font-size: 14px;
  font-family: Consolas, monospace;
}

.amount-cell .text-success { color: var(--el-color-success); }

.muted-cell strong {
  font-family: Consolas, monospace;
  font-size: 13px;
}

/* ---- expand section ---- */
.order-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px 12px 64px;
}

.batch-refund-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border: 1px dashed var(--el-color-danger-light-3);
  border-radius: 8px;
  background: var(--el-color-danger-light-9);
}
.batch-refund-bar > span { color: var(--el-text-color-secondary); font-size: 13px; }

.order-item-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.order-item-card:hover {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.04);
}

.oic-left {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.oic-no {
  font-family: Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oic-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}
.oic-chip {
  padding: 1px 8px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.oic-note-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.oic-note {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.oic-note-label {
  color: var(--el-text-color-secondary);
}
.oic-note-id {
  font-family: Consolas, monospace;
  font-size: 12px;
  color: var(--el-text-color-primary);
}
a.oic-note-id {
  color: var(--el-color-primary);
  text-decoration: none;
}
a.oic-note-id:hover {
  text-decoration: underline;
}
.oic-target-tag {
  padding: 1px 8px;
  border-radius: 4px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 11px;
  font-weight: 600;
}
.oic-progress {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.oic-progress strong {
  font-family: Consolas, monospace;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.oic-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
}
.oic-money {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}
.oic-money strong {
  font-family: Consolas, monospace;
  font-size: 14px;
  font-weight: 700;
}
.oic-refunded {
  font-size: 11px;
  color: var(--el-color-warning);
}

.oic-btn {
  padding: 5px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.15s;
  white-space: nowrap;
}
.oic-btn--refund {
  border-color: var(--el-color-warning-light-5);
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}
.oic-btn--refund:hover { background: var(--el-color-warning); color: #fff; }
.oic-btn--disabled {
  border-color: var(--el-border-color-lighter);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-disabled);
  cursor: not-allowed;
}

.empty-detail { display: block; padding: 12px 16px 12px 64px; }

.pagination-bar { display: flex; justify-content: flex-end; padding-top: 16px; }

/* ---- responsive ---- */
@media (max-width: 1100px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .filter-bar { grid-template-columns: 1fr 1fr; }
  .order-item-card { flex-wrap: wrap; }
}

@media (max-width: 640px) {
  .consumption-page { padding: 12px; }
  .page-head { align-items: flex-start; flex-direction: column; }
  .summary-grid, .filter-bar { grid-template-columns: 1fr; }
  .pagination-bar { justify-content: flex-start; overflow-x: auto; }
  .order-items, .empty-detail { padding-left: 12px; }
  .order-item-row { grid-template-columns: 1fr; }
}
</style>

