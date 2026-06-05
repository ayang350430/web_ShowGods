<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { useUserStore } from '@vben/stores';

import {
  ElButton,
  ElDatePicker,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElPagination,
  ElPopconfirm,
  ElSelect,
  ElTag,
} from 'element-plus';

import {
  getConsumptionRecordsApi,
  requestBatchRefundApi,
  requestOrderRefundApi,
} from '#/api';

const loading = ref(false);
const route = useRoute();
const records = ref<OrderApi.ConsumptionRecord[]>([]);
const expandedRecordIds = ref(new Set<number>());
const userStore = useUserStore();
const summary = ref<OrderApi.ConsumptionRecordSummary>({
  expense_amount: 0,
  income_amount: 0,
  net_amount: 0,
  refund_amount: 0,
});

const filters = reactive({
  dateRange: null as [string, string] | null,
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

function formatShortDateTime(value?: string) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortenFlowNo(value?: string) {
  if (!value || value.length <= 22) {
    return value || '-';
  }
  return `${value.slice(0, 14)}…${value.slice(-6)}`;
}

function recordTypePillClass(type: string) {
  if (type === 'refund') {
    return 'flow-badge--success';
  }
  if (type === 'order_charge') {
    return 'flow-badge--danger';
  }
  if (type === 'recharge') {
    return 'flow-badge--primary';
  }
  return 'flow-badge--muted';
}

function toggleRecordExpand(id: number) {
  const next = new Set(expandedRecordIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedRecordIds.value = next;
}

function collapseEnter(el: Element) {
  const h = el as HTMLElement;
  h.style.overflow = 'hidden';
  h.style.height = '0';
  h.style.opacity = '0';
  void h.offsetHeight;
  h.style.transition = 'height 0.3s ease-out, opacity 0.25s ease-out';
  h.style.height = `${h.scrollHeight}px`;
  h.style.opacity = '1';
}
function collapseAfterEnter(el: Element) {
  const h = el as HTMLElement;
  h.style.height = '';
  h.style.overflow = '';
  h.style.transition = '';
}
function collapseLeave(el: Element) {
  const h = el as HTMLElement;
  h.style.overflow = 'hidden';
  h.style.height = `${h.scrollHeight}px`;
  void h.offsetHeight;
  h.style.transition = 'height 0.25s ease-in, opacity 0.2s ease-in';
  h.style.height = '0';
  h.style.opacity = '0';
}
function collapseAfterLeave(el: Element) {
  const h = el as HTMLElement;
  h.style.height = '';
  h.style.overflow = '';
  h.style.transition = '';
  h.style.opacity = '';
}

function flowAmountText(row: OrderApi.ConsumptionRecord) {
  const amount = recordMainAmount(row);
  if (row.direction === 'credit' || row.record_type === 'refund') {
    return `+${formatMoney(amount)}`;
  }
  return formatMoney(amount);
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
      date_from: filters.dateRange?.[0] || undefined,
      date_to: filters.dateRange?.[1] || undefined,
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
  filters.dateRange = null;
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

    <section class="record-panel" v-loading="loading">
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
        <ElDatePicker
          v-model="filters.dateRange"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          value-format="YYYY-MM-DD"
          clearable
        />
        <ElButton type="primary" @click="searchRecords">查询</ElButton>
        <ElButton @click="resetFilters">重置</ElButton>
        <span class="filter-count">共 {{ pagination.total.toLocaleString('zh-CN') }} 条</span>
      </div>

      <div v-if="!loading && records.length === 0" class="empty-state">
        <p>暂无消费记录</p>
        <small>调整筛选条件后重试</small>
      </div>

      <div v-else class="flow-list-wrap">
        <div class="flow-list-head">
          <span />
          <span>类型</span>
          <span>关联信息</span>
          <span>状态</span>
          <span class="col-amount">金额</span>
        </div>
        <div class="flow-list">
        <article
          v-for="row in records"
          :key="row.id"
          class="flow-card"
          :class="{ 'flow-card--expanded': expandedRecordIds.has(row.id) }"
        >
          <div class="flow-head" @click="toggleRecordExpand(row.id)">
            <span class="expand-arrow" :class="{ open: expandedRecordIds.has(row.id) }">›</span>
            <div class="flow-type-col">
              <span class="flow-dot" :class="recordTypePillClass(row.record_type)" />
              <span class="flow-type-text">{{ recordTypeLabel(row.record_type) }}</span>
            </div>
            <div class="flow-center">
              <span class="flow-ref-main" :title="isBalanceAdjustment(row) ? (row.reason_message || row.remark) : (row.batch_no || row.order_no || row.record_no)">
                {{
                  isBalanceAdjustment(row)
                    ? (row.reason_message || row.remark || '余额调整')
                    : (row.batch_no || row.order_no || shortenFlowNo(row.record_no))
                }}
              </span>
              <span class="flow-meta-inline">
                {{ formatShortDateTime(row.created_at) }}
                <i>·</i>
                {{ row.display_name || row.username || '-' }}
                <i>·</i>
                <em :class="`is-${row.direction}`">{{ directionLabel(row.direction) }}</em>
                <template v-if="!isBalanceAdjustment(row)">
                  <i>·</i>{{ row.ordered_quantity.toLocaleString('zh-CN') }} 个
                </template>
              </span>
            </div>
            <span class="status-pill" :class="`status-pill--${row.status}`">{{ statusLabel(row.status) }}</span>
            <div class="flow-amount-col">
              <strong
                class="flow-amount"
                :class="{
                  'flow-amount--credit': row.direction === 'credit' || row.record_type === 'refund',
                  'flow-amount--debit': row.direction === 'debit' && row.record_type !== 'refund',
                }"
              >
                {{ flowAmountText(row) }}
              </strong>
              <span class="flow-sub">余 {{ formatMoney(row.after_available_amount) }}</span>
            </div>
          </div>

          <Transition
            @enter="collapseEnter"
            @after-enter="collapseAfterEnter"
            @leave="collapseLeave"
            @after-leave="collapseAfterLeave"
          >
            <div v-if="expandedRecordIds.has(row.id)" class="flow-body">
            <div class="flow-stats">
              <div class="flow-stat">
                <span>流水号</span>
                <strong>{{ row.record_no }}</strong>
              </div>
              <div class="flow-stat">
                <span>关联</span>
                <strong>{{ isBalanceAdjustment(row) ? '余额调整' : row.order_no || row.batch_no || '-' }}</strong>
              </div>
              <div class="flow-stat">
                <span>单价</span>
                <strong>{{ isBalanceAdjustment(row) ? '-' : formatUnitPrice(recordDisplayPrice(row)) }}</strong>
              </div>
              <div class="flow-stat">
                <span>净额</span>
                <strong>{{ formatMoney(row.net_amount) }}</strong>
              </div>
              <div class="flow-stat">
                <span>退款</span>
                <strong>{{ formatMoney(row.refund_amount) }}</strong>
              </div>
              <div class="flow-stat flow-stat--wide">
                <span>余额</span>
                <strong>{{ formatMoney(row.before_available_amount) }} → {{ formatMoney(row.after_available_amount) }}</strong>
              </div>
            </div>

            <div v-if="row.order_items?.length" class="order-items">
              <div v-if="canManageRefund && batchRefundableOrders(row).length > 0" class="batch-action-bar">
                <span>{{ row.order_items.length }} 条订单 · {{ batchRefundableOrders(row).length }} 条可退</span>
                <ElButton
                  type="danger"
                  size="small"
                  plain
                  :loading="batchRefundLoading"
                  @click.stop="handleBatchRefund(row)"
                >
                  批次全部退款
                </ElButton>
              </div>
              <article
                v-for="item in row.order_items"
                :key="item.order_id"
                class="order-row"
              >
                <div class="order-row-main">
                  <code class="order-row-no">{{ item.order_no }}</code>
                  <div class="order-row-tags">
                    <span class="order-chip">{{ item.ordered_quantity.toLocaleString('zh-CN') }} 个</span>
                    <ElTag :type="orderStatusTagType(item.order_status)" effect="plain" size="small">
                      {{ orderStatusLabel(item.order_status) }}
                    </ElTag>
                    <span v-if="item.target_type" class="order-chip order-chip--type">
                      {{ targetTypeLabel(item.target_type) }}
                    </span>
                    <span class="order-progress">
                      完成 {{ item.completed_quantity ?? 0 }}/{{ item.ordered_quantity }}
                    </span>
                  </div>
                  <p v-if="item.note_id" class="order-note">
                    笔记
                    <a
                      v-if="item.note_url"
                      :href="item.note_url"
                      target="_blank"
                      rel="noopener"
                      @click.stop
                    >{{ item.note_id }}</a>
                    <span v-else>{{ item.note_id }}</span>
                  </p>
                </div>
                <div class="order-row-side">
                  <strong>{{ formatMoney(item.actual_paid_amount) }}</strong>
                  <span v-if="item.refund_amount" class="order-refunded">已退 {{ formatMoney(item.refund_amount) }}</span>
                  <ElPopconfirm
                    v-if="canManageRefund && canRequestRefund(item)"
                    title="确认申请这条订单退款？申请后需要管理员审核。"
                    confirm-button-text="申请退款"
                    cancel-button-text="取消"
                    @confirm="requestRefund(item.order_id)"
                  >
                    <template #reference>
                      <button class="order-btn order-btn--refund" @click.stop>申请退款</button>
                    </template>
                  </ElPopconfirm>
                  <button v-else-if="canManageRefund" class="order-btn order-btn--disabled" disabled>
                    {{ disabledRefundLabel(item) }}
                  </button>
                </div>
              </article>
            </div>
            <p v-else class="empty-detail">这条记录没有关联订单明细</p>
            </div>
          </Transition>
        </article>
        </div>
      </div>

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
  min-height: calc(100dvh - 88px);
  padding: 20px;
  box-sizing: border-box;
  color: var(--el-text-color-primary);
}

.page-head,
.summary-grid {
  flex-shrink: 0;
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
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: var(--el-bg-color);
  box-shadow: 0 1px 2px rgb(15 23 42 / 3%);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.stat-card:hover {
  border-color: var(--el-color-primary-light-7);
  box-shadow: 0 4px 12px rgb(15 23 42 / 6%);
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
.stat-body strong { font-size: 20px; font-weight: 700; line-height: 1.1; }

.stat-card--danger .stat-body strong { color: var(--el-color-danger); }
.stat-card--success .stat-body strong { color: var(--el-color-success); }
.stat-card--primary .stat-body strong { color: var(--el-color-primary); }

/* ---- record panel ---- */
.record-panel {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  padding: 18px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-shrink: 0;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
}

.filter-bar :deep(.el-input) {
  width: 220px;
}

.filter-bar :deep(.el-select) {
  width: 120px;
}

.filter-bar :deep(.el-date-editor) {
  width: 240px;
}

.filter-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--el-text-color-secondary);
}

.empty-state p {
  margin: 0;
  font-size: 14px;
}

.empty-state small {
  font-size: 12px;
  opacity: 0.85;
}

.flow-list-wrap {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  overflow: hidden;
  background: var(--el-fill-color-lighter);
}

.flow-list-head {
  display: grid;
  grid-template-columns: 28px 88px minmax(0, 1fr) 64px 120px;
  gap: 10px;
  align-items: center;
  padding: 9px 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--el-text-color-secondary);
  background: color-mix(in srgb, var(--el-bg-color) 88%, var(--el-fill-color));
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}

.flow-list-head .col-amount {
  text-align: right;
}

.flow-list {
  flex: 1 1 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}

.flow-card {
  flex-shrink: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  overflow: hidden;
  background: var(--el-bg-color);
  box-shadow: 0 1px 2px rgb(15 23 42 / 4%);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.flow-card:hover {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 2px 8px rgb(15 23 42 / 6%);
}

.flow-card--expanded {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 4px 14px rgb(15 23 42 / 8%);
}

.flow-head {
  display: grid;
  grid-template-columns: 28px 88px minmax(0, 1fr) 64px 120px;
  gap: 10px;
  align-items: center;
  padding: 11px 12px;
  cursor: pointer;
  transition: background 0.12s;
}

.flow-head:hover {
  background: var(--el-fill-color-lighter);
}

.expand-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
  color: var(--el-text-color-placeholder);
  transform: rotate(0deg);
  transform-origin: center center;
  transition: transform 0.25s ease, color 0.2s;
  user-select: none;
}

.expand-arrow.open {
  transform: rotate(90deg);
  color: var(--el-color-primary);
}

.flow-type-col {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.flow-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.flow-dot.flow-badge--danger { background: var(--el-color-danger); }
.flow-dot.flow-badge--success { background: var(--el-color-success); }
.flow-dot.flow-badge--primary { background: var(--el-color-primary); }
.flow-dot.flow-badge--muted { background: var(--el-text-color-placeholder); }

.flow-type-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.flow-center {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.flow-ref-main {
  font-size: 13px;
  font-weight: 600;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flow-meta-inline {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flow-meta-inline i {
  font-style: normal;
  margin: 0 2px;
  opacity: 0.55;
}

.flow-meta-inline em {
  font-style: normal;
  font-weight: 600;
}

.flow-meta-inline em.is-debit { color: var(--el-color-danger); }
.flow-meta-inline em.is-credit { color: var(--el-color-success); }

.status-pill {
  justify-self: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.status-pill--success {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.status-pill--failed {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.status-pill--pending {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.flow-amount-col {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  min-width: 0;
}

.flow-amount {
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.flow-amount--debit { color: var(--el-color-danger); }
.flow-amount--credit { color: var(--el-color-success); }

.flow-sub {
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  white-space: nowrap;
}

.flow-body {
  border-top: 1px solid var(--el-border-color-extra-light);
  padding: 12px 14px 14px;
  background: color-mix(in srgb, var(--el-fill-color-lighter) 50%, var(--el-bg-color));
}

.flow-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}

.flow-stat {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
  min-width: 0;
}

.flow-stat--wide {
  flex: 1 1 100%;
}

.flow-stat span {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.flow-stat strong {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}

.order-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.batch-action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  margin-bottom: 4px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.order-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  transition: border-color 0.12s;
}

.order-row:hover {
  border-color: var(--el-color-primary-light-5);
}

.order-row-main {
  flex: 1;
  min-width: 0;
}

.order-row-no {
  display: block;
  font-size: 12px;
  font-weight: 600;
  font-family: ui-monospace, Consolas, monospace;
  word-break: break-all;
}

.order-row-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.order-chip {
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--el-fill-color);
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.order-chip--type {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
}

.order-progress {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.order-note {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.order-note a {
  margin-left: 4px;
  color: var(--el-color-primary);
  text-decoration: none;
}

.order-note a:hover {
  text-decoration: underline;
}

.order-row-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}

.order-row-side strong {
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.order-refunded {
  font-size: 11px;
  color: var(--el-color-warning);
  white-space: nowrap;
}

.order-btn {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.15s;
  white-space: nowrap;
}

.order-btn--refund {
  border-color: var(--el-color-warning-light-5);
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.order-btn--refund:hover {
  background: var(--el-color-warning);
  color: #fff;
}

.order-btn--disabled {
  border-color: var(--el-border-color-lighter);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-disabled);
  cursor: not-allowed;
}

.empty-detail {
  margin: 0;
  padding: 8px 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 14px;
  flex-shrink: 0;
}

/* ---- responsive ---- */
@media (max-width: 1100px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }

  .flow-list-head {
    display: none;
  }

  .flow-head {
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 8px;
  }

  .flow-type-col,
  .status-pill,
  .flow-amount-col {
    grid-column: 2;
  }

  .flow-type-col {
    margin-bottom: 2px;
  }

  .flow-amount-col {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    margin-top: 4px;
    padding-top: 6px;
    border-top: 1px dashed var(--el-border-color-extra-light);
  }

  .order-row {
    flex-direction: column;
  }

  .order-row-side {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }
}

@media (max-width: 640px) {
  .consumption-page {
    padding: 12px;
    min-height: calc(100dvh - 72px);
  }
  .page-head { align-items: flex-start; flex-direction: column; }
  .summary-grid { grid-template-columns: 1fr; }
  .filter-bar :deep(.el-input),
  .filter-bar :deep(.el-select),
  .filter-bar :deep(.el-date-editor) {
    width: 100%;
  }
  .filter-count {
    width: 100%;
    margin-left: 0;
  }
  .pagination-bar { justify-content: flex-start; overflow-x: auto; }
  .flow-stats { grid-template-columns: 1fr; }
  .batch-action-bar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>

