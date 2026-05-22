<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import {
  ElButton,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElPagination,
  ElSelect,
  ElTag,
} from 'element-plus';

import {
  getBatchOrderRecordsApi,
  getBatchOrdersApi,
  requestOrderRefundApi,
} from '#/api';

type OrderStatusFilter = 'all' | 'failed' | 'running' | 'success';

const loading = ref(false);
const polling = ref(false);
const router = useRouter();
const records = ref<OrderApi.BatchOrderRecord[]>([]);
const selectedBatchId = ref<number>();
const batchKeyword = ref('');
const orderKeyword = ref('');
const orderStatusFilter = ref<OrderStatusFilter>('all');
const expandedOrderIds = ref(new Set<number>());
const batchOrders = ref<OrderApi.BatchOrderRecordItem[]>([]);
const batchOrdersLoading = ref(false);
const refundLoadingId = ref<number>();

function canRequestRefund(order: OrderApi.BatchOrderRecordItem) {
  const blocked = [
    'failed',
    'refund_approved',
    'refund_calculating',
    'refund_rejected',
    'refund_requested',
    'stopping',
  ];
  if (blocked.includes(order.order_status)) return false;
  if (Number(order.refund_amount || 0) > 0) return false;
  return true;
}

async function handleRequestRefund(order: OrderApi.BatchOrderRecordItem) {
  try {
    await ElMessageBox.confirm(
      `确定要对订单 ${order.order_no} 申请退款吗？提交后将停止任务并进入退款流程。`,
      '申请退款',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  refundLoadingId.value = order.id;
  try {
    await requestOrderRefundApi(order.id);
    ElMessage.success('退款申请已提交');
    await loadRecords();
  } catch (error: any) {
    ElMessage.error(error?.message || '退款申请失败');
  } finally {
    refundLoadingId.value = undefined;
  }
}

function toggleOrderExpand(id: number) {
  const set = expandedOrderIds.value;
  if (set.has(id)) {
    set.delete(id);
  } else {
    set.add(id);
  }
}

function expandEnter(el: Element) {
  const htmlEl = el as HTMLElement;
  htmlEl.style.overflow = 'hidden';
  htmlEl.style.height = '0';
  htmlEl.style.opacity = '0';
  void htmlEl.offsetHeight;
  htmlEl.style.transition = 'height 0.3s ease-out, opacity 0.25s ease-out';
  htmlEl.style.height = `${htmlEl.scrollHeight}px`;
  htmlEl.style.opacity = '1';
}
function expandAfterEnter(el: Element) {
  const htmlEl = el as HTMLElement;
  htmlEl.style.height = '';
  htmlEl.style.overflow = '';
  htmlEl.style.transition = '';
}
function expandLeave(el: Element) {
  const htmlEl = el as HTMLElement;
  htmlEl.style.overflow = 'hidden';
  htmlEl.style.height = `${htmlEl.scrollHeight}px`;
  void htmlEl.offsetHeight;
  htmlEl.style.transition = 'height 0.25s ease-in, opacity 0.2s ease-in';
  htmlEl.style.height = '0';
  htmlEl.style.opacity = '0';
}
function expandAfterLeave(el: Element) {
  const htmlEl = el as HTMLElement;
  htmlEl.style.height = '';
  htmlEl.style.overflow = '';
  htmlEl.style.transition = '';
  htmlEl.style.opacity = '';
}
const pagination = ref({
  page: 1,
  page_size: 10,
  total: 0,
});
let pollingTimer: ReturnType<typeof setInterval> | undefined;

const filteredRecords = computed(() => {
  const keyword = batchKeyword.value.trim().toLowerCase();
  if (!keyword) {
    return records.value;
  }

  return records.value.filter((record) =>
    [
      record.batch_no,
      record.batch_id,
      record.status,
      batchStatusLabel(record.status),
      batchTargetTypeLabel(record),
      record.submitted_at,
      record.created_at,
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword),
  );
});

const selectedBatch = computed(() =>
  records.value.find((record) => record.id === selectedBatchId.value),
);

const selectedBatchNeedsReplenish = computed(() =>
  batchOrders.value.some((order) => order.order_status === 'repair_review'),
);

const filteredOrders = computed(() => {
  const orders = batchOrders.value;
  const keyword = orderKeyword.value.trim().toLowerCase();

  return orders.filter((order) => {
    const statusMatched =
      orderStatusFilter.value === 'all' ||
      (orderStatusFilter.value === 'success' && order.order_status === 'completed') ||
      (orderStatusFilter.value === 'failed' && order.order_status === 'failed') ||
      (orderStatusFilter.value === 'running' &&
        !['completed', 'failed'].includes(order.order_status));

    if (!statusMatched) {
      return false;
    }
    if (!keyword) {
      return true;
    }

    return [
      order.order_no,
      order.note_id,
      order.note_url,
      order.source_note_url,
      order.order_status,
      orderStatusLabel(order.order_status),
      targetTypeLabel(order.target_type),
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword);
  });
});

const serverSummary = ref({
  processing_orders: 0,
  total_actual_paid: 0,
  total_orders: 0,
});

const summary = computed(() => ({
  runningOrders: serverSummary.value.processing_orders,
  totalAmount: serverSummary.value.total_actual_paid,
  totalBatches: pagination.value.total,
  totalOrders: serverSummary.value.total_orders,
}));

function batchActualPaidAmount(record: OrderApi.BatchOrderRecord) {
  if (record.total_actual_paid !== undefined) {
    return Number(record.total_actual_paid) || 0;
  }
  return (record.orders ?? []).reduce(
    (total, order) => total + Number(order.actual_paid_amount || 0),
    0,
  );
}

function batchTargetTypeLabel(record: OrderApi.BatchOrderRecord) {
  return targetTypeLabel(record.target_type || record.orders?.[0]?.target_type || '');
}

function openConsumptionBatch(record: OrderApi.BatchOrderRecord) {
  void router.push({
    name: 'ConsumptionRecords',
    query: {
      keyword: record.batch_no,
    },
  });
}

async function loadBatchOrders(batchId: number) {
  batchOrdersLoading.value = true;
  try {
    batchOrders.value = await getBatchOrdersApi(batchId);
  } catch {
    batchOrders.value = [];
    ElMessage.error('加载订单失败');
  } finally {
    batchOrdersLoading.value = false;
  }
}

watch(selectedBatchId, () => {
  orderKeyword.value = '';
  orderStatusFilter.value = 'all';
  expandedOrderIds.value.clear();
  batchOrders.value = [];
  if (selectedBatchId.value) {
    loadBatchOrders(selectedBatchId.value);
  }
});

function formatMoney(value?: number) {
  return `￥ ${(Number(value) || 0).toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
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

function targetTypeLabel(type: string) {
  if (type === 'impression') {
    return '曝光';
  }
  if (type === 'like') {
    return '点赞';
  }
  return '阅读';
}

function batchStatusLabel(status: string) {
  const statusMap: Record<string, string> = {
    completed: '已完成',
    failed: '失败',
    pending: '待处理',
    processing: '处理中',
  };
  return statusMap[status] || status || '-';
}

function orderStatusLabel(status: string) {
  const statusMap: Record<string, string> = {
    completed: '订单完成',
    failed: '订单失败',
    manual_review: '人工处理',
    repair_review: '需要补单',
    refund_requested: '退款中',
    running: '进行中',
    stopping: '停止中',
  };
  Object.assign(statusMap, {
    refund_approved: '退款已通过',
    refund_calculating: '退款计算中',
    refund_rejected: '退款已拒绝',
  });
  return statusMap[status] || status || '-';
}

function externalStatusLabel(status: string, orderStatus?: string) {
  // 退款已通过的订单，兜底显示已停止（正常情况后端已更新为 stopped）
  if (orderStatus === 'refund_approved' && !['stopped', 'completed', 'failed'].includes(status)) return '已停止';
  const map: Record<string, string> = {
    accepted: '已接单',
    completed: '已完成',
    failed: '失败',
    pending: '等待中',
    processing: '处理中',
    running: '进行中',
    stop_requested: '停止请求中',
    stopped: '已停止',
    stopping: '停止中',
  };
  return map[status] || status || '-';
}

function orderDisplayStatusLabel(order: OrderApi.BatchOrderRecordItem) {
  if (order.order_status === 'running' && order.external_status === 'completed') {
    return '上游完成';
  }
  return orderStatusLabel(order.order_status);
}

function refundLabel(order: OrderApi.BatchOrderRecordItem) {
  if (order.order_status === 'refund_approved') {
    return '已退款';
  }
  if (order.order_status === 'refund_rejected') {
    return '退款已拒绝';
  }
  if (['refund_calculating', 'stopping'].includes(order.order_status)) {
    return '退款中';
  }
  if (order.refund_amount > 0) {
    return '已退款';
  }
  if (order.order_status === 'failed' && Number(order.actual_paid_amount || 0) <= 0) {
    return '已退款';
  }
  if (['refund_requested', 'refund_calculating'].includes(order.order_status)) {
    return '退款中';
  }
  return '无退款';
}

function isRefundedOrder(order: OrderApi.BatchOrderRecordItem) {
  return (
    order.order_status === 'refund_approved' ||
    Number(order.refund_amount || 0) > 0 ||
    Number((order as OrderApi.BatchOrderRecordItem & { refunded_quantity?: number })
      .refunded_quantity || 0) > 0 ||
    (order.order_status === 'failed' && Number(order.actual_paid_amount || 0) <= 0)
  );
}

function isRefundingOrder(order: OrderApi.BatchOrderRecordItem) {
  return ['refund_requested', 'refund_calculating', 'stopping'].includes(order.order_status);
}

function isRefundRejectedOrder(order: OrderApi.BatchOrderRecordItem) {
  return order.order_status === 'refund_rejected';
}

function hasRefundedOrder(record: OrderApi.BatchOrderRecord) {
  const s = record.order_status_summary;
  if (s) {
    return (s.refund_approved || 0) > 0;
  }
  return (record.orders || []).some(isRefundedOrder);
}

function hasRefundingOrder(record: OrderApi.BatchOrderRecord) {
  const s = record.order_status_summary;
  if (s) {
    return (
      (s.refund_requested || 0) + (s.refund_calculating || 0) + (s.stopping || 0) > 0
    );
  }
  return (record.orders || []).some(isRefundingOrder);
}

function hasRefundRejectedOrder(record: OrderApi.BatchOrderRecord) {
  const s = record.order_status_summary;
  if (s) {
    return (s.refund_rejected || 0) > 0;
  }
  return (record.orders || []).some(isRefundRejectedOrder);
}

function hasRepairReviewOrder(record: OrderApi.BatchOrderRecord) {
  const s = record.order_status_summary;
  if (s) {
    return (s.repair_review || 0) > 0;
  }
  return (record.orders || []).some((order) => order.order_status === 'repair_review');
}

function batchDisplayStatusLabel(record: OrderApi.BatchOrderRecord) {
  if (hasRepairReviewOrder(record)) {
    return '待补单';
  }
  if (hasRefundedOrder(record)) {
    return '已退款';
  }
  if (hasRefundingOrder(record)) {
    return '退款中';
  }
  if (hasRefundRejectedOrder(record)) {
    return '退款已拒绝';
  }
  return batchStatusLabel(record.status);
}

function batchProgress(record: OrderApi.BatchOrderRecord) {
  const orders = record.orders ?? [];
  if (orders.length > 0) {
    const progressTotal = orders.reduce((sum, order) => sum + orderProgress(order), 0);
    return Math.min(100, Math.max(0, progressTotal / orders.length));
  }
  const total = Number(record.total_count) || 0;
  if (total <= 0) return 0;
  const done = Number(record.succeeded_count) || 0;
  return Math.min(100, Math.max(0, (done / total) * 100));
}

function orderProgress(order: OrderApi.BatchOrderRecordItem) {
  if (order.order_status === 'completed') {
    return 100;
  }
  const externalProgress = Number(order.external_progress);
  if (Number.isFinite(externalProgress) && externalProgress > 0) {
    return Math.min(100, Math.max(0, externalProgress * 100));
  }
  const total = Math.max(Number(order.ordered_quantity) || 0, 0);
  if (total <= 0) {
    return 0;
  }
  const completed = Math.min(Math.max(Number(order.completed_quantity) || 0, 0), total);
  return Math.min(100, Math.max(0, (completed / total) * 100));
}

function copyTextWithFallback(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}

async function copyField(text: string) {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else if (!copyTextWithFallback(text)) {
      throw new Error('copy failed');
    }
    ElMessage.success('已复制');
  } catch {
    if (copyTextWithFallback(text)) {
      ElMessage.success('已复制');
      return;
    }
    ElMessage.error('复制失败');
  }
}

async function loadRecords(options: { silent?: boolean } = {}) {
  if (polling.value) {
    return;
  }
  const silent = Boolean(options.silent);
  polling.value = silent;
  if (!silent) {
    loading.value = true;
  }
  try {
    const orderRecords = await getBatchOrderRecordsApi({
      page: pagination.value.page,
      page_size: pagination.value.page_size,
    }, { silent });
    records.value = orderRecords.items;
    pagination.value.total = orderRecords.total;
    if (orderRecords.summary) {
      serverSummary.value = orderRecords.summary;
    }
    if (
      selectedBatchId.value &&
      !records.value.some((record) => record.id === selectedBatchId.value)
    ) {
      selectedBatchId.value = undefined;
    }
  } finally {
    if (!silent) {
      loading.value = false;
    }
    polling.value = false;
  }
}

function pollRecords() {
  if (document.hidden) {
    return;
  }
  void loadRecords({ silent: true });
}

function startPolling() {
  stopPolling();
  pollingTimer = setInterval(pollRecords, 5 * 60 * 1000);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = undefined;
  }
}

function handleVisibilityChange() {
  if (document.hidden) {
    return;
  }
  pollRecords();
}

function handleBatchPageChange(page: number) {
  pagination.value.page = page;
  selectedBatchId.value = undefined;
  loadRecords();
}

function handleBatchPageSizeChange(pageSize: number) {
  pagination.value.page = 1;
  pagination.value.page_size = pageSize;
  selectedBatchId.value = undefined;
  loadRecords();
}

onMounted(() => {
  void loadRecords();
  startPolling();
  document.addEventListener('visibilitychange', handleVisibilityChange);
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
  <div class="order-record-page">
    <section class="page-head">
      <div class="head-text">
        <span class="eyebrow">Orders</span>
        <h1>下单记录</h1>
        <p v-if="!selectedBatch">默认显示批次，点击批次查看订单明细。</p>
        <p v-else>{{ selectedBatch.batch_no }} 内共有 {{ batchOrdersLoading ? '...' : batchOrders.length }} 条订单。</p>
      </div>
      <div class="head-actions">
        <ElButton
          v-if="selectedBatch"
          @click="selectedBatchId = undefined"
        >
          返回批次
        </ElButton>
        <ElTag
          v-if="selectedBatchNeedsReplenish"
          type="warning"
        >
          补单已自动申请，等待管理员审批
        </ElTag>
        <button class="head-btn" :disabled="loading || batchOrdersLoading" @click="() => { loadRecords(); if (selectedBatchId) loadBatchOrders(selectedBatchId); }">
          {{ loading || batchOrdersLoading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </section>

    <section v-if="!selectedBatch" class="summary-grid">
      <div class="stat-card stat-card--primary">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" /><path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>批次数</span>
          <strong>{{ summary.totalBatches }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--success">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>订单总数</span>
          <strong>{{ summary.totalOrders }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--warning">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>进行中</span>
          <strong>{{ summary.runningOrders }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--danger">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M5.05 3.636a1 1 0 010 1.414 7 7 0 000 9.9 1 1 0 11-1.414 1.414 9 9 0 010-12.728 1 1 0 011.414 0zm9.9 0a1 1 0 011.414 0 9 9 0 010 12.728 1 1 0 11-1.414-1.414 7 7 0 000-9.9 1 1 0 010-1.414zM7.879 6.464a1 1 0 010 1.414 3 3 0 000 4.243 1 1 0 11-1.415 1.414 5 5 0 010-7.07 1 1 0 011.415 0zm4.242 0a1 1 0 011.415 0 5 5 0 010 7.072 1 1 0 01-1.415-1.415 3 3 0 000-4.242 1 1 0 010-1.415zM10 9a1 1 0 100 2 1 1 0 000-2z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>累计消费</span>
          <strong>{{ formatMoney(summary.totalAmount) }}</strong>
        </div>
      </div>
    </section>

    <section class="record-panel" v-loading="loading">
      <div class="filter-bar">
        <template v-if="!selectedBatch">
          <ElInput
            v-model="batchKeyword"
            clearable
            placeholder="搜索批次号、批次ID、时间、状态"
          />
          <span class="filter-count">共 {{ pagination.total }} 个批次</span>
        </template>
        <template v-else>
          <ElInput
            v-model="orderKeyword"
            clearable
            placeholder="搜索订单号、笔记ID、链接、状态"
          />
          <ElSelect v-model="orderStatusFilter" class="status-select">
            <ElOption label="全部" value="all" />
            <ElOption label="成功" value="success" />
            <ElOption label="失败" value="failed" />
            <ElOption label="进行中" value="running" />
          </ElSelect>
          <span class="filter-count">共 {{ filteredOrders.length }} 条记录</span>
        </template>
      </div>

      <div class="record-list">
      <template v-if="!selectedBatch">
        <article
          v-for="record in filteredRecords"
          :key="record.id"
          class="batch-row"
          :class="{
            refunded: hasRefundedOrder(record),
            refunding: hasRefundingOrder(record),
            'refund-rejected': hasRefundRejectedOrder(record),
          }"
          :style="{ '--progress': `${batchProgress(record)}%` }"
          @click="selectedBatchId = record.id"
        >
          <div>
            <div class="batch-title-line">
              <strong
                class="batch-no-link"
                title="查看这批次的消费记录"
                @click.stop="openConsumptionBatch(record)"
              >
                {{ record.batch_no }}
              </strong>
              <ElTag size="small" type="success" effect="plain" disable-transitions>{{ batchTargetTypeLabel(record) }}</ElTag>
              <ElTag size="small" effect="plain" disable-transitions>确认提交</ElTag>
            </div>
            <span class="batch-time">提交时间：{{ formatDateTime(record.submitted_at || record.created_at) }}</span>
          </div>
          <div class="batch-stat">
            <span>总数</span>
            <strong>{{ record.total_count }}</strong>
          </div>
          <div class="batch-stat">
            <span>成功</span>
            <strong>{{ record.succeeded_count }}</strong>
          </div>
          <div class="batch-stat">
            <span>失败</span>
            <strong>{{ record.failed_count }}</strong>
          </div>
          <div class="batch-money">
            <span>实际付款金额</span>
            <strong>{{ formatMoney(batchActualPaidAmount(record)) }}</strong>
          </div>
          <ElTag
            size="small"
            :type="hasRefundedOrder(record) || hasRefundingOrder(record) ? 'warning' : hasRefundRejectedOrder(record) ? 'danger' : 'success'"
            effect="plain"
            disable-transitions
          >
            {{ batchDisplayStatusLabel(record) }}
          </ElTag>
          <span class="row-arrow">›</span>
        </article>

      </template>

      <template v-else-if="selectedBatch">
        <div v-if="batchOrdersLoading" class="empty-state">加载订单中...</div>
        <template v-else>
        <div v-for="order in filteredOrders" :key="order.id">
          <article
            class="order-detail-row"
            :class="{
              refunded: isRefundedOrder(order),
              refunding: isRefundingOrder(order),
              'refund-rejected': isRefundRejectedOrder(order),
              expanded: expandedOrderIds.has(order.id),
            }"
            :style="{ '--progress': `${orderProgress(order)}%` }"
            @click="toggleOrderExpand(order.id)"
          >
            <div class="product-cell">
              <div class="product-thumb">
                <img v-if="order.avatar_url" :src="order.avatar_url" alt="" />
                <span v-else>{{ targetTypeLabel(order.target_type) }}</span>
              </div>
              <div class="product-text">
                <p>
                  <span>订单编号：{{ order.order_no }}</span>
                  <span>订单创建时间：{{ formatDateTime(order.created_at) }}</span>
                </p>
                <strong>{{ order.title || order.note_id || '未记录笔记ID' }}</strong>
                <span v-if="order.author_name" class="author-line">
                  {{ order.author_name }} / {{ order.note_id }}
                </span>
                <em>{{ order.source_note_url || order.note_url || '-' }}</em>
              </div>
            </div>
            <div class="tag-cell">
              <span class="tag-head">{{ targetTypeLabel(order.target_type) }}服务</span>
              <span>订单ID：{{ order.id }}</span>
              <span>批次：{{ selectedBatch.batch_no }}</span>
              <span>明细：#{{ order.batch_item_id }}</span>
            </div>
            <div class="num-cell">
              <span class="num-label">单价</span>
              <strong>{{ formatMoney(order.actual_paid_amount || order.payable_amount) }}</strong>
            </div>
            <div class="num-cell">
              <span class="num-label">数量</span>
              <strong>{{ order.ordered_quantity.toLocaleString('zh-CN') }}</strong>
              <span class="num-sub">{{ (order.completed_quantity || 0).toLocaleString('zh-CN') }} 已完成</span>
            </div>
            <div class="status-cell">
              <span class="status-text">{{ orderDisplayStatusLabel(order) }}</span>
              <small v-if="order.order_status === 'failed' && order.reason_message" class="fail-reason">
                失败原因：{{ order.reason_message }}
              </small>
              <small v-if="order.stop_response_message" class="stop-reason">
                停止原因：{{ order.stop_response_message }}
              </small>
            </div>
            <div class="num-cell">
              <span class="num-label">售后退款</span>
              <span class="refund-text" :class="{ 'has-refund': Number(order.refund_amount) > 0 }">{{ refundLabel(order) }}</span>
            </div>
            <div class="num-cell num-right">
              <span class="num-label">实际付款金额</span>
              <strong class="amount-text">{{ formatMoney(order.actual_paid_amount || order.payable_amount) }}</strong>
            </div>
            <span class="row-expand-arrow" :class="{ rotated: expandedOrderIds.has(order.id) }">▾</span>
          </article>
          <Transition @enter="expandEnter" @after-enter="expandAfterEnter" @leave="expandLeave" @after-leave="expandAfterLeave">
          <div v-if="expandedOrderIds.has(order.id)" class="expand-panel">
            <!-- 基本信息 -->
            <div class="exp-section">
              <div class="exp-section-title">基本信息</div>
              <div class="exp-grid">
                <div class="exp-cell">
                  <span class="exp-label">订单编号</span>
                  <span class="exp-value mono">{{ order.order_no }}<button class="copy-btn" title="复制" @click.stop="copyField(order.order_no)">复制</button></span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">订单ID</span>
                  <span class="exp-value mono">{{ order.id }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">服务类型</span>
                  <span class="exp-value">
                    <ElTag size="small" :type="order.target_type === 'view' ? 'primary' : order.target_type === 'like' ? 'danger' : 'warning'" disable-transitions>
                      {{ targetTypeLabel(order.target_type) }}
                    </ElTag>
                  </span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">订单状态</span>
                  <span class="exp-value">
                    <ElTag size="small" :type="order.order_status === 'completed' ? 'success' : order.order_status === 'failed' ? 'danger' : 'info'" disable-transitions>
                      {{ orderDisplayStatusLabel(order) }}
                    </ElTag>
                  </span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">创建时间</span>
                  <span class="exp-value">{{ formatDateTime(order.created_at) }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">更新时间</span>
                  <span class="exp-value">{{ formatDateTime(order.updated_at) }}</span>
                </div>
              </div>
            </div>

            <!-- 笔记信息 -->
            <div class="exp-section">
              <div class="exp-section-title">笔记信息</div>
              <div class="exp-grid">
                <div class="exp-cell">
                  <span class="exp-label">笔记标题</span>
                  <span class="exp-value">{{ order.title || '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">博主昵称</span>
                  <span class="exp-value">{{ order.author_name || '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">笔记ID</span>
                  <span class="exp-value mono">{{ order.note_id || '-' }}<button v-if="order.note_id" class="copy-btn" title="复制" @click.stop="copyField(order.note_id)">复制</button></span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">博主ID</span>
                  <span class="exp-value mono">{{ order.author_id || '-' }}<button v-if="order.author_id" class="copy-btn" title="复制" @click.stop="copyField(order.author_id)">复制</button></span>
                </div>
                <div class="exp-cell exp-wide">
                  <span class="exp-label">原始链接</span>
                  <span class="exp-value-row">
                    <a v-if="order.source_note_url" class="exp-link" :href="order.source_note_url" target="_blank" @click.stop>{{ order.source_note_url }}</a>
                    <span v-else>-</span>
                    <button v-if="order.source_note_url" class="copy-btn" title="复制" @click.stop="copyField(order.source_note_url)">复制</button>
                  </span>
                </div>
                <div class="exp-cell exp-wide">
                  <span class="exp-label">解析链接</span>
                  <a v-if="order.note_url" class="exp-link" :href="order.note_url" target="_blank" @click.stop>{{ order.note_url }}</a>
                  <span v-else class="exp-value">-</span>
                </div>
              </div>
            </div>

            <!-- 数量与金额 -->
            <div class="exp-section">
              <div class="exp-section-title">数量与金额</div>
              <div class="exp-stats">
                <div class="exp-stat-card">
                  <span class="exp-stat-label">下单数量</span>
                  <span class="exp-stat-num">{{ order.ordered_quantity.toLocaleString('zh-CN') }}</span>
                </div>
                <div class="exp-stat-card">
                  <span class="exp-stat-label">完成数量</span>
                  <span class="exp-stat-num" :class="{ 'text-success': (order.completed_quantity || 0) >= order.ordered_quantity }">{{ (order.completed_quantity || 0).toLocaleString('zh-CN') }}</span>
                </div>
                <div class="exp-stat-card">
                  <span class="exp-stat-label">应付金额</span>
                  <span class="exp-stat-num">{{ formatMoney(order.payable_amount) }}</span>
                </div>
                <div class="exp-stat-card">
                  <span class="exp-stat-label">实付金额</span>
                  <span class="exp-stat-num text-primary">{{ formatMoney(order.actual_paid_amount) }}</span>
                </div>
                <div class="exp-stat-card">
                  <span class="exp-stat-label">退款金额</span>
                  <span class="exp-stat-num" :class="{ 'text-warning': Number(order.refund_amount) > 0 }">{{ formatMoney(order.refund_amount) }}</span>
                </div>
                <div class="exp-stat-card">
                  <span class="exp-stat-label">售后退款</span>
                  <span class="exp-stat-num">{{ refundLabel(order) }}</span>
                </div>
              </div>
            </div>

            <!-- 外部任务 -->
            <div class="exp-section">
              <div class="exp-section-title">外部任务</div>
              <div class="exp-grid">
                <div class="exp-cell">
                  <span class="exp-label">外部任务ID</span>
                  <span class="exp-value mono">{{ order.external_task_id || '-' }}<button v-if="order.external_task_id" class="copy-btn" title="复制" @click.stop="copyField(order.external_task_id)">复制</button></span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">外部状态</span>
                  <span class="exp-value">{{ externalStatusLabel(order.external_status, order.order_status) }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">外部进度</span>
                  <span class="exp-value">
                    <template v-if="order.external_progress">
                      <span class="exp-progress-bar">
                        <span class="exp-progress-fill" :style="{ width: `${(order.external_progress * 100).toFixed(1)}%` }"></span>
                        <span class="exp-progress-text">{{ (order.external_progress * 100).toFixed(1) }}%</span>
                      </span>
                    </template>
                    <template v-else>-</template>
                  </span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">补单次数</span>
                  <span class="exp-value">{{ order.repair_count || 0 }}</span>
                </div>
              </div>
            </div>

            <!-- 数据快照 -->
            <div class="exp-section">
              <div class="exp-section-title">数据快照</div>
              <div class="exp-grid">
                <div class="exp-cell">
                  <span class="exp-label">阅读数快照</span>
                  <span class="exp-value">{{ order.snapshot_current_read_count ?? '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">验收阅读数</span>
                  <span class="exp-value">{{ order.snapshot_verified_read_count ?? '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">验收点赞数</span>
                  <span class="exp-value">{{ order.snapshot_verified_like_count ?? '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">点赞数</span>
                  <span class="exp-value">{{ order.like_count ?? '-' }}</span>
                </div>
              </div>
            </div>

            <!-- 备注信息 -->
            <div v-if="order.reason_message || order.stop_response_message" class="exp-section">
              <div class="exp-section-title">备注信息</div>
              <div class="exp-notes">
                <div v-if="order.reason_message" class="exp-note-item">
                  <span class="exp-label">备注/原因</span>
                  <span class="exp-value">{{ order.reason_message }}</span>
                </div>
                <div v-if="order.stop_response_message" class="exp-note-item">
                  <span class="exp-label">停止原因</span>
                  <span class="exp-value">{{ order.stop_response_message }}</span>
                </div>
              </div>
            </div>

          </div>
          </Transition>
        </div>
        </template>
      </template>

      <div
        v-if="!loading && !selectedBatch && filteredRecords.length === 0"
        class="empty-state"
      >
        暂无匹配的批次记录
      </div>
      <div
        v-if="!loading && selectedBatch && filteredOrders.length === 0"
        class="empty-state"
      >
        暂无匹配的订单明细
      </div>
      </div>
      <div v-if="!selectedBatch" class="pagination-bar">
        <ElPagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.page_size"
          :page-sizes="[10, 20, 50, 100]"
          :total="pagination.total"
          background
          layout="sizes, prev, pager, next, jumper"
          @current-change="handleBatchPageChange"
          @size-change="handleBatchPageSizeChange"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.order-record-page {
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

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

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

.stat-card--primary .stat-icon { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.stat-card--success .stat-icon { background: var(--el-color-success-light-8); color: var(--el-color-success); }
.stat-card--warning .stat-icon { background: var(--el-color-warning-light-8); color: var(--el-color-warning); }
.stat-card--danger .stat-icon { background: var(--el-color-danger-light-8); color: var(--el-color-danger); }

.stat-body { display: flex; flex-direction: column; gap: 4px; }
.stat-body span { font-size: 12px; color: var(--el-text-color-secondary); }
.stat-body strong { font-size: 22px; font-weight: 700; line-height: 1.1; }

.stat-card--danger .stat-body strong { color: var(--el-color-danger); }

/* ---- common card base ---- */
.detail-head,
.order-detail-row,
.empty-state {
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.batch-row span,
.tag-cell,
.product-cell p,
.product-cell em {
  margin: 0;
  color: var(--el-text-color-secondary);
}

/* ---- record panel ---- */
.record-panel {
  padding: 18px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.filter-bar > .el-input { width: 280px; flex-shrink: 0; }

.filter-count {
  margin-left: auto;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.status-select {
  width: 120px;
}

.record-list {
  display: grid;
  gap: 10px;
}

.batch-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(220px, 1.5fr) repeat(3, minmax(80px, 0.5fr)) minmax(150px, 0.8fr) 110px 28px;
  gap: 14px;
  align-items: center;
  overflow: hidden;
  padding: 16px 18px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.batch-row::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--progress);
  background: color-mix(in srgb, var(--el-color-success) 8%, transparent);
  content: '';
  pointer-events: none;
  transition: width 1.15s cubic-bezier(0.22, 1, 0.36, 1);
}

.batch-row:hover {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.04);
}

.batch-row.refunded,
.batch-row.refunding {
  border-color: var(--el-color-warning-light-5);
  background: color-mix(in srgb, var(--el-color-warning) 6%, var(--el-bg-color));
}

.batch-row.refund-rejected {
  border-color: var(--el-color-danger-light-5);
  background: color-mix(in srgb, var(--el-color-danger) 4%, var(--el-bg-color));
}

.batch-row.refunded::before,
.batch-row.refunding::before {
  background: color-mix(in srgb, var(--el-color-warning) 12%, transparent);
}

.batch-row.refund-rejected::before {
  background: color-mix(in srgb, var(--el-color-danger) 8%, transparent);
}

.batch-row > * {
  position: relative;
  z-index: 1;
}

.batch-no-link {
  cursor: pointer;
  font-family: Consolas, 'SF Mono', monospace;
  font-size: 13px;
}

.batch-no-link:hover {
  color: var(--el-color-primary);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.batch-row > div > strong,
.batch-row > .row-arrow,
.batch-row .batch-stat span,
.batch-row .batch-stat strong,
.batch-row .batch-money span,
.batch-row .batch-money strong,
.batch-row .batch-time {
  display: block;
}

.batch-time {
  font-size: 12px;
}

.batch-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.batch-stat,
.batch-money {
  display: grid;
  gap: 4px;
}

.batch-stat strong {
  font-family: Consolas, 'SF Mono', monospace;
  font-weight: 600;
}

.batch-money strong {
  font-size: 18px;
  font-family: Consolas, 'SF Mono', monospace;
  font-weight: 700;
}

.order-detail-row {
  display: grid;
  grid-template-columns: minmax(320px, 2fr) minmax(160px, 1fr) 90px 90px 90px 90px 120px 28px;
  gap: 14px;
  align-items: center;
  position: relative;
  overflow: hidden;
  padding: 16px 18px;
  transition:
    background-color 0.35s ease,
    border-color 0.35s ease;
}

.order-detail-row::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--progress, 0%);
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  content: '';
  pointer-events: none;
  transition:
    width 1.15s cubic-bezier(0.22, 1, 0.36, 1),
    background 0.35s ease;
}

@media (prefers-reduced-motion: reduce) {
  .batch-row::before,
  .order-detail-row::before {
    transition: none;
  }
}

.order-detail-row.refunded,
.order-detail-row.refunding {
  border-color: var(--el-color-warning-light-5);
  background: color-mix(in srgb, var(--el-color-warning) 9%, var(--el-bg-color));
}

.order-detail-row.refund-rejected {
  border-color: var(--el-color-danger-light-5);
  background: color-mix(in srgb, var(--el-color-danger) 6%, var(--el-bg-color));
}

.order-detail-row.refunded::before,
.order-detail-row.refunding::before {
  background: color-mix(in srgb, var(--el-color-warning) 14%, transparent);
}

.order-detail-row.refund-rejected::before {
  background: color-mix(in srgb, var(--el-color-danger) 10%, transparent);
}

.order-detail-row > * {
  position: relative;
  z-index: 1;
}

.product-cell {
  display: flex;
  gap: 14px;
  align-items: center;
  min-width: 0;
}

.product-thumb {
  display: grid;
  place-items: center;
  overflow: hidden;
  width: 80px;
  height: 80px;
  border-radius: 8px;
  flex-shrink: 0;
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
  font-weight: 700;
  font-size: 20px;
}

.product-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.product-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.product-text p {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.product-text > strong {
  display: block;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.author-line {
  display: block;
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-text em {
  display: block;
  overflow: hidden;
  font-style: normal;
  font-size: 12px;
  font-family: Consolas, 'SF Mono', monospace;
  color: var(--el-color-primary-light-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}

.tag-cell span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-head {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.num-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.num-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.num-cell > strong {
  font-size: 15px;
  font-weight: 700;
  font-family: Consolas, 'SF Mono', monospace;
  white-space: nowrap;
}

.num-sub {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.num-right {
  text-align: right;
}

.amount-text {
  color: var(--el-color-primary);
}

.status-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.status-text {
  font-size: 13px;
  font-weight: 500;
}

.status-cell .fail-reason {
  overflow: hidden;
  color: var(--el-color-danger);
  font-size: 11px;
  line-height: 1.3;
  text-overflow: ellipsis;
}

.status-cell .stop-reason {
  overflow: hidden;
  color: var(--el-color-warning);
  font-size: 11px;
  line-height: 1.3;
  text-overflow: ellipsis;
}

.refund-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.refund-text.has-refund {
  color: var(--el-color-warning);
  font-weight: 600;
}

.order-detail-row {
  cursor: pointer;
}

.order-detail-row.expanded {
  border-color: var(--el-color-primary-light-5);
}

.row-arrow {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-placeholder);
  font-size: 22px;
  font-weight: 300;
  line-height: 1;
  transition: color 0.2s;
}

.batch-row:hover .row-arrow {
  color: var(--el-color-primary);
}

.row-expand-arrow {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-placeholder);
  font-size: 18px;
  line-height: 1;
  transition:
    transform 0.25s ease,
    color 0.2s;
}

.row-expand-arrow.rotated {
  transform: rotate(180deg);
  color: var(--el-color-primary);
}

.order-detail-row:hover .row-expand-arrow {
  color: var(--el-color-primary);
}

.expand-panel {
  padding: 0 20px 16px;
  border: 1px solid var(--el-border-color-light);
  border-top: none;
  border-radius: 0 0 12px 12px;
  background: var(--el-fill-color-blank);
  margin-top: -8px;
  margin-bottom: 4px;
}

.exp-section {
  padding-top: 16px;
}

.exp-section + .exp-section {
  border-top: 1px dashed var(--el-border-color-lighter);
  margin-top: 14px;
}

.exp-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 10px;
  padding-left: 8px;
  border-left: 3px solid var(--el-color-primary);
  line-height: 1;
}

.exp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px 20px;
}

.exp-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}

.exp-wide {
  grid-column: 1 / -1;
}

.exp-label {
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1.2;
}

.exp-value {
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  word-break: break-all;
  line-height: 1.4;
}

.exp-value.mono {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
  letter-spacing: -0.2px;
}

.copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 6px;
  padding: 1px 4px;
  font-size: 12px;
  line-height: 1;
  background: transparent;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  vertical-align: middle;
  transition: all 0.2s;
}

.copy-btn:hover {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}

.exp-value-row {
  display: flex;
  align-items: center;
  gap: 0;
}

.exp-link {
  font-size: 12px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  color: var(--el-color-primary);
  word-break: break-all;
  line-height: 1.4;
  text-decoration: none;
}

.exp-link:hover {
  text-decoration: underline;
}

.exp-stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 10px;
}

.exp-stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 8px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}

.exp-stat-label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.exp-stat-num {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.exp-stat-num.text-primary {
  color: var(--el-color-primary);
}

.exp-stat-num.text-success {
  color: var(--el-color-success);
}

.exp-stat-num.text-warning {
  color: var(--el-color-warning);
}

.exp-notes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.exp-note-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}

.exp-progress-bar {
  display: inline-flex;
  align-items: center;
  position: relative;
  width: 140px;
  height: 16px;
  background: var(--el-border-color-lighter);
  border-radius: 8px;
  overflow: hidden;
}

.exp-progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  background: var(--el-color-primary);
  border-radius: 8px;
  transition: width 0.3s;
}

.exp-progress-text {
  position: relative;
  z-index: 1;
  width: 100%;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.3);
}

.expand-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 14px;
  border-top: 1px dashed var(--el-border-color-lighter);
  margin-top: 14px;
}

.empty-state {
  padding: 56px 16px;
  border: none;
  background: none;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}

@media (max-width: 1200px) {
  .batch-row,
  .order-detail-row {
    grid-template-columns: 1fr;
  }

  .row-arrow,
  .row-expand-arrow {
    display: none;
  }

  .num-right {
    text-align: left;
  }
}

@media (max-width: 900px) {
  .order-record-page { padding: 12px; }

  .page-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .status-select {
    width: 100%;
  }

  .product-cell {
    flex-direction: column;
    align-items: flex-start;
  }

  .product-thumb {
    width: 60px;
    height: 60px;
  }
}
</style>


